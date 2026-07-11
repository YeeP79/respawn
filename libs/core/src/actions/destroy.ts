import type { ActionResult, DiscoveredService, Environment } from '../config/types.js';
import { runCdk } from '../utils/cdk-runner.js';
import { logger } from '../utils/logger.js';
import { serviceStackId, sharedStackId } from '../naming.js';

export interface DestroyContext {
  service: DiscoveredService;
  environment: Environment;
  workspaceRoot: string;
  verbose?: boolean;
  profile?: string;
  /** Must be true to tear down a production service — the core never prompts. */
  force?: boolean;
}

/**
 * Tears down a service's stacks. This is the headless core: it never prompts, so a
 * production destroy must be pre-confirmed by the caller (which sets `force`). A UI
 * front-end does the confirmation, then calls this; the MCP would require an explicit
 * confirm argument. `force` is separate from CDK's own `--force` (always passed —
 * `cdk destroy` needs it to skip its y/n).
 */
export async function destroy(ctx: DestroyContext): Promise<ActionResult> {
  const start = Date.now();
  const { service, environment, workspaceRoot } = ctx;

  try {
    if (environment === 'prod' && !ctx.force) {
      return {
        success: false,
        serviceName: service.name,
        action: 'destroy',
        message:
          'Refusing to destroy a production service without confirmation (set force after confirming).',
        duration: Date.now() - start,
      };
    }

    logger.info(`Destroying ${service.name} in ${environment}...`);

    const cdkResult = await runCdk({
      command: 'destroy',
      stacks: [serviceStackId(environment, service.name), sharedStackId(environment)],
      context: { environment, services: service.name, workspaceRoot },
      workspaceRoot,
      profile: ctx.profile,
      verbose: ctx.verbose,
      force: true, // CDK destroy always needs --force to skip its y/n prompt
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
