import { parseArgs } from 'node:util';
import type { Environment } from '@respawn/core';

/** The CDK/AWS actions that route through the shared ACTION_HANDLERS table. */
export const ACTIONS = [
  'deploy',
  'destroy',
  'synth',
  'diff',
  'status',
  'push',
  'updates',
  'scale',
] as const;
/** Every value `--action` accepts. `secrets` is not a core Action — it has its own
 *  (interactive or stdin-fed) flow — but it is a valid top-level command. */
export const CLI_COMMANDS = [...ACTIONS, 'secrets'] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];
export const ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
const APPROVALS = ['never', 'any-change', 'broadening'] as const;

export interface ParsedArgs {
  /** Interactive (clack) unless --non-interactive is passed. */
  interactive: boolean;
  action?: CliCommand;
  environment?: Environment;
  /** Comma-separated service list (batch mode). */
  service?: string;
  profile?: string;
  region?: string;
  verbose: boolean;
  force: boolean;
  forceBuild: boolean;
  requireImage: boolean;
  record: boolean;
  dryRun: boolean;
  requireApproval?: (typeof APPROVALS)[number];
  workspaceRoot: string;
  /** ECS desiredCount for the `scale` action. */
  count?: number;
  /** Container env var name for the non-interactive `secrets` flow (value read from stdin). */
  secret?: string;
  /** Deploy-time env overrides (deploy-prompt answers) as containerEnvVar → value. */
  gameEnv?: Record<string, string>;
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${flag} "${value}". Expected one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/** Parses `--count` into a non-negative integer, or throws a readable error. */
function parseCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid --count "${value}". Expected a non-negative integer.`);
  }
  return n;
}

/** Parses repeated `--game-env KEY=VAL` flags into a map. Throws on a malformed entry. */
function parseGameEnv(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const entry of values) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid --game-env "${entry}". Expected KEY=VALUE.`);
    }
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/**
 * Parses the CLI argv into a validated shape. Pure (no process access) so it is
 * unit-tested; the caller supplies the default workspace root. Throws with a readable
 * message on an unknown flag or an out-of-range action/environment/approval value.
 */
export function parseCliArgs(argv: string[], defaultWorkspaceRoot: string): ParsedArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      action: { type: 'string' },
      environment: { type: 'string' },
      service: { type: 'string' },
      profile: { type: 'string' },
      region: { type: 'string' },
      'require-approval': { type: 'string' },
      'workspace-root': { type: 'string' },
      count: { type: 'string' },
      secret: { type: 'string' },
      'game-env': { type: 'string', multiple: true },
      'non-interactive': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'force-build': { type: 'boolean', default: false },
      'require-image': { type: 'boolean', default: false },
      record: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  return {
    interactive: !values['non-interactive'],
    action: oneOf(values.action, CLI_COMMANDS, '--action'),
    environment: oneOf(values.environment, ENVIRONMENTS, '--environment'),
    ...(values.service !== undefined ? { service: values.service } : {}),
    ...(values.profile !== undefined ? { profile: values.profile } : {}),
    ...(values.region !== undefined ? { region: values.region } : {}),
    verbose: values.verbose ?? false,
    force: values.force ?? false,
    forceBuild: values['force-build'] ?? false,
    requireImage: values['require-image'] ?? false,
    record: values.record ?? false,
    dryRun: values['dry-run'] ?? false,
    ...(values['require-approval'] !== undefined
      ? { requireApproval: oneOf(values['require-approval'], APPROVALS, '--require-approval') }
      : {}),
    workspaceRoot: values['workspace-root'] ?? defaultWorkspaceRoot,
    ...(parseCount(values.count) !== undefined ? { count: parseCount(values.count) } : {}),
    ...(values.secret !== undefined ? { secret: values.secret } : {}),
    ...(parseGameEnv(values['game-env']) !== undefined
      ? { gameEnv: parseGameEnv(values['game-env']) }
      : {}),
  };
}
