import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { ExecutorContext } from '@nx/devkit';
import type { Action } from '../../config/types.js';

type Environment = 'dev' | 'staging' | 'prod';

export interface CdkExecutorSchema {
  action?: Action;
  environment?: Environment;
  service?: string;
  nonInteractive?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
  forceBuild?: boolean;
  requireImage?: boolean;
  record?: boolean;
  requireApproval?: 'never' | 'any-change' | 'broadening';
  profile?: string;
  region?: string;
}

/**
 * Nx executor for the Respawn CDK CLI.
 *
 * Spawns tsx to run the ESM entrypoint (run.ts) which has full access
 * to the codebase. Options are passed as a JSON argv payload.
 */
export default async function cdkExecutor(
  options: CdkExecutorSchema,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  const workspaceRoot = context.root;
  const runScript = path.join(workspaceRoot, 'apps', 'respawn', 'src', 'executors', 'cdk', 'run.ts');

  const payload = JSON.stringify({
    ...options,
    workspaceRoot,
  });

  const tsxBin = path.join(workspaceRoot, 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsxBin, [runScript, payload], {
    cwd: workspaceRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(options.profile ? { AWS_PROFILE: options.profile } : {}),
    },
  });

  return { success: result.status === 0 };
}
