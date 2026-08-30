import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type {
  AdditionalPort,
  DeployPrompt,
  Environment,
  GameServerConfig,
  RconProtocol,
  SecretRef,
  UpdateCheck,
  WorldFlavor,
} from './types.js';
import {
  DEFAULT_CONTAINER,
  DEFAULT_NETWORKING,
  DEFAULT_SCALING,
  DEFAULT_IMAGE,
  DEFAULT_LOGGING,
  DEFAULT_COST,
  DEFAULT_ECR,
  DEFAULT_HEALTH_CHECK,
  DEFAULT_IDLE_SHUTDOWN,
  DEFAULT_REDIS,
  DEFAULT_MYSQL,
  DEFAULT_WORLD_SYNC,
  WORLD_FLAVORS,
  DEFAULT_RCON_CONTROL,
  DEFAULT_PERSISTENT_STORAGE,
  DEFAULT_AWS,
  ENVIRONMENT_OVERRIDES,
  defaultTags,
} from './defaults.js';

const VALID_CPU_VALUES = [256, 512, 1024, 2048, 4096];

const CPU_MEMORY_RANGES: Record<number, [number, number]> = {
  256: [512, 2048],
  512: [1024, 4096],
  1024: [2048, 8192],
  2048: [4096, 16384],
  4096: [8192, 30720],
};

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value.toLowerCase() === 'true';
}

function parseProtocol(value: string | undefined): 'TCP' | 'UDP' | undefined {
  if (value === undefined || value === '') return undefined;
  const upper = value.toUpperCase();
  if (upper === 'TCP' || upper === 'UDP') return upper;
  return undefined;
}

function parseCheckMethod(
  value: string | undefined,
): 'netstat' | 'http' | 'a2s' | 'q3' | 'gamespy' | 'zandronum' | undefined {
  if (value === undefined || value === '') return undefined;
  const lower = value.toLowerCase();
  if (
    lower === 'netstat' ||
    lower === 'http' ||
    lower === 'a2s' ||
    lower === 'q3' ||
    lower === 'gamespy' ||
    lower === 'zandronum'
  ) {
    return lower;
  }
  return undefined;
}

const RCON_PROTOCOLS = [
  'goldsrc',
  'source',
  'q3',
  'zandronum',
  'zandronum-query',
  'gamespy',
  'uweb',
] as const;

// Protocols that carry no credentials — a password requirement makes no sense for them.
// Kept in sync with rcon.py's UNAUTHENTICATED_PROTOCOLS; the write-transport validation
// below uses it to decide when a password secret is mandatory.
const UNAUTHENTICATED_PROTOCOLS: readonly RconProtocol[] = ['gamespy', 'zandronum-query'];

// Protocols that authenticate with a USERNAME as well as a password. Only uweb does —
// it is HTTP Basic against the UE1 web admin. Every rcon-family transport (goldsrc,
// source, zandronum) is password-only, so demanding a username for them would reject a
// perfectly valid config (Doom 2 writes over password-only zandronum rcon).
const USER_PROTOCOLS: readonly RconProtocol[] = ['uweb'];

/**
 * @throws On an unrecognised protocol. Returning undefined would fall through to the
 *   `goldsrc` default, so a typo would silently point the sidecar at the wrong wire
 *   protocol and every rcon call would time out for no visible reason.
 */
function parseRconProtocol(value: string | undefined, envName = 'RCON_PROTOCOL'): RconProtocol | undefined {
  if (value === undefined || value === '') return undefined;
  const lower = value.toLowerCase();
  const match = RCON_PROTOCOLS.find((p) => p === lower);
  if (!match) {
    throw new Error(
      `Invalid ${envName}: ${value}. Expected one of ${RCON_PROTOCOLS.join(', ')}.`,
    );
  }
  return match;
}

/**
 * @throws On anything but the two known flavors. Falling through to undefined would
 *   make a typo read as "no flavor declared", and the whole point of the field is that
 *   a modded save cannot reach a vanilla server — a guard that silently disables itself
 *   on a typo is worse than no guard, because it is still believed.
 */
function parseWorldFlavor(value: string | undefined): WorldFlavor | undefined {
  if (value === undefined || value === '') return undefined;
  const lower = value.toLowerCase();
  const match = WORLD_FLAVORS.find((f) => f === lower);
  if (!match) {
    throw new Error(
      `Invalid WORLD_FLAVOR "${value}". Expected one of ${WORLD_FLAVORS.join(', ')}.`,
    );
  }
  return match;
}

function parseGameEnvVars(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  const prefix = 'GAME_ENV_';
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length)] = value;
    }
  }
  return result;
}

function parseSecretRefs(value: string | undefined): SecretRef[] {
  if (value === undefined || value === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      // Grammar: <ENV_VAR>=<sm|ssm>:<sourceId>[|<jsonKey>]
      // ('|' separates the jsonKey, not '#', because dotenv strips '#' as an
      // inline comment. '|' is not legal in SM secret names or SSM paths.)
      const eqIdx = entry.indexOf('=');
      if (eqIdx === -1) {
        throw new Error(
          `Invalid SECRET_REFS entry "${entry}". Expected "ENV_VAR=<sm|ssm>:<sourceId>[|jsonKey]".`,
        );
      }
      const containerEnvVar = entry.slice(0, eqIdx).trim();
      if (!containerEnvVar) {
        throw new Error(
          `Invalid SECRET_REFS entry "${entry}". Missing env var name before "=".`,
        );
      }

      const rhs = entry.slice(eqIdx + 1).trim();
      const colonIdx = rhs.indexOf(':');
      if (colonIdx === -1) {
        throw new Error(
          `Invalid SECRET_REFS entry "${entry}". Missing store prefix "sm:" or "ssm:".`,
        );
      }
      const store = rhs.slice(0, colonIdx).trim();
      if (store !== 'sm' && store !== 'ssm') {
        throw new Error(
          `Invalid SECRET_REFS store "${store}" in "${entry}". Must be "sm" or "ssm".`,
        );
      }

      let sourceId = rhs.slice(colonIdx + 1).trim();
      let jsonKey: string | undefined;
      const pipeIdx = sourceId.indexOf('|');
      if (pipeIdx !== -1) {
        jsonKey = sourceId.slice(pipeIdx + 1).trim() || undefined;
        sourceId = sourceId.slice(0, pipeIdx).trim();
        if (store === 'ssm' && jsonKey) {
          throw new Error(
            `Invalid SECRET_REFS entry "${entry}". A jsonKey (|) is only valid for "sm:" secrets.`,
          );
        }
      }
      if (!sourceId) {
        throw new Error(
          `Invalid SECRET_REFS entry "${entry}". Missing secret source id.`,
        );
      }

      return { containerEnvVar, store, sourceId, jsonKey };
    });
}

function parseDeployPrompts(value: string | undefined): DeployPrompt[] {
  if (value === undefined || value === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      // Grammar: <envVar>:<type>:<opt1>|<opt2>|...
      // Split on the first two colons so options may themselves contain colons.
      const firstColon = entry.indexOf(':');
      const secondColon =
        firstColon === -1 ? -1 : entry.indexOf(':', firstColon + 1);
      if (firstColon === -1 || secondColon === -1) {
        throw new Error(
          `Invalid DEPLOY_PROMPTS entry "${entry}". Expected "ENV_VAR:select:opt1|opt2".`,
        );
      }
      const envVar = entry.slice(0, firstColon).trim();
      const type = entry.slice(firstColon + 1, secondColon).trim();
      const optionsRaw = entry.slice(secondColon + 1).trim();

      if (!envVar) {
        throw new Error(
          `Invalid DEPLOY_PROMPTS entry "${entry}". Missing env var name.`,
        );
      }
      if (type !== 'select') {
        throw new Error(
          `Invalid DEPLOY_PROMPTS type "${type}" in "${entry}". Only "select" is supported.`,
        );
      }
      const options = optionsRaw
        .split('|')
        .map((o) => o.trim())
        .filter((o) => o.length > 0);
      if (options.length === 0) {
        throw new Error(
          `Invalid DEPLOY_PROMPTS entry "${entry}". Needs at least one option.`,
        );
      }

      return { envVar, type: 'select' as const, options };
    });
}

function parseAdditionalPorts(value: string | undefined): AdditionalPort[] {
  if (value === undefined || value === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      // Formats: "port/protocol" or "hostPort:containerPort/protocol"
      const slashIdx = entry.indexOf('/');
      if (slashIdx === -1) {
        throw new Error(
          `Invalid additional port format: "${entry}". Expected "port/protocol" or "hostPort:containerPort/protocol".`,
        );
      }
      const portPart = entry.slice(0, slashIdx);
      const protocolPart = entry.slice(slashIdx + 1).toUpperCase();
      if (protocolPart !== 'TCP' && protocolPart !== 'UDP') {
        throw new Error(
          `Invalid protocol in additional port "${entry}". Must be TCP or UDP.`,
        );
      }
      const colonIdx = portPart.indexOf(':');
      let hostPort: number;
      let containerPort: number;
      if (colonIdx === -1) {
        const port = Number(portPart);
        if (Number.isNaN(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid port number in additional port "${entry}".`);
        }
        hostPort = port;
        containerPort = port;
      } else {
        hostPort = Number(portPart.slice(0, colonIdx));
        containerPort = Number(portPart.slice(colonIdx + 1));
        if (
          Number.isNaN(hostPort) ||
          hostPort < 1 ||
          hostPort > 65535 ||
          Number.isNaN(containerPort) ||
          containerPort < 1 ||
          containerPort > 65535
        ) {
          throw new Error(`Invalid port number in additional port "${entry}".`);
        }
      }
      return { containerPort, hostPort, protocol: protocolPart as 'TCP' | 'UDP' };
    });
}

function parseCommand(value: string | undefined): string[] | undefined {
  if (value === undefined || value === '') return undefined;
  return value.split(/\s+/).filter((s) => s.length > 0);
}

/**
 * Parses `UPDATE_CHECK=image,build,steam:730` into typed checks.
 *
 * @throws On an unknown kind, or a `steam:` entry without a numeric app id.
 */
function parseUpdateChecks(value: string | undefined): UpdateCheck[] {
  if (value === undefined || value === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== 'none')
    .map((entry) => {
      if (entry === 'image') return { kind: 'image' as const };
      if (entry === 'build') return { kind: 'build' as const };

      const steam = /^steam:(\d+)$/.exec(entry);
      if (steam) return { kind: 'steam' as const, appId: steam[1]! };

      throw new Error(
        `Invalid UPDATE_CHECK entry "${entry}". Expected "image", "build", ` +
          `"steam:<appId>", or "none".`,
      );
    });
}

function parseRequiredEnvVars(value: string | undefined): string[] {
  if (value === undefined || value === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Substrings that mark a name as holding a credential. Matched against the name
// with separators stripped, so RCON_PASSWORD, rcon_password and SRCDS_RCONPW all
// hit. Deliberately does NOT include "RCON": RUST_RCON_PORT and RUST_RCON_WEB are
// legitimate plaintext settings.
const SECRET_LIKE_SUBSTRINGS = [
  'PASS',
  'PASSWD',
  'PASSPHRASE',
  'PWD',
  'RCONPW',
  'SECRET',
  'TOKEN',
  'GSLT',
  'APIKEY',
  'PRIVATEKEY',
  'CREDENTIAL',
];

function isSecretLike(name: string): boolean {
  const normalized = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return SECRET_LIKE_SUBSTRINGS.some((s) => normalized.includes(s));
}

/**
 * Rejects credentials supplied as plaintext config. `GAME_ENV_*` and
 * `CONTAINER_COMMAND` both end up in the ECS task definition, readable by anyone
 * with ECS read access; the command is additionally visible in `ps` inside the
 * container. Secrets belong in SECRET_REFS, which ECS injects at container start.
 * See AGENT_PROMPT.md §7.
 */
function validateNoPlaintextSecrets(config: GameServerConfig): void {
  for (const key of Object.keys(config.gameEnvVars)) {
    if (isSecretLike(key)) {
      throw new Error(
        `GAME_ENV_${key} looks like a credential and would be stored in plaintext ` +
          `in the ECS task definition. Move it to SECRET_REFS instead:\n` +
          `  SECRET_REFS=${key}=sm:respawn/${config.serviceName}/${key.toLowerCase()}`,
      );
    }
  }

  for (const arg of config.container.command ?? []) {
    // Strip leading flag markers (+rcon_password, -rcon_password, --password=x)
    // and any inline value, leaving the bare option name to test.
    const name = arg.replace(/^[+-]{1,2}/, '').split('=')[0]!;
    if (name && isSecretLike(name)) {
      throw new Error(
        `CONTAINER_COMMAND contains "${arg}", which looks like a credential. It would ` +
          `be stored in plaintext in the ECS task definition and visible in \`ps\`.\n` +
          `Move it to SECRET_REFS and have the container's entrypoint (see apps/cs16/` +
          `respawn-init.sh) write it into the game's config file at startup.`,
      );
    }
  }

  // A name in both maps would be injected twice — ECS rejects the task definition.
  const secretVars = new Set(config.secretRefs.map((r) => r.containerEnvVar));
  for (const key of Object.keys(config.gameEnvVars)) {
    if (secretVars.has(key)) {
      throw new Error(
        `"${key}" is set by both GAME_ENV_${key} and SECRET_REFS. Remove the ` +
          `GAME_ENV_ entry — the secret already provides that container env var.`,
      );
    }
  }
}

/**
 * What each optional sidecar reserves, mirroring the `cpu` / `memoryLimitMiB` its
 * construct passes to `addContainer`. Kept here so the check below can run at config
 * load, long before any CDK code is reachable — the cost being that these numbers are
 * a copy, and moving one in a construct means moving it here too.
 */
const SIDECAR_RESERVATIONS = {
  idleShutdown: { cpu: 64, memory: 128 },
  rconControl: { cpu: 32, memory: 128 },
  redis: { cpu: 64, memory: 128 },
  mysql: { cpu: 128, memory: 512 },
  mysqlBackup: { cpu: 64, memory: 128 },
  worldSync: { cpu: 64, memory: 128 },
} as const;

/**
 * Rejects a CPU/memory pair the enabled sidecars cannot fit inside.
 *
 * ECS requires the sum of the containers' reservations to be no greater than the
 * task's, and the game container deliberately reserves nothing so it can use the
 * remainder. Four sidecars claim 288 CPU / 896 MiB between them, which does not fit a
 * CPU=256 task at all — and CDK's own rejection ("The sum of all container cpu values
 * cannot be greater than the value of the task cpu") arrives at synth naming a
 * construct path rather than a service, so it reads like a bug in the stack instead of
 * a number in a .env.
 *
 * Memory is checked more strictly than CPU because the two behave differently:
 * `memoryLimitMiB` is a hard limit, so what the sidecars claim is genuinely unavailable
 * to the game server, while container `cpu` is a relative share that the game server
 * bursts past whenever the sidecars are idle. Leaving the game 0 MiB would fit ECS's
 * rule and still fail to run anything, so a minimum headroom is required.
 */
function validateSidecarBudget(config: GameServerConfig): void {
  const active: Array<[string, { cpu: number; memory: number }]> = [];
  if (config.idleShutdown.enabled)
    active.push(['idle-shutdown', SIDECAR_RESERVATIONS.idleShutdown]);
  if (config.rconControl.enabled)
    active.push(['rcon-control', SIDECAR_RESERVATIONS.rconControl]);
  if (config.redis.enabled) active.push(['redis', SIDECAR_RESERVATIONS.redis]);
  if (config.mysql.enabled) {
    active.push(['mysql', SIDECAR_RESERVATIONS.mysql]);
    // The backup container only exists when a dump target is configured.
    if (config.mysql.backupS3Uri)
      active.push(['mysql-backup', SIDECAR_RESERVATIONS.mysqlBackup]);
  }
  if (config.worldSync.enabled)
    active.push(['world-sync', SIDECAR_RESERVATIONS.worldSync]);
  if (active.length === 0) return;

  const cpu = active.reduce((n, [, r]) => n + r.cpu, 0);
  const memory = active.reduce((n, [, r]) => n + r.memory, 0);
  const breakdown = active
    .map(([name, r]) => `${name} ${r.cpu}/${r.memory} MiB`)
    .join(', ');

  if (cpu > config.container.cpu) {
    throw new Error(
      `Sidecars reserve ${cpu} CPU but CPU is ${config.container.cpu}. ` +
        `Raise CPU to at least ${cpu} (and check the memory range that allows). ` +
        `Enabled: ${breakdown}.`,
    );
  }

  // 256 MiB is the floor the FLEET already runs at, not a guess: doom2, quakelive,
  // cs16 and tfc-vanilla each leave exactly this much after their sidecars, and
  // cs16-dm is verified live on 768. Picking anything higher would reject services
  // that demonstrably work; the value exists to catch a task whose sidecars have eaten
  // so much that the game server cannot start at all — which ECS itself permits, since
  // its only rule is that the reservations fit.
  const MIN_GAME_MEMORY_MIB = 256;
  const free = config.container.memory - memory;
  if (free < MIN_GAME_MEMORY_MIB) {
    throw new Error(
      `Sidecars hard-limit ${memory} MiB of MEMORY ${config.container.memory}, leaving ` +
        `${free} MiB for the game server (needs at least ${MIN_GAME_MEMORY_MIB}). ` +
        `Raise MEMORY to at least ${memory + MIN_GAME_MEMORY_MIB}. Enabled: ${breakdown}.`,
    );
  }
}

/**
 * The save file the world-sync sidecar must act on.
 *
 * `WORLD_SYNC_NAME` pins it; otherwise it is the game's own `WORLD_NAME`, read from
 * `gameEnvVars` rather than from the .env file. That indirection is the whole point: a
 * `DEPLOY_PROMPTS` answer is applied to `gameEnvVars` in the CDK app AFTER `loadConfig`
 * has run, so a name captured at load time is the pre-prompt one. Resolving it there
 * meant that rotating worlds at deploy time moved the game and left the sidecar on the
 * old name — seeding an inbox nobody fills and mirroring a world nobody plays, with no
 * error on either side.
 *
 * Call this at synth time. Do not cache the result on the config.
 */
export function resolveWorldName(config: GameServerConfig): string | undefined {
  return config.worldSync.worldName || config.gameEnvVars['WORLD_NAME'] || undefined;
}

function validate(config: GameServerConfig): void {
  validateNoPlaintextSecrets(config);

  if (!VALID_CPU_VALUES.includes(config.container.cpu)) {
    throw new Error(
      `Invalid CPU value: ${config.container.cpu}. Must be one of: ${VALID_CPU_VALUES.join(', ')}`,
    );
  }

  const [minMem, maxMem] = CPU_MEMORY_RANGES[config.container.cpu]!;
  if (config.container.memory < minMem || config.container.memory > maxMem) {
    throw new Error(
      `Invalid memory ${config.container.memory} MiB for CPU ${config.container.cpu}. Must be between ${minMem} and ${maxMem} MiB.`,
    );
  }

  validateSidecarBudget(config);

  if (
    config.networking.containerPort < 1 ||
    config.networking.containerPort > 65535
  ) {
    throw new Error(
      `Invalid containerPort: ${config.networking.containerPort}. Must be 1-65535.`,
    );
  }

  if (config.networking.hostPort < 1 || config.networking.hostPort > 65535) {
    throw new Error(
      `Invalid hostPort: ${config.networking.hostPort}. Must be 1-65535.`,
    );
  }

  for (const ap of config.networking.additionalPorts) {
    if (ap.containerPort < 1 || ap.containerPort > 65535) {
      throw new Error(
        `Invalid additional containerPort: ${ap.containerPort}. Must be 1-65535.`,
      );
    }
    if (ap.hostPort < 1 || ap.hostPort > 65535) {
      throw new Error(
        `Invalid additional hostPort: ${ap.hostPort}. Must be 1-65535.`,
      );
    }
  }

  if (
    config.idleShutdown.checkMethod === 'http' &&
    !config.idleShutdown.statusEndpoint
  ) {
    throw new Error(
      'idleShutdown.statusEndpoint is required when checkMethod is "http".',
    );
  }

  // An `image` check reads the digest that IMAGE_URI resolves to; a `build` check
  // hashes a Dockerfile that is only built when IMAGE_URI is unset. Each is
  // meaningless for the other kind of service, so catch the mix-up at load.
  const hasImageUri = Boolean(config.image.imageUri);
  for (const check of config.updateChecks) {
    if (check.kind === 'image' && !hasImageUri) {
      throw new Error(
        'UPDATE_CHECK=image requires IMAGE_URI, but this service builds its own ' +
          'image. Use UPDATE_CHECK=build instead.',
      );
    }
    if (check.kind === 'build' && hasImageUri) {
      throw new Error(
        'UPDATE_CHECK=build requires a locally built image, but IMAGE_URI is set. ' +
          'Use UPDATE_CHECK=image instead.',
      );
    }
  }

  if (config.worldSync.enabled) {
    // Every one of these is fatal at deploy time rather than load time if left to CDK,
    // and two of them fail INVISIBLY: a sidecar with no world name mirrors nothing, and
    // one pointed at a bucket root would be granted the whole bucket — which on the
    // shared state bucket means another service's player records.
    if (!config.persistentStorage.enabled) {
      throw new Error(
        `ENABLE_WORLD_SYNC needs ENABLE_PERSISTENT_STORAGE=true. The sidecar syncs the ` +
          `save on the persistent volume; with no volume there is nothing to sync and ` +
          `the world would die with the task anyway.`,
      );
    }
    if (!config.worldSync.s3Prefix) {
      throw new Error(
        `ENABLE_WORLD_SYNC needs WORLD_SYNC_S3_PREFIX, e.g. ` +
          `s3://respawn-state-<account>/${config.serviceName}. Use the PRIVATE state ` +
          `bucket, never the FastDL one: that bucket is public-read by necessity, and a ` +
          `world save there is the whole map openly downloadable.`,
      );
    }
    const prefix = config.worldSync.s3Prefix;
    if (!prefix.startsWith('s3://')) {
      throw new Error(
        `WORLD_SYNC_S3_PREFIX must be an s3:// URI, got "${prefix}".`,
      );
    }
    // Bucket root rejected deliberately: the task role's grant is scoped to this prefix,
    // so a root prefix widens it to every object in the bucket.
    const key = prefix.replace(/^s3:\/\//, '').replace(/\/+$/, '').split('/').slice(1).join('/');
    if (!key) {
      throw new Error(
        `WORLD_SYNC_S3_PREFIX "${prefix}" names a bucket with no prefix. The task role's ` +
          `S3 grant is scoped to this prefix, so a bucket root would grant it every ` +
          `object in the bucket. Use s3://<bucket>/${config.serviceName}.`,
      );
    }
    if (!config.worldSync.flavor) {
      throw new Error(
        `ENABLE_WORLD_SYNC needs WORLD_FLAVOR (${WORLD_FLAVORS.join(' or ')}). It is ` +
          `stamped onto every save that runs here and checked before one is installed, ` +
          `which is what keeps a modded world out of a vanilla server.`,
      );
    }
    // Deliberately NOT checked here. A service may legitimately declare no default world
    // so that every deploy has to name one — and a throw at load time would make
    // discovery drop the service from the CLI menu instead, since it catches config
    // errors and only warns. The requirement is enforced at DEPLOY time by
    // findUnsatisfiedWorld(), which is loud and knows the deploy's overrides.
  }

  if (!config.worldSync.enabled) {
    // WORLD_* keys are inert without ENABLE_WORLD_SYNC, and the failure is invisible:
    // the stack synthesizes cleanly with no sidecar, so the world is never seeded, never
    // mirrored, and never stamped — while the .env reads as if all three happen. Found
    // by reading a synthesized template, not by anything failing.
    const orphans = [
      ['WORLD_SYNC_S3_PREFIX', config.worldSync.s3Prefix],
      ['WORLD_FLAVOR', config.worldSync.flavor],
      ['WORLD_SYNC_PLUGIN_SOURCE', config.worldSync.pluginSource],
      ['WORLD_SYNC_NAME', config.worldSync.worldName],
      ['WORLD_ALLOW_CREATE', config.worldSync.allowCreate ? 'true' : undefined],
    ].filter(([, v]) => v !== undefined).map(([k]) => k);
    if (orphans.length > 0) {
      throw new Error(
        `${orphans.join(', ')} ${orphans.length === 1 ? 'is' : 'are'} set but ` +
          `ENABLE_WORLD_SYNC is not true, so no world-sync sidecar is created and every ` +
          `one of those settings does nothing. Set ENABLE_WORLD_SYNC=true, or remove them.`,
      );
    }
  }

  if (config.rconControl.enabled) {
    const named = config.secretRefs.some(
      (r) => r.containerEnvVar === config.rconControl.passwordSecretVar,
    );
    if (!named) {
      throw new Error(
        `ENABLE_RCON_CONTROL needs the rcon password in SECRET_REFS as ` +
          `"${config.rconControl.passwordSecretVar}", so it is injected as an ECS ` +
          `secret rather than plaintext. Add it, or set RCON_PASSWORD_VAR to the ` +
          `SECRET_REFS entry that holds it.`,
      );
    }
    const rp = config.rconControl.port;
    if (rp !== undefined && (rp < 1 || rp > 65535)) {
      throw new Error(`Invalid RCON_PORT: ${rp}. Must be 1-65535.`);
    }

    const { writeProtocol, writePort, writePasswordSecretVar, writeUser } = config.rconControl;
    if (writeProtocol !== undefined) {
      if (writePort !== undefined && (writePort < 1 || writePort > 65535)) {
        throw new Error(`Invalid RCON_WRITE_PORT: ${writePort}. Must be 1-65535.`);
      }
      // An authenticated write transport needs a credential. Like the primary check
      // above, the password must arrive as an ECS secret, not plaintext.
      if (!UNAUTHENTICATED_PROTOCOLS.includes(writeProtocol)) {
        const hasSecret =
          writePasswordSecretVar !== undefined &&
          config.secretRefs.some((r) => r.containerEnvVar === writePasswordSecretVar);
        if (!hasSecret) {
          throw new Error(
            `RCON_WRITE_PROTOCOL=${writeProtocol} needs its password in SECRET_REFS as ` +
              `"${writePasswordSecretVar ?? '<unset>'}", injected as an ECS secret. Set ` +
              `RCON_WRITE_PASSWORD_VAR to the SECRET_REFS entry that holds it.`,
          );
        }
        // Only uweb (HTTP Basic) also needs a username; the rcon-family transports are
        // password-only. The username is not a secret and rides as a plain env var.
        if (USER_PROTOCOLS.includes(writeProtocol) && !writeUser) {
          throw new Error(
            `RCON_WRITE_PROTOCOL=${writeProtocol} authenticates with a username as well as ` +
              `a password, so it needs a username. Set RCON_WRITE_USER.`,
          );
        }
      }
    }
  }

  const { queryPort, queryTimeoutSeconds } = config.idleShutdown;
  if (queryPort !== undefined && (queryPort < 1 || queryPort > 65535)) {
    throw new Error(`Invalid IDLE_QUERY_PORT: ${queryPort}. Must be 1-65535.`);
  }
  if (queryTimeoutSeconds <= 0) {
    throw new Error(
      `Invalid IDLE_QUERY_TIMEOUT_SECONDS: ${queryTimeoutSeconds}. Must be > 0.`,
    );
  }

  if (config.scaling.enableAutoScaling) {
    if (config.scaling.minCapacity > config.scaling.maxCapacity) {
      throw new Error(
        `Auto-scaling minCapacity (${config.scaling.minCapacity}) must be <= maxCapacity (${config.scaling.maxCapacity}).`,
      );
    }
  }
}

/** Reads a `.env` file into a plain object, or {} if it does not exist. */
function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return parseDotenv(Buffer.from(fs.readFileSync(filePath, 'utf-8')));
}

export function loadConfig(
  servicePath: string,
  environment: Environment,
  baseEnvPaths?: string | readonly string[],
): GameServerConfig {
  // Env files layer, lowest precedence first, with the service's own `.env` last and
  // always winning. `baseEnvPaths` is that lower stack, in ascending precedence:
  //
  //   <workspace>/.env.defaults   fleet-wide defaults (AWS account/region/profile)
  //   apps/<project>/.env         shared across a project's variants
  //   apps/<...>/<service>/.env   the service itself — always wins
  //
  // A single string is still accepted for the common two-layer variant case.
  // `servicePath` stays the service dir, so SERVICE_NAME, DOCKERFILE_PATH, SECRET_REFS
  // and GAME_ENV_* all resolve per service rather than being inherited by accident.
  const bases =
    baseEnvPaths === undefined
      ? []
      : typeof baseEnvPaths === 'string'
        ? [baseEnvPaths]
        : baseEnvPaths;
  const env: Record<string, string> = {};
  for (const basePath of bases) Object.assign(env, readEnvFile(basePath));
  Object.assign(env, readEnvFile(path.join(servicePath, '.env')));

  const serviceName =
    env['SERVICE_NAME'] || path.basename(servicePath);

  const config: GameServerConfig = {
    serviceName,
    serviceDisplayName:
      env['SERVICE_DISPLAY_NAME'] || serviceName,
    environment,

    container: {
      cpu: parseNumber(env['CPU']) ?? DEFAULT_CONTAINER.cpu,
      memory: parseNumber(env['MEMORY']) ?? DEFAULT_CONTAINER.memory,
      command: parseCommand(env['CONTAINER_COMMAND']),
    },

    networking: {
      containerPort:
        parseNumber(env['CONTAINER_PORT']) ??
        DEFAULT_NETWORKING.containerPort,
      hostPort:
        parseNumber(env['HOST_PORT']) ?? DEFAULT_NETWORKING.hostPort,
      protocol:
        parseProtocol(env['PROTOCOL']) ?? DEFAULT_NETWORKING.protocol,
      additionalPorts: parseAdditionalPorts(env['ADDITIONAL_PORTS']),
      internalPorts: parseAdditionalPorts(env['INTERNAL_PORTS']),
      enablePublicAccess:
        parseBoolean(env['ENABLE_PUBLIC_ACCESS']) ??
        DEFAULT_NETWORKING.enablePublicAccess,
    },

    scaling: {
      desiredCount:
        parseNumber(env['DESIRED_COUNT']) ??
        DEFAULT_SCALING.desiredCount,
      enableAutoScaling:
        parseBoolean(env['ENABLE_AUTOSCALING']) ??
        DEFAULT_SCALING.enableAutoScaling,
      minCapacity:
        parseNumber(env['MIN_CAPACITY']) ??
        DEFAULT_SCALING.minCapacity,
      maxCapacity:
        parseNumber(env['MAX_CAPACITY']) ??
        DEFAULT_SCALING.maxCapacity,
      autoScaleCpuTarget:
        parseNumber(env['AUTOSCALE_CPU_TARGET']) ??
        DEFAULT_SCALING.autoScaleCpuTarget,
    },

    image: {
      imageUri: env['IMAGE_URI'] || undefined,
      dockerfilePath:
        env['DOCKERFILE_PATH'] || DEFAULT_IMAGE.dockerfilePath,
    },

    logging: {
      retentionDays:
        parseNumber(env['LOG_RETENTION_DAYS']) ??
        DEFAULT_LOGGING.retentionDays,
    },

    cost: {
      useFargateSpot:
        parseBoolean(env['USE_FARGATE_SPOT']) ??
        DEFAULT_COST.useFargateSpot,
    },

    ecr: {
      maxImageCount:
        parseNumber(env['ECR_MAX_IMAGE_COUNT']) ??
        DEFAULT_ECR.maxImageCount,
    },

    healthCheck: {
      path: env['HEALTH_CHECK_PATH'] || undefined,
      port: parseNumber(env['HEALTH_CHECK_PORT']),
      intervalSeconds:
        parseNumber(env['HEALTH_CHECK_INTERVAL_SECONDS']) ??
        DEFAULT_HEALTH_CHECK.intervalSeconds,
      timeoutSeconds:
        parseNumber(env['HEALTH_CHECK_TIMEOUT_SECONDS']) ??
        DEFAULT_HEALTH_CHECK.timeoutSeconds,
    },

    idleShutdown: {
      enabled:
        parseBoolean(env['ENABLE_IDLE_SHUTDOWN']) ??
        DEFAULT_IDLE_SHUTDOWN.enabled,
      timeoutMinutes:
        parseNumber(env['IDLE_TIMEOUT_MINUTES']) ??
        DEFAULT_IDLE_SHUTDOWN.timeoutMinutes,
      checkIntervalSeconds:
        parseNumber(env['IDLE_CHECK_INTERVAL_SECONDS']) ??
        DEFAULT_IDLE_SHUTDOWN.checkIntervalSeconds,
      checkMethod:
        parseCheckMethod(env['IDLE_CHECK_METHOD']) ??
        DEFAULT_IDLE_SHUTDOWN.checkMethod,
      statusEndpoint: env['IDLE_STATUS_ENDPOINT'] || undefined,
      queryPort: parseNumber(env['IDLE_QUERY_PORT']),
      queryTimeoutSeconds:
        parseNumber(env['IDLE_QUERY_TIMEOUT_SECONDS']) ??
        DEFAULT_IDLE_SHUTDOWN.queryTimeoutSeconds,
    },

    redis: {
      enabled:
        parseBoolean(env['ENABLE_REDIS_SIDECAR']) ??
        DEFAULT_REDIS.enabled,
    },

    mysql: {
      enabled:
        parseBoolean(env['ENABLE_MYSQL_SIDECAR']) ?? DEFAULT_MYSQL.enabled,
      database: env['MYSQL_DATABASE'] ?? DEFAULT_MYSQL.database,
      rootPasswordVar:
        env['MYSQL_ROOT_PASSWORD_VAR'] ?? DEFAULT_MYSQL.rootPasswordVar,
      ...(env['MYSQL_BACKUP_S3_URI']
        ? { backupS3Uri: env['MYSQL_BACKUP_S3_URI'] }
        : {}),
      backupIntervalSeconds:
        parseNumber(env['MYSQL_BACKUP_INTERVAL_SECONDS']) ??
        DEFAULT_MYSQL.backupIntervalSeconds,
    },

    rconControl: {
      enabled:
        parseBoolean(env['ENABLE_RCON_CONTROL']) ??
        DEFAULT_RCON_CONTROL.enabled,
      protocol: parseRconProtocol(env['RCON_PROTOCOL']) ?? DEFAULT_RCON_CONTROL.protocol,
      passwordSecretVar:
        env['RCON_PASSWORD_VAR'] || DEFAULT_RCON_CONTROL.passwordSecretVar,
      port: parseNumber(env['RCON_PORT']),
      writeProtocol: parseRconProtocol(env['RCON_WRITE_PROTOCOL'], 'RCON_WRITE_PROTOCOL'),
      writePort: parseNumber(env['RCON_WRITE_PORT']),
      writePasswordSecretVar: env['RCON_WRITE_PASSWORD_VAR'] || undefined,
      writeUser: env['RCON_WRITE_USER'] || undefined,
    },

    persistentStorage: {
      enabled:
        parseBoolean(env['ENABLE_PERSISTENT_STORAGE']) ??
        DEFAULT_PERSISTENT_STORAGE.enabled,
      mountPath:
        env['PERSISTENT_MOUNT_PATH'] || DEFAULT_PERSISTENT_STORAGE.mountPath,
    },

    worldSync: {
      enabled:
        parseBoolean(env['ENABLE_WORLD_SYNC']) ?? DEFAULT_WORLD_SYNC.enabled,
      s3Prefix: env['WORLD_SYNC_S3_PREFIX'] || undefined,
      // ONLY the explicit override. The usual source is the game's own WORLD_NAME, but
      // that is resolved at synth time by resolveWorldName() rather than baked in here,
      // because a deploy-time prompt rewrites gameEnvVars AFTER the config is loaded —
      // see the note on resolveWorldName.
      worldName: env['WORLD_SYNC_NAME'] || undefined,
      worldSubdir:
        env['WORLD_SYNC_SUBDIR'] || DEFAULT_WORLD_SYNC.worldSubdir,
      syncIntervalSeconds:
        parseNumber(env['WORLD_SYNC_INTERVAL_SECONDS']) ??
        DEFAULT_WORLD_SYNC.syncIntervalSeconds,
      seedForce:
        parseBoolean(env['WORLD_SYNC_SEED_FORCE']) ?? DEFAULT_WORLD_SYNC.seedForce,
      flavor: parseWorldFlavor(env['WORLD_FLAVOR']),
      pluginSource: env['WORLD_SYNC_PLUGIN_SOURCE'] || undefined,
      allowCreate:
        parseBoolean(env['WORLD_ALLOW_CREATE']) ?? DEFAULT_WORLD_SYNC.allowCreate,
    },

    secretRefs: parseSecretRefs(env['SECRET_REFS']),
    deployPrompts: parseDeployPrompts(env['DEPLOY_PROMPTS']),
    gameEnvVars: parseGameEnvVars(env),
    requiredEnvVars: parseRequiredEnvVars(env['REQUIRED_ENV_VARS']),
    updateChecks: parseUpdateChecks(env['UPDATE_CHECK']),

    aws: {
      accountId: env['AWS_ACCOUNT_ID'] || undefined,
      region: env['AWS_REGION'] || DEFAULT_AWS.region,
      profile: env['AWS_PROFILE'] || undefined,
    },

    tags: {},
  };

  // Apply environment overrides
  const overrides = ENVIRONMENT_OVERRIDES[environment];
  if (overrides.logging) {
    config.logging = { ...config.logging, ...overrides.logging };
  }
  if (overrides.cost) {
    config.cost = { ...config.cost, ...overrides.cost };
  }
  if (overrides.scaling) {
    config.scaling = { ...config.scaling, ...overrides.scaling };
  }

  // Apply default tags
  config.tags = defaultTags(environment, serviceName);

  validate(config);

  return config;
}
