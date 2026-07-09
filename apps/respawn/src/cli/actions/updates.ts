import { resolveBaseImageDigest } from '@respawn/docker-utils';
import type {
  ActionResult,
  DiscoveredService,
  Environment,
} from '../../config/types.js';
import { logger } from '../../utils/logger.js';
import { readState, writeState } from '../../utils/ssm-state.js';
import {
  checkKey,
  checkLabel,
  compareStatus,
  fetchSteamBuildId,
  hasActionableUpdate,
  type CheckResult,
} from '../../utils/update-check.js';
import { resolveImage } from './push.js';

export interface UpdatesContext {
  service: DiscoveredService;
  environment: Environment;
  workspaceRoot: string;
  verbose?: boolean;
  profile?: string;
  /** Write the observed values back to SSM as the new baseline. */
  record?: boolean;
}

/**
 * Reads the current upstream value for one check.
 *
 * @throws Never — a failure is returned as an error string so a single flaky
 *   lookup cannot mask the other services' results.
 */
async function observe(
  ctx: UpdatesContext,
  check: CheckResult['check'],
): Promise<{ current?: string; error?: string }> {
  try {
    switch (check.kind) {
      case 'image': {
        const ref = ctx.service.config.image.imageUri!;
        return { current: await resolveBaseImageDigest(ref) };
      }
      case 'build': {
        const resolved = await resolveImage(ctx);
        return { current: resolved.tag };
      }
      case 'steam': {
        return { current: await fetchSteamBuildId(check.appId) };
      }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Evaluates every `UPDATE_CHECK` a service declares against the values recorded
 * at its last deploy.
 */
export async function checkUpdates(
  ctx: UpdatesContext,
): Promise<CheckResult[]> {
  const { config } = ctx.service;
  const region = config.aws.region;
  const profile = ctx.profile ?? config.aws.profile;

  return Promise.all(
    config.updateChecks.map(async (check): Promise<CheckResult> => {
      const key = checkKey(check);
      const [{ current, error }, recorded] = await Promise.all([
        observe(ctx, check),
        readState({ serviceName: ctx.service.name, key, region, profile }),
      ]);

      return {
        serviceName: ctx.service.name,
        check,
        key,
        current,
        recorded,
        status: compareStatus(current, recorded),
        error,
      };
    }),
  );
}

/**
 * Records the currently observed values as the new baseline. Called after a
 * successful deploy, and by `--record`.
 *
 * Values that could not be observed are skipped rather than erased — recording
 * `undefined` would silently reset the baseline.
 */
export async function recordUpdateState(
  ctx: UpdatesContext,
  results: CheckResult[],
): Promise<void> {
  const { config } = ctx.service;
  const region = config.aws.region;
  const profile = ctx.profile ?? config.aws.profile;

  for (const result of results) {
    if (result.current === undefined) {
      logger.warn(
        `${result.serviceName}: not recording ${checkLabel(result.check)} — ${result.error}`,
      );
      continue;
    }
    await writeState({
      serviceName: result.serviceName,
      key: result.key,
      value: result.current,
      region,
      profile,
    });
  }
}

const STATUS_LABEL: Record<CheckResult['status'], string> = {
  'up-to-date': 'up to date',
  'update-available': 'UPDATE AVAILABLE',
  'never-recorded': 'never recorded',
  unknown: 'unknown',
};

function shorten(value: string | undefined): string {
  if (!value) return '-';
  return value.startsWith('sha256:') ? value.slice(7, 19) : value;
}

/** Formats one service's results as aligned lines. */
export function formatResults(results: CheckResult[]): string[] {
  return results.map((r) => {
    const detail =
      r.status === 'unknown'
        ? `(${r.error})`
        : r.status === 'update-available'
          ? `${shorten(r.recorded)} -> ${shorten(r.current)}`
          : shorten(r.current);
    return `  ${r.serviceName.padEnd(10)} ${checkLabel(r.check).padEnd(14)} ${STATUS_LABEL[r.status].padEnd(17)} ${detail}`;
  });
}

/**
 * `updates` action: report what has changed upstream since the last deploy.
 *
 * Succeeds when nothing is stale. An `update-available` result fails the action
 * so the batch script exits non-zero, making it usable as a cron job or CI gate.
 * `unknown` does not fail — a Docker Hub outage is not an update.
 */
export async function updates(ctx: UpdatesContext): Promise<ActionResult> {
  const start = Date.now();
  const { service } = ctx;

  try {
    if (service.config.updateChecks.length === 0) {
      return {
        success: true,
        serviceName: service.name,
        action: 'updates',
        message: `${service.name}: no UPDATE_CHECK configured.`,
        duration: Date.now() - start,
      };
    }

    const results = await checkUpdates(ctx);
    for (const line of formatResults(results)) logger.info(line);

    if (ctx.record) {
      await recordUpdateState(ctx, results);
    }

    const stale = hasActionableUpdate(results);
    return {
      success: !stale,
      serviceName: service.name,
      action: 'updates',
      message: stale
        ? `${service.name}: update available.`
        : `${service.name}: nothing to do.`,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      serviceName: service.name,
      action: 'updates',
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}
