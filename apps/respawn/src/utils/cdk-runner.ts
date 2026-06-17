import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { logger } from './logger.js';

export interface CdkRunnerOptions {
  command: 'deploy' | 'destroy' | 'synth' | 'diff';
  context: Record<string, string>;
  workspaceRoot: string;
  requireApproval?: 'never' | 'any-change' | 'broadening';
  profile?: string;
  verbose?: boolean;
  stacks?: string[];
  force?: boolean;
}

export interface CdkRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runCdk(options: CdkRunnerOptions): Promise<CdkRunnerResult> {
  return new Promise((resolve) => {
    const args: string[] = [options.command];

    // Add stacks if specified
    if (options.stacks && options.stacks.length > 0) {
      args.push(...options.stacks);
    }

    // Add context values
    for (const [key, value] of Object.entries(options.context)) {
      args.push('-c', `${key}=${value}`);
    }

    // Command-specific flags
    if (options.command === 'deploy') {
      // Default to 'never' since stdout/stderr are piped (no TTY for prompts)
      args.push(
        '--require-approval',
        options.requireApproval ?? 'never',
      );
      if (options.force) {
        args.push('--force');
      }
    }

    if (options.command === 'destroy') {
      if (options.force) {
        args.push('--force');
      }
    }

    if (options.profile) {
      args.push('--profile', options.profile);
    }

    if (options.verbose) {
      args.push('--verbose');
    }

    const cwd = path.resolve(options.workspaceRoot, 'apps', 'respawn');
    const cdkBin = path.resolve(cwd, 'node_modules', '.bin', 'cdk');
    logger.debug(`Running: ${cdkBin} ${args.join(' ')}`);
    logger.debug(`CWD: ${cwd}`);

    const child = spawn(cdkBin, args, {
      cwd,
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout: '', stderr: '' });
    });

    child.on('error', (err) => {
      logger.error('Failed to spawn CDK process:', err.message);
      resolve({ exitCode: 1, stdout: '', stderr: err.message });
    });
  });
}
