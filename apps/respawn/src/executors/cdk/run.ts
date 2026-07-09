/**
 * Executor entrypoint — run by tsx from the CJS executor wrapper.
 * This file runs in full ESM context with access to the entire codebase.
 */
import type { Action, Environment, ActionResult } from '../../config/types.js';
import { discoverServices } from '../../utils/stack-discovery.js';
import { setVerbose, logger } from '../../utils/logger.js';
import { deploy } from '../../cli/actions/deploy.js';
import { destroy } from '../../cli/actions/destroy.js';
import { synth } from '../../cli/actions/synth.js';
import { diff } from '../../cli/actions/diff.js';
import { status } from '../../cli/actions/status.js';
import { push } from '../../cli/actions/push.js';
import { updates } from '../../cli/actions/updates.js';
import { runCli } from '../../cli/index.js';


const ACTION_HANDLERS: Record<
  Action,
  (ctx: {
    service: { name: string; path: string; config: import('../../config/types.js').GameServerConfig };
    environment: Environment;
    workspaceRoot: string;
    verbose?: boolean;
    profile?: string;
    force?: boolean;
    forceBuild?: boolean;
    requireImage?: boolean;
    record?: boolean;
    requireApproval?: 'never' | 'any-change' | 'broadening';
  }) => Promise<ActionResult>
> = {
  deploy,
  destroy,
  synth,
  diff,
  status,
  push,
  updates,
};

interface RunOptions {
  action?: Action;
  environment?: Environment;
  service?: string;
  nonInteractive?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
  /** Rebuild and push even when the content tag is already in ECR. */
  forceBuild?: boolean;
  /** Refuse to build; the image must already be in ECR (CI/CD). */
  requireImage?: boolean;
  /** `updates` only: record the observed values as the new baseline. */
  record?: boolean;
  requireApproval?: 'never' | 'any-change' | 'broadening';
  profile?: string;
  workspaceRoot: string;
}

async function run(options: RunOptions): Promise<void> {
  if (options.verbose) setVerbose(true);

  if (options.nonInteractive) {
    if (!options.action) {
      logger.error('--action is required in non-interactive mode');
      process.exit(1);
    }
    if (!options.environment) {
      logger.error('--environment is required in non-interactive mode');
      process.exit(1);
    }
    if (!options.service) {
      logger.error('--service is required in non-interactive mode');
      process.exit(1);
    }

    const serviceNames = options.service.split(',').map((s) => s.trim());
    const allDiscovered = discoverServices(options.workspaceRoot, options.environment);
    const results: ActionResult[] = [];

    for (const name of serviceNames) {
      const discovered = allDiscovered.find((s) => s.name === name);
      if (!discovered) {
        logger.error(
          `Service "${name}" not found. Available: ${allDiscovered.map((s) => s.name).join(', ')}`,
        );
        process.exit(1);
      }

      const action =
        options.dryRun && options.action === 'deploy'
          ? 'synth'
          : options.action;

      const handler = ACTION_HANDLERS[action];
      const result = await handler({
        service: discovered,
        environment: options.environment,
        workspaceRoot: options.workspaceRoot,
        verbose: options.verbose,
        profile: options.profile,
        force: options.force,
        forceBuild: options.forceBuild,
        requireImage: options.requireImage,
        record: options.record,
        requireApproval: options.requireApproval ?? (options.nonInteractive ? 'never' : 'broadening'),
      });

      results.push(result);

      if (result.success) {
        logger.info(`${name}: ${result.message}`);
      } else {
        logger.error(`${name}: ${result.message}`);
      }
    }

    const failed = results.filter((r) => !r.success).length;
    process.exit(failed > 0 ? 1 : 0);
  }

  // Interactive mode
  const result = await runCli({
    workspaceRoot: options.workspaceRoot,
    verbose: options.verbose,
    profile: options.profile,
  });

  process.exit(result.success ? 0 : 1);
}

// Parse options from argv (passed as JSON)
const options: RunOptions = JSON.parse(process.argv[2]!);
run(options);
