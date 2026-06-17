import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { buildImage, tagImage, ecrLogin, pushImage } from '@respawn/docker-utils';
import type { ActionResult, DiscoveredService, Environment } from '../../config/types.js';
import { runCdk } from '../../utils/cdk-runner.js';
import { logger } from '../../utils/logger.js';

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
}

function getGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
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

      return {
        success: true,
        serviceName: service.name,
        action: 'deploy',
        message: `Successfully deployed ${service.name} to ${environment} using ${config.image.imageUri}`,
        duration: Date.now() - start,
        outputs: { imageUri: config.image.imageUri },
      };
    }

    const gitSha = getGitSha();
    const imageTag = `${environment}-${gitSha}`;
    const latestTag = `${environment}-latest`;

    // Determine registry
    const region = config.aws.region;
    const accountId = config.aws.accountId || process.env['CDK_DEFAULT_ACCOUNT'];
    if (!accountId) {
      throw new Error(
        'AWS account ID not configured. Set AWS_ACCOUNT_ID in .env or ensure AWS CLI is configured.',
      );
    }
    const registry = `${accountId}.dkr.ecr.${region}.amazonaws.com`;
    const repository = `respawn/${service.name}`;

    // Build the game server image
    logger.info(`Building image for ${service.name}...`);
    const dockerfilePath = path.resolve(
      service.path,
      config.image.dockerfilePath,
    );
    await buildImage({
      context: workspaceRoot,
      dockerfile: dockerfilePath,
      tag: `${repository}:${imageTag}`,
    });

    // Tag with latest
    await tagImage(
      `${repository}:${imageTag}`,
      `${registry}/${repository}:${imageTag}`,
    );
    await tagImage(
      `${repository}:${imageTag}`,
      `${registry}/${repository}:${latestTag}`,
    );

    // ECR login and push
    logger.info('Logging in to ECR...');
    await ecrLogin(registry, region);

    logger.info('Pushing image to ECR...');
    await pushImage({ registry, repository, tag: imageTag, region });
    await pushImage({ registry, repository, tag: latestTag, region });

    // CDK deploy
    logger.info('Deploying infrastructure via CDK...');
    const cdkResult = await runCdk({
      command: 'deploy',
      stacks: [`RespawnShared-${environment}`, `Respawn-${environment}-${service.name}`],
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

    return {
      success: true,
      serviceName: service.name,
      action: 'deploy',
      message: `Successfully deployed ${service.name} to ${environment}`,
      duration: Date.now() - start,
      outputs: { imageTag, registry: `${registry}/${repository}` },
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
