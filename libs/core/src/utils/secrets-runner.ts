import { runAws } from '../aws/exec.js';

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

/**
 * Reports whether a referenced secret/parameter already exists.
 *
 * ECS resolves `secrets:` before starting the container and CDK only synthesises
 * an ARN — it never checks existence — so a missing secret surfaces as an opaque
 * `ResourceInitializationError` after a full deploy. Checking up front turns that
 * into an actionable message. Never reads the value.
 */
export async function secretExists(opts: {
  store: 'sm' | 'ssm';
  sourceId: string;
  region?: string;
  profile?: string;
}): Promise<boolean> {
  const args =
    opts.store === 'ssm'
      ? ['ssm', 'get-parameter', '--name', opts.sourceId]
      : ['secretsmanager', 'describe-secret', '--secret-id', opts.sourceId];

  const res = await runAws(args, {
    profile: opts.profile,
    region: opts.region,
  });
  return res.exitCode === 0;
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
