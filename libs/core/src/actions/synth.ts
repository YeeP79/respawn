import type { ActionResult, DiscoveredService, Environment } from '../config/types.js';
import { runCdk } from '../utils/cdk-runner.js';
import { logger } from '../utils/logger.js';
import { serviceStackId, sharedStackId } from '../naming.js';

export interface SynthContext {
  service: DiscoveredService;
  environment: Environment;
  workspaceRoot: string;
  verbose?: boolean;
  profile?: string;
}

export async function synth(ctx: SynthContext): Promise<ActionResult> {
  const start = Date.now();
  const { service, environment, workspaceRoot } = ctx;

  try {
    logger.info(`Synthesizing CloudFormation for ${service.name}...`);

    const cdkResult = await runCdk({
      command: 'synth',
      stacks: [sharedStackId(environment), serviceStackId(environment, service.name)],
      context: {
        environment,
        services: service.name,
        workspaceRoot,
      },
      workspaceRoot,
      profile: ctx.profile,
      verbose: ctx.verbose,
    });

    if (cdkResult.exitCode !== 0) {
      throw new Error('CDK synth failed');
    }

    return {
      success: true,
      serviceName: service.name,
      action: 'synth',
      message: `Successfully synthesized ${service.name} for ${environment}`,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      serviceName: service.name,
      action: 'synth',
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}
