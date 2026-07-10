import * as path from 'node:path';
import {
  buildImage,
  tagImage,
  ecrLogin,
  pushImage,
  imageTagExists,
  resolveBaseImageDigest,
} from '@respawn/docker-utils';
import type {
  ActionResult,
  DiscoveredService,
  Environment,
} from '@respawn/core';
import {
  collectImageInputs,
  computeImageTag,
  parseBaseImage,
} from '@respawn/core';
import { runCdk } from '@respawn/core';
import { logger } from '@respawn/core';
import * as fs from 'node:fs';

export interface PushContext {
  service: DiscoveredService;
  environment: Environment;
  workspaceRoot: string;
  verbose?: boolean;
  profile?: string;
  force?: boolean;
  requireApproval?: 'never' | 'any-change' | 'broadening';
  /** Rebuild and push even when the content tag is already in ECR. */
  forceBuild?: boolean;
}

export interface ResolvedImage {
  /** Content-addressed tag, e.g. `sha-3f2a91c4be07`. */
  tag: string;
  /** Moving pointer, e.g. `dev-latest`. */
  latestTag: string;
  repository: string;
  registry: string;
  /** True when `tag` was already present in ECR. */
  alreadyPushed: boolean;
}

/**
 * Computes the content-addressed tag for a service's image and reports whether
 * ECR already holds it.
 *
 * @throws When the account id cannot be determined, or the base image digest
 *   cannot be resolved.
 */
export async function resolveImage(
  ctx: Pick<PushContext, 'service' | 'workspaceRoot' | 'environment' | 'profile'>,
): Promise<ResolvedImage> {
  const { config } = ctx.service;
  const region = config.aws.region;
  const accountId = config.aws.accountId || process.env['CDK_DEFAULT_ACCOUNT'];
  if (!accountId) {
    throw new Error(
      'AWS account ID not configured. Set AWS_ACCOUNT_ID in .env or ensure AWS CLI is configured.',
    );
  }

  const dockerfilePath = path.resolve(
    ctx.service.path,
    config.image.dockerfilePath,
  );
  const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
  const baseRef = parseBaseImage(dockerfile);

  logger.debug(`Resolving base image digest for ${baseRef}...`);
  const baseDigest = await resolveBaseImageDigest(baseRef);

  const inputs = collectImageInputs(
    dockerfilePath,
    ctx.workspaceRoot,
    baseDigest,
  );
  const tag = computeImageTag(inputs);
  const repository = `respawn/${ctx.service.name}`;

  const alreadyPushed = await imageTagExists({
    repository,
    tag,
    region,
    profile: ctx.profile ?? config.aws.profile,
  });

  return {
    tag,
    latestTag: `${ctx.environment}-latest`,
    repository,
    registry: `${accountId}.dkr.ecr.${region}.amazonaws.com`,
    alreadyPushed,
  };
}

/**
 * Builds and pushes a service's image to ECR, skipping the work when the exact
 * content is already there.
 *
 * The shared stack owns the ECR repository, so it is deployed first — on a first
 * push the repository does not exist yet and `docker push` would fail.
 *
 * @returns The resolved image, so callers can pin the tag when deploying.
 */
export async function buildAndPush(
  ctx: PushContext,
  resolved: ResolvedImage,
): Promise<ResolvedImage> {
  const { config } = ctx.service;
  const region = config.aws.region;

  if (resolved.alreadyPushed && !ctx.forceBuild) {
    logger.info(
      `Image ${resolved.repository}:${resolved.tag} is already in ECR — skipping build.`,
    );
    return resolved;
  }

  logger.info('Deploying shared infrastructure (VPC, ECR)...');
  const shared = await runCdk({
    command: 'deploy',
    stacks: [`RespawnShared-${ctx.environment}`],
    context: {
      environment: ctx.environment,
      services: ctx.service.name,
      workspaceRoot: ctx.workspaceRoot,
    },
    workspaceRoot: ctx.workspaceRoot,
    requireApproval: ctx.requireApproval,
    profile: ctx.profile,
    verbose: ctx.verbose,
    force: ctx.force,
  });
  if (shared.exitCode !== 0) {
    throw new Error('CDK deploy of shared stack failed');
  }

  const dockerfilePath = path.resolve(
    ctx.service.path,
    config.image.dockerfilePath,
  );

  logger.info(`Building ${resolved.repository}:${resolved.tag}...`);
  await buildImage({
    context: ctx.workspaceRoot,
    dockerfile: dockerfilePath,
    tag: `${resolved.repository}:${resolved.tag}`,
  });

  for (const t of [resolved.tag, resolved.latestTag]) {
    await tagImage(
      `${resolved.repository}:${resolved.tag}`,
      `${resolved.registry}/${resolved.repository}:${t}`,
    );
  }

  logger.info('Logging in to ECR...');
  await ecrLogin(resolved.registry, region);

  logger.info('Pushing image to ECR...');
  await pushImage({
    registry: resolved.registry,
    repository: resolved.repository,
    tag: resolved.tag,
    region,
  });
  await pushImage({
    registry: resolved.registry,
    repository: resolved.repository,
    tag: resolved.latestTag,
    region,
  });

  return { ...resolved, alreadyPushed: true };
}

/**
 * Standalone `push` action: build and push a service's image without deploying
 * any game-server infrastructure.
 */
export async function push(ctx: PushContext): Promise<ActionResult> {
  const start = Date.now();
  const { service } = ctx;

  try {
    if (service.config.image.imageUri) {
      return {
        success: true,
        serviceName: service.name,
        action: 'push',
        message: `${service.name} uses IMAGE_URI (${service.config.image.imageUri}); nothing to build.`,
        duration: Date.now() - start,
      };
    }

    const resolved = await resolveImage(ctx);
    const skipped = resolved.alreadyPushed && !ctx.forceBuild;
    await buildAndPush(ctx, resolved);

    return {
      success: true,
      serviceName: service.name,
      action: 'push',
      message: skipped
        ? `${service.name}: ${resolved.tag} already in ECR (no rebuild).`
        : `${service.name}: pushed ${resolved.repository}:${resolved.tag}`,
      duration: Date.now() - start,
      outputs: { imageTag: resolved.tag },
    };
  } catch (err) {
    return {
      success: false,
      serviceName: service.name,
      action: 'push',
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}
