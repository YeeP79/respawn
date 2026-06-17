import { spawn } from 'node:child_process';
import { logger } from './logger.js';

export interface SetSecretOptions {
  /** Backing store: AWS Secrets Manager ('sm') or SSM Parameter Store ('ssm') */
  store: 'sm' | 'ssm';
  /** Secret name/ARN (sm) or parameter path (ssm) */
  sourceId: string;
  /** The plaintext value to store */
  value: string;
  /** AWS region */
  region?: string;
  /** AWS CLI profile */
  profile?: string;
}

interface AwsResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the AWS CLI with the given args. The secret value (when provided) is fed
 * via stdin and referenced as `file:///dev/stdin`, so it never appears in argv,
 * the process list (beyond the fd path), or shell history.
 */
function runAws(
  args: string[],
  opts: { profile?: string; region?: string; stdin?: string },
): Promise<AwsResult> {
  return new Promise((resolve) => {
    const finalArgs = [...args];
    if (opts.region) finalArgs.push('--region', opts.region);
    if (opts.profile) finalArgs.push('--profile', opts.profile);

    logger.debug(`Running: aws ${finalArgs.join(' ')}`);

    const child = spawn('aws', finalArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('close', (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr }),
    );
    child.on('error', (err) =>
      resolve({ exitCode: 1, stdout, stderr: err.message }),
    );

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

/**
 * Creates or updates a secret value in AWS Secrets Manager or SSM Parameter
 * Store (SecureString). Idempotent: existing secrets/parameters are overwritten.
 *
 * Sets a plain-string value — JSON secrets (referenced via a `#jsonKey`) must be
 * managed out-of-band.
 */
export async function setSecret(opts: SetSecretOptions): Promise<void> {
  if (opts.store === 'ssm') {
    const res = await runAws(
      [
        'ssm',
        'put-parameter',
        '--name',
        opts.sourceId,
        '--type',
        'SecureString',
        '--overwrite',
        '--value',
        'file:///dev/stdin',
      ],
      { profile: opts.profile, region: opts.region, stdin: opts.value },
    );
    if (res.exitCode !== 0) {
      throw new Error(
        `Failed to set SSM parameter "${opts.sourceId}": ${res.stderr.trim()}`,
      );
    }
    return;
  }

  // Secrets Manager: create if missing, otherwise put a new version.
  const exists = await runAws(
    ['secretsmanager', 'describe-secret', '--secret-id', opts.sourceId],
    { profile: opts.profile, region: opts.region },
  );

  const args =
    exists.exitCode === 0
      ? [
          'secretsmanager',
          'put-secret-value',
          '--secret-id',
          opts.sourceId,
          '--secret-string',
          'file:///dev/stdin',
        ]
      : [
          'secretsmanager',
          'create-secret',
          '--name',
          opts.sourceId,
          '--secret-string',
          'file:///dev/stdin',
        ];

  const res = await runAws(args, {
    profile: opts.profile,
    region: opts.region,
    stdin: opts.value,
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `Failed to set secret "${opts.sourceId}": ${res.stderr.trim()}`,
    );
  }
}
