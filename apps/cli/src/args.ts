import { parseArgs } from 'node:util';
import type { Action, Environment } from '@respawn/core';

export const ACTIONS = ['deploy', 'destroy', 'synth', 'diff', 'status', 'push', 'updates'] as const;
export const ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;
const APPROVALS = ['never', 'any-change', 'broadening'] as const;

export interface ParsedArgs {
  /** Interactive (clack) unless --non-interactive is passed. */
  interactive: boolean;
  action?: Action;
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
    action: oneOf(values.action, ACTIONS, '--action'),
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
  };
}
