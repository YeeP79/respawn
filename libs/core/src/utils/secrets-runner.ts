import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
 * Hands a secret value to the AWS CLI without it ever appearing in argv.
 *
 * The value goes in an owner-only temp file passed as `file://…`, and the file is
 * deleted as soon as the CLI returns. Keeping it out of argv is the whole point:
 * anything on the command line is visible in `ps` and in shell history.
 *
 * This replaces `file:///dev/stdin`, which looked cleaner but never worked. The CLI
 * OPENS whatever path it is given, and reopening `/dev/stdin` when stdin is an
 * anonymous pipe whose writer has already closed fails with ENXIO — so every call
 * died with "Unable to load paramfile file:///dev/stdin: No such device or address".
 * A file is openable, which is what the CLI actually requires.
 */
async function withSecretFile<T>(
  value: string,
  run: (fileArg: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'respawn-secret-'));
  const file = path.join(dir, 'value');
  await fs.writeFile(file, value, { mode: 0o600 });
  try {
    return await run(`file://${file}`);
  } finally {
    // Best-effort: a failure to clean up must not mask the caller's error, but the
    // value must not be left readable either.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
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
    const res = await withSecretFile(opts.value, (fileArg) =>
      runAws(
        [
          'ssm',
          'put-parameter',
          '--name',
          opts.sourceId,
          '--type',
          'SecureString',
          '--overwrite',
          '--value',
          fileArg,
        ],
        { profile: opts.profile, region: opts.region },
      ),
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

  const res = await withSecretFile(opts.value, (fileArg) =>
    runAws(
      exists.exitCode === 0
        ? ['secretsmanager', 'put-secret-value', '--secret-id', opts.sourceId, '--secret-string', fileArg]
        : ['secretsmanager', 'create-secret', '--name', opts.sourceId, '--secret-string', fileArg],
      { profile: opts.profile, region: opts.region },
    ),
  );
  if (res.exitCode !== 0) {
    throw new Error(
      `Failed to set secret "${opts.sourceId}": ${res.stderr.trim()}`,
    );
  }
}
