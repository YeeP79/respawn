import { runAws } from './exec.js';

/** Markers AWS uses when the problem is the session rather than the request. */
const CREDENTIAL_ERRORS = [
  'Token has expired',
  'ExpiredToken',
  'InvalidClientTokenId',
  'Unable to locate credentials',
  'The SSO session associated with this profile has expired',
  'sso session associated with this profile',
  'ForbiddenException',
];

export interface CallerIdentity {
  accountId: string;
  arn: string;
}

/**
 * Resolves which AWS account the current credentials actually belong to.
 *
 * Exists because the account a deploy *targets* and the account its credentials belong
 * to are set independently — the first by AWS_ACCOUNT_ID in .env, the second by whichever
 * profile is in play — and nothing else compares them.
 *
 * @throws With a message naming the profile when the session is missing or expired,
 *   rather than the raw CLI stderr. CDK's own failure for this is "Unable to resolve AWS
 *   account to use", which does not mention credentials at all and reads like a config
 *   error in the app.
 */
export async function resolveCallerIdentity(opts: {
  profile?: string;
  region?: string;
}): Promise<CallerIdentity> {
  const res = await runAws(['sts', 'get-caller-identity', '--output', 'json'], {
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.region ? { region: opts.region } : {}),
  });

  if (res.exitCode !== 0) {
    const stderr = res.stderr.trim();
    const named = opts.profile ? `profile "${opts.profile}"` : 'the default profile';
    if (CREDENTIAL_ERRORS.some((m) => stderr.toLowerCase().includes(m.toLowerCase()))) {
      throw new Error(
        `AWS credentials for ${named} are missing or expired. Refresh them:\n` +
          `  aws sso login --profile ${opts.profile ?? '<profile>'}`,
      );
    }
    throw new Error(`Could not resolve the AWS identity for ${named}: ${stderr || '(no stderr)'}`);
  }

  let parsed: { Account?: string; Arn?: string };
  try {
    parsed = JSON.parse(res.stdout) as { Account?: string; Arn?: string };
  } catch {
    throw new Error(`aws sts get-caller-identity returned unparseable output: ${res.stdout.trim()}`);
  }

  if (!parsed.Account) {
    throw new Error('aws sts get-caller-identity returned no Account field.');
  }
  return { accountId: parsed.Account, arn: parsed.Arn ?? '(unknown)' };
}
