import type { GameServerConfig } from './types.js';

/**
 * Values that are obviously stand-ins rather than real config. A service whose
 * required var still holds one of these would deploy and run, but silently
 * misbehave — Quake Live with `admin=changeme` starts fine and grants nobody
 * admin. Matched case-insensitively against the trimmed value.
 */
const PLACEHOLDER_VALUES = new Set([
  'changeme',
  'change_me',
  'change-me',
  'changethis',
  'replaceme',
  'replace_me',
  'todo',
  'tbd',
  'none',
  'null',
  'undefined',
  'xxx',
  'xxxx',
  'your_token_here',
  'your-token-here',
]);

const PLACEHOLDER_PATTERNS = [
  /^<.*>$/, // <your-steam-id>
  /^your[_-]/i, // your_token, your-id
  /^\.{3,}$/, // ...
];

/** True when `value` is empty or a recognisable placeholder rather than real config. */
export function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  if (trimmed === '') return true;
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Names each `REQUIRED_ENV_VARS` entry that nothing supplies a real value for.
 *
 * A requirement is satisfied when the var is backed by a secret ref, answered by
 * a deploy-time prompt, overridden on this deploy, or set to a non-placeholder
 * `GAME_ENV_` value.
 */
export function findUnsatisfiedRequirements(
  config: GameServerConfig,
  overrides: Record<string, string> = {},
): string[] {
  const fromSecrets = new Set(config.secretRefs.map((r) => r.containerEnvVar));
  const fromPrompts = new Set(config.deployPrompts.map((p) => p.envVar));

  return config.requiredEnvVars.filter((name) => {
    if (fromSecrets.has(name)) return false;
    if (fromPrompts.has(name)) return false;
    if (!isPlaceholder(overrides[name])) return false;
    return isPlaceholder(config.gameEnvVars[name]);
  });
}

/** Formats the unsatisfied requirements into an actionable error message. */
export function formatRequirementError(
  config: GameServerConfig,
  missing: string[],
): string {
  const lines = missing.map((name) => {
    const current = config.gameEnvVars[name];
    const state =
      current === undefined ? 'not set' : `still "${current}" (a placeholder)`;
    return `  - ${name} is ${state}`;
  });

  return [
    `${config.serviceName} declares REQUIRED_ENV_VARS that have no real value:`,
    ...lines,
    '',
    'Set each one in the service .env as GAME_ENV_<NAME>=<value>, or, if it is a',
    'credential, reference it from SECRET_REFS and store the value with:',
    '  pnpm respawn  ->  Secrets',
  ].join('\n');
}
