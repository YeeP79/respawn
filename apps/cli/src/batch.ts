import type { Action, ActionResult, Environment } from '@respawn/core';
import { discoverServices, logger } from '@respawn/core';
import { ACTION_HANDLERS } from './handlers.js';

export interface BatchOptions {
  action: Action;
  environment: Environment;
  /** Comma-separated service list. */
  service: string;
  workspaceRoot: string;
  verbose?: boolean;
  force?: boolean;
  forceBuild?: boolean;
  requireImage?: boolean;
  record?: boolean;
  /** Turn a `deploy` into a `synth` (preview only). */
  dryRun?: boolean;
  requireApproval?: 'never' | 'any-change' | 'broadening';
  profile?: string;
  /** ECS desiredCount — required when action is `scale`. */
  desiredCount?: number;
  /** Deploy-time env overrides (deploy-prompt answers), applied to every service. */
  gameEnvOverrides?: Record<string, string>;
}

/**
 * Runs one action across a comma-separated service list, non-interactively. Returns the
 * process exit code (1 if any service failed or a name was unknown). Discovery is the
 * source of truth for service names, so an unknown name fails fast.
 */
export async function runBatch(options: BatchOptions): Promise<number> {
  if (options.action === 'scale' && options.desiredCount === undefined) {
    logger.error('The scale action requires --count <n> (0 to sleep, 1 to wake).');
    return 1;
  }

  const serviceNames = options.service
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allDiscovered = discoverServices(options.workspaceRoot, options.environment);
  const results: ActionResult[] = [];

  for (const name of serviceNames) {
    const discovered = allDiscovered.find((s) => s.name === name);
    if (!discovered) {
      logger.error(
        `Service "${name}" not found. Available: ${allDiscovered.map((s) => s.name).join(', ') || '(none)'}`,
      );
      return 1;
    }

    // --dry-run previews a deploy as a synth; every other action is unchanged.
    const action: Action =
      options.dryRun && options.action === 'deploy' ? 'synth' : options.action;

    const result = await ACTION_HANDLERS[action]({
      service: discovered,
      environment: options.environment,
      workspaceRoot: options.workspaceRoot,
      verbose: options.verbose,
      profile: options.profile,
      force: options.force,
      forceBuild: options.forceBuild,
      requireImage: options.requireImage,
      record: options.record,
      requireApproval: options.requireApproval ?? 'never',
      ...(options.desiredCount !== undefined ? { desiredCount: options.desiredCount } : {}),
      ...(options.gameEnvOverrides ? { gameEnvOverrides: options.gameEnvOverrides } : {}),
    });

    results.push(result);
    if (result.success) logger.info(`${name}: ${result.message}`);
    else logger.error(`${name}: ${result.message}`);
  }

  return results.some((r) => !r.success) ? 1 : 0;
}
