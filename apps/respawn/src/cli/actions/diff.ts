import type { ActionResult, DiscoveredService, Environment } from '@respawn/core';
import { runCdk } from '@respawn/core';
import { logger } from '@respawn/core';

export interface DiffContext {
  service: DiscoveredService;
  environment: Environment;
  workspaceRoot: string;
  verbose?: boolean;
  profile?: string;
}

export async function diff(ctx: DiffContext): Promise<ActionResult> {
  const start = Date.now();
  const { service, environment, workspaceRoot } = ctx;

  try {
    logger.info(`Diffing ${service.name} in ${environment}...`);

    const cdkResult = await runCdk({
      command: 'diff',
      stacks: [`RespawnShared-${environment}`, `Respawn-${environment}-${service.name}`],
      context: {
        environment,
        services: service.name,
        workspaceRoot,
      },
      workspaceRoot,
      profile: ctx.profile,
      verbose: ctx.verbose,
    });

    // CDK diff returns exit code 1 when there are differences (not an error)
    if (cdkResult.exitCode > 1) {
      throw new Error('CDK diff failed');
    }

    return {
      success: true,
      serviceName: service.name,
      action: 'diff',
      message:
        cdkResult.exitCode === 0
          ? `No changes for ${service.name} in ${environment}`
          : `Changes detected for ${service.name} in ${environment}`,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      serviceName: service.name,
      action: 'diff',
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}
