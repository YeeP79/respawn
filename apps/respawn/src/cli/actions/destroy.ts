import * as p from '@clack/prompts';
import type { ActionResult, DiscoveredService, Environment } from '../../config/types.js';
import { runCdk } from '../../utils/cdk-runner.js';
import { logger } from '../../utils/logger.js';

export interface DestroyContext {
  service: DiscoveredService;
  environment: Environment;
  workspaceRoot: string;
  verbose?: boolean;
  profile?: string;
  force?: boolean;
}

export async function destroy(ctx: DestroyContext): Promise<ActionResult> {
  const start = Date.now();
  const { service, environment, workspaceRoot } = ctx;

  try {
    // Extra confirmation for production
    if (environment === 'prod' && !ctx.force) {
      const confirmation = await p.text({
        message: `Type "${service.name}" to confirm PRODUCTION destroy:`,
        validate: (value) => {
          if (value !== service.name) {
            return `You must type "${service.name}" to confirm.`;
          }
          return undefined;
        },
      });

      if (p.isCancel(confirmation)) {
        return {
          success: false,
          serviceName: service.name,
          action: 'destroy',
          message: 'Cancelled by user',
          duration: Date.now() - start,
        };
      }
    }

    logger.info(`Destroying ${service.name} in ${environment}...`);

    const cdkResult = await runCdk({
      command: 'destroy',
      stacks: [`Respawn-${environment}-${service.name}`, `RespawnShared-${environment}`],
      context: {
        environment,
        services: service.name,
        workspaceRoot,
      },
      workspaceRoot,
      profile: ctx.profile,
      verbose: ctx.verbose,
      force: true, // CDK destroy always needs --force to skip y/n prompt
    });

    if (cdkResult.exitCode !== 0) {
      throw new Error('CDK destroy failed');
    }

    return {
      success: true,
      serviceName: service.name,
      action: 'destroy',
      message: `Successfully destroyed ${service.name} in ${environment}`,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      serviceName: service.name,
      action: 'destroy',
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}
