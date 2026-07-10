import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';

// One AWS-CLI spawn wrapper for the whole workspace. Before this, five near-identical
// copies existed (secrets-runner, ssm-state, the status action, and the MCP's
// discovery), each appending --region/--profile by hand and diverging on --output and
// stdin handling. Everything shells the `aws` CLI (no @aws-sdk); this is that gateway.

export interface AwsResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AwsExecOptions {
  region?: string;
  profile?: string;
  /**
   * Written to the child's stdin, then closed. Used to keep secret values out of argv
   * (passed as `file:///dev/stdin`), so they never reach the process list or history.
   */
  stdin?: string;
}

/** Error thrown by the JSON helper on a non-zero exit or unparseable output. */
export class AwsCliError extends Error {}

/** Appends `--region`/`--profile` to an aws argv. Pure — the unit-tested core. */
export function withAwsOptions(
  args: readonly string[],
  opts: { region?: string; profile?: string } = {},
): string[] {
  const out = [...args];
  if (opts.region) out.push('--region', opts.region);
  if (opts.profile) out.push('--profile', opts.profile);
  return out;
}

/**
 * Runs the AWS CLI once. Never rejects: a spawn failure resolves as exitCode 1 with the
 * error on stderr, so callers branch on `exitCode` uniformly.
 */
export function runAws(
  args: readonly string[],
  opts: AwsExecOptions = {},
): Promise<AwsResult> {
  const finalArgs = withAwsOptions(args, opts);
  return new Promise((resolve) => {
    logger.debug(`Running: aws ${finalArgs.join(' ')}`);
    const child = spawn('aws', finalArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

/**
 * Runs the AWS CLI with `--output json` and returns the parsed result.
 *
 * @throws AwsCliError on a non-zero exit (message carries stderr) or when stdout is not
 *   valid JSON — the read-path callers want a thrown error, not a status code.
 */
export async function runAwsJson<T = unknown>(
  args: readonly string[],
  opts: { region?: string; profile?: string } = {},
): Promise<T> {
  const res = await runAws([...args, '--output', 'json'], opts);
  if (res.exitCode !== 0) {
    throw new AwsCliError(
      `aws ${args.join(' ')} failed (exit ${res.exitCode}): ${res.stderr.trim() || '(no stderr)'}`,
    );
  }
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    throw new AwsCliError(`aws ${args.join(' ')} returned unparseable JSON`);
  }
}
