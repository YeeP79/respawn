/**
 * Resolving which AWS account and region a service's calls should go to.
 *
 * A service's `.env` is the single source of truth for where it lives. Most of the fleet
 * inherits the workspace-root `.env.defaults`, but a service may override the target —
 * `apps/ut99/variants/modded` and `apps/l4d2/variants/modded` both deploy to a different
 * account AND region from everything else.
 *
 * So the process environment (`RESPAWN_PROFILE` / `RESPAWN_REGION`) is a FALLBACK for a
 * service that declares nothing, never an override.
 */

/** The AWS half of a loaded service config. Structural, so callers need no import. */
export interface DeclaredAwsTarget {
  region?: string | undefined;
  profile?: string | undefined;
}

export interface ResolvedAwsTarget {
  region: string;
  profile?: string | undefined;
}

/**
 * Prefers what a service DECLARES over the process environment, for both keys.
 *
 * Region already behaved this way and profile did not, which is the worst of the two
 * possible inconsistencies: a call reached the right REGION carrying the wrong ACCOUNT's
 * credentials, so it looked correctly targeted and was not. `check_secrets` reported a
 * cross-account service's existing secrets as MISSING and advised creating them — which
 * would have written duplicates into the wrong account — and every lifecycle action
 * forced its own profile over the declaration, which is the same trap `pnpm respawn`'s
 * hardcoded `--profile` sets for the CLI.
 *
 * An explicitly declared profile wins even when it names the same account as the
 * fallback: agreeing by accident is not the same as agreeing on purpose, and the
 * declaration is the thing under review.
 */
export function resolveAwsTarget(
  declared: DeclaredAwsTarget,
  fallback: ResolvedAwsTarget,
): ResolvedAwsTarget {
  const profile = declared.profile ?? fallback.profile;
  return {
    region: declared.region ?? fallback.region,
    ...(profile ? { profile } : {}),
  };
}
