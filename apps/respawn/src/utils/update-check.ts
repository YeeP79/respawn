import type { UpdateCheck } from '../config/types.js';

/**
 * Where a single check stands relative to what was last recorded.
 *
 * `unknown` is deliberately distinct from `up-to-date`: a Docker Hub outage or a
 * Steam API hiccup must never be reported as "nothing to do", the same way a
 * failed player probe is never reported as "empty".
 */
export type UpdateStatus =
  | 'up-to-date'
  | 'update-available'
  | 'never-recorded'
  | 'unknown';

export interface CheckResult {
  serviceName: string;
  check: UpdateCheck;
  /** Stable key used for the SSM parameter, e.g. `image-digest`, `steam-730`. */
  key: string;
  /** Value observed upstream right now, or undefined when it could not be read. */
  current?: string;
  /** Value recorded at the last deploy, or undefined when never recorded. */
  recorded?: string;
  status: UpdateStatus;
  /** Populated when status is `unknown`. */
  error?: string;
}

/** Stable SSM key for a check. */
export function checkKey(check: UpdateCheck): string {
  switch (check.kind) {
    case 'image':
      return 'image-digest';
    case 'build':
      return 'build-tag';
    case 'steam':
      return `steam-${check.appId}`;
  }
}

/** Human label for a check, used in the report table. */
export function checkLabel(check: UpdateCheck): string {
  switch (check.kind) {
    case 'image':
      return 'image';
    case 'build':
      return 'build';
    case 'steam':
      return `steam:${check.appId}`;
  }
}

/**
 * Compares an observed value against the recorded one.
 *
 * @param current - Undefined when the upstream lookup failed.
 * @param recorded - Undefined when nothing was ever recorded.
 */
export function compareStatus(
  current: string | undefined,
  recorded: string | undefined,
): UpdateStatus {
  if (current === undefined) return 'unknown';
  if (recorded === undefined) return 'never-recorded';
  return current === recorded ? 'up-to-date' : 'update-available';
}

interface SteamAppInfo {
  data?: Record<
    string,
    { depots?: { branches?: { public?: { buildid?: string } } } }
  >;
}

/**
 * Fetches the public branch build id for a Steam app.
 *
 * Valve publishes no build-id API, so this uses the third-party `api.steamcmd.net`
 * mirror. Any failure raises rather than returning a value: the caller reports
 * `unknown`, never `up-to-date`.
 *
 * @throws When the request fails or the app id is not present in the response.
 */
export async function fetchSteamBuildId(
  appId: string,
  timeoutMs = 15_000,
): Promise<string> {
  const response = await fetch(`https://api.steamcmd.net/v1/info/${appId}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`steamcmd.net returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as SteamAppInfo;
  const buildId = body.data?.[appId]?.depots?.branches?.public?.buildid;
  if (!buildId) {
    throw new Error(`no public build id for app ${appId}`);
  }
  return buildId;
}

/** True when any result means a redeploy would change what is running. */
export function hasActionableUpdate(results: CheckResult[]): boolean {
  return results.some((r) => r.status === 'update-available');
}
