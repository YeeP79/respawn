import type { ActionResult, DiscoveredService, Environment } from '../../config/types.js';
import {
  findUnsatisfiedRequirements,
  formatRequirementError,
} from '../../config/preflight.js';
import { runCdk } from '../../utils/cdk-runner.js';
import { logger } from '../../utils/logger.js';
import { secretExists } from '../../utils/secrets-runner.js';
import { buildAndPush, resolveImage } from './push.js';
import { checkUpdates, recordUpdateState } from './updates.js';

export interface DeployContext {
  service: DiscoveredService;
  environment: Environment;
  workspaceRoot: string;
  verbose?: boolean;
  requireApproval?: 'never' | 'any-change' | 'broadening';
  profile?: string;
  force?: boolean;
  /** Deploy-time prompt answers — container env var → value (overrides .env). */
  gameEnvOverrides?: Record<string, string>;
  /** Rebuild and push even when the content tag is already in ECR. */
  forceBuild?: boolean;
  /** Refuse to build: the image must already be in ECR (CI/CD). */
  requireImage?: boolean;
}

/**
 * Refuses a deploy that would fail late or, worse, succeed into a broken server.
 *
 * Two classes of problem, both invisible to CDK: a REQUIRED_ENV_VARS entry with
 * no real value (the task starts, the server silently misbehaves), and a
 * SECRET_REFS entry naming a secret that does not exist (the task dies with
 * ResourceInitializationError after a full deploy).
 *
 * @throws When any requirement is unsatisfied or any referenced secret is absent.
 */
async function preflight(ctx: DeployContext): Promise<void> {
  const { config } = ctx.service;
  const problems: string[] = [];

  const missing = findUnsatisfiedRequirements(config, ctx.gameEnvOverrides);
  if (missing.length > 0) {
    problems.push(formatRequirementError(config, missing));
  }

  const region = config.aws.region;
  const profile = ctx.profile ?? config.aws.profile;
  const absent = (
    await Promise.all(
      config.secretRefs.map(async (ref) => ({
        ref,
        exists: await secretExists({
          store: ref.store,
          sourceId: ref.sourceId,
          region,
          profile,
        }),
      })),
    )
  ).filter((r) => !r.exists);

  if (absent.length > 0) {
    problems.push(
      [
        `${config.serviceName} references secrets that do not exist in ${region}:`,
        ...absent.map(
          ({ ref }) =>
            `  - ${ref.containerEnvVar} -> ${ref.store}:${ref.sourceId}`,
        ),
        '',
        'ECS resolves secrets before the container starts, so the task would fail',
        'with ResourceInitializationError. Store the values first:',
        '  pnpm respawn  ->  Secrets',
      ].join('\n'),
    );
  }

  if (problems.length > 0) {
    throw new Error(`Preflight failed.\n\n${problems.join('\n\n')}`);
  }

  logger.debug(`Preflight passed for ${config.serviceName}`);
}

/**
 * Records what this deploy actually shipped, so `updates` has a baseline to
 * compare against. Best-effort: a failure here must not fail a deploy that
 * already succeeded, so it warns instead of throwing.
 */
async function recordDeployedState(ctx: DeployContext): Promise<void> {
  if (ctx.service.config.updateChecks.length === 0) return;
  try {
    const results = await checkUpdates(ctx);
    await recordUpdateState(ctx, results);
    logger.debug(`Recorded update baseline for ${ctx.service.name}`);
  } catch (err) {
    logger.warn(
      `Deployed, but could not record the update baseline for ${ctx.service.name}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function deploy(ctx: DeployContext): Promise<ActionResult> {
  const start = Date.now();
  const { service, environment, workspaceRoot } = ctx;
  const { config } = service;

  // Deploy-time prompt answers travel to the CDK app via context (the app runs
  // in a separate process and re-loads config, so in-memory edits wouldn't reach it).
  const overrideCtx: Record<string, string> =
    ctx.gameEnvOverrides && Object.keys(ctx.gameEnvOverrides).length > 0
      ? { gameEnvOverrides: JSON.stringify(ctx.gameEnvOverrides) }
      : {};

  try {
    // Fail before building images or touching CloudFormation.
    await preflight(ctx);

    // When IMAGE_URI is set, skip the build/push flow and deploy directly
    if (config.image.imageUri) {
      logger.info(`Using external image: ${config.image.imageUri}`);
      logger.info('Deploying infrastructure via CDK...');
      const cdkResult = await runCdk({
        command: 'deploy',
        stacks: [`RespawnShared-${environment}`, `Respawn-${environment}-${service.name}`],
        context: {
          environment,
          services: service.name,
          imageTag: config.image.imageUri,
          workspaceRoot,
          ...overrideCtx,
        },
        workspaceRoot,
        requireApproval: ctx.requireApproval,
        profile: ctx.profile,
        verbose: ctx.verbose,
        force: ctx.force,
      });

      if (cdkResult.exitCode !== 0) {
        throw new Error('CDK deploy failed');
      }

      await recordDeployedState(ctx);

      return {
        success: true,
        serviceName: service.name,
        action: 'deploy',
        message: `Successfully deployed ${service.name} to ${environment} using ${config.image.imageUri}`,
        duration: Date.now() - start,
        outputs: { imageUri: config.image.imageUri },
      };
    }

    // Content-addressed tag: skips the build entirely when this exact Dockerfile,
    // shim and base image are already in ECR. `buildAndPush` deploys the shared
    // stack first, because it owns the ECR repository being pushed to.
    const resolved = await resolveImage(ctx);
    if (resolved.alreadyPushed && ctx.requireImage) {
      logger.info(`Reusing ${resolved.repository}:${resolved.tag} from ECR.`);
    } else if (!resolved.alreadyPushed && ctx.requireImage) {
      throw new Error(
        `--require-image was set but ${resolved.repository}:${resolved.tag} is not in ECR.\n` +
          `Build and push it first:  pnpm respawn:push --service=${service.name}`,
      );
    }
    await buildAndPush({ ...ctx, forceBuild: ctx.forceBuild }, resolved);
    const imageTag = resolved.tag;

    // CDK deploy — the shared stack is already up (see buildAndPush).
    logger.info('Deploying infrastructure via CDK...');
    const cdkResult = await runCdk({
      command: 'deploy',
      stacks: [`Respawn-${environment}-${service.name}`],
      context: {
        environment,
        services: service.name,
        imageTag,
        workspaceRoot,
        ...overrideCtx,
      },
      workspaceRoot,
      requireApproval: ctx.requireApproval,
      profile: ctx.profile,
      verbose: ctx.verbose,
      force: ctx.force,
    });

    if (cdkResult.exitCode !== 0) {
      throw new Error('CDK deploy failed');
    }

    await recordDeployedState(ctx);

    return {
      success: true,
      serviceName: service.name,
      action: 'deploy',
      message: `Successfully deployed ${service.name} to ${environment}`,
      duration: Date.now() - start,
      outputs: {
        imageTag,
        registry: `${resolved.registry}/${resolved.repository}`,
      },
    };
  } catch (err) {
    return {
      success: false,
      serviceName: service.name,
      action: 'deploy',
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}
