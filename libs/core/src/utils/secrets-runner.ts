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
 * What a presence check could establish.
 *
 * `unknown` exists because "the secret is not there" and "I could not look" are
 * different facts with opposite remedies, and the AWS CLI reports both as a non-zero
 * exit. Collapsing them told an operator that secrets which exist perfectly well were
 * missing, and advised creating them — which, against the wrong account, writes
 * duplicates into it.
 */
export type SecretPresence =
  | { status: 'present' }
  | { status: 'absent' }
  | { status: 'unknown'; reason: string };

/**
 * The CLI's not-found errors, per store. Anything else — an expired SSO session, a
 * denial, a network failure — is a failure to LOOK, not evidence of absence.
 *
 * Matched on the error code rather than the prose, which is localised and reworded
 * between CLI versions.
 */
const NOT_FOUND = /ResourceNotFoundException|ParameterNotFound/;

/**
 * Reports whether a referenced secret/parameter already exists.
 *
 * ECS resolves `secrets:` before starting the container and CDK only synthesises
 * an ARN — it never checks existence — so a missing secret surfaces as an opaque
 * `ResourceInitializationError` after a full deploy. Checking up front turns that
 * into an actionable message. Never reads the value.
 *
 * Returns three outcomes rather than a boolean: see {@link SecretPresence}.
 */
export async function checkSecret(opts: {
  store: 'sm' | 'ssm';
  sourceId: string;
  region?: string;
  profile?: string;
}): Promise<SecretPresence> {
  const args =
    opts.store === 'ssm'
      ? ['ssm', 'get-parameter', '--name', opts.sourceId]
      : ['secretsmanager', 'describe-secret', '--secret-id', opts.sourceId];

  const res = await runAws(args, {
    profile: opts.profile,
    region: opts.region,
  });

  if (res.exitCode === 0) return { status: 'present' };
  if (NOT_FOUND.test(res.stderr)) return { status: 'absent' };

  // Keep it to one line: this is rendered inline per secret, and the CLI's multi-line
  // tracebacks would bury the list being reported.
  const reason =
    res.stderr.trim().split('\n').filter(Boolean).pop() ??
    `aws exited ${res.exitCode} with no stderr`;
  return { status: 'unknown', reason };
}

/**
 * Reads a secret's plaintext value back.
 *
 * Deliberately separate from `checkSecret`, which never reads a value: most callers
 * only need presence, and a helper that returned the value "in case" would put
 * credentials into logs and transcripts as a side effect of an existence check.
 * Disclosure should be something a caller asks for by name — which is why this is its
 * own function, and why the MCP puts it behind its own gate.
 *
 * The value comes back on stdout rather than through a file: this is a read, so there is
 * no argv exposure to avoid (the secret NAME is not sensitive), and the AWS CLI has no
 * way to write a value anywhere but stdout.
 *
 * @returns The plaintext, or undefined when the secret does not exist.
 */
export async function readSecret(opts: {
  store: 'sm' | 'ssm';
  sourceId: string;
  jsonKey?: string;
  region?: string;
  profile?: string;
}): Promise<string | undefined> {
  const args =
    opts.store === 'ssm'
      ? ['ssm', 'get-parameter', '--name', opts.sourceId, '--with-decryption',
         '--query', 'Parameter.Value', '--output', 'text']
      : ['secretsmanager', 'get-secret-value', '--secret-id', opts.sourceId,
         '--query', 'SecretString', '--output', 'text'];

  const res = await runAws(args, { profile: opts.profile, region: opts.region });
  if (res.exitCode !== 0) return undefined;
  const raw = res.stdout.trim();
  if (!raw) return undefined;
  if (!opts.jsonKey) return raw;
  // A SECRET_REFS entry may name a key inside a JSON secret; return that member, not
  // the whole document, so the caller gets what the container would receive.
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && opts.jsonKey in (parsed as Record<string, unknown>)) {
      const v = (parsed as Record<string, unknown>)[opts.jsonKey];
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
    return undefined;
  } catch {
    return undefined;
  }
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
