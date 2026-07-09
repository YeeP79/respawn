import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type {
  AdditionalPort,
  DeployPrompt,
  Environment,
  GameServerConfig,
  SecretRef,
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
): 'netstat' | 'http' | undefined {
  if (value === undefined || value === '') return undefined;
  const lower = value.toLowerCase();
  if (lower === 'netstat' || lower === 'http') return lower;
  return undefined;
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

  if (config.scaling.enableAutoScaling) {
    if (config.scaling.minCapacity > config.scaling.maxCapacity) {
      throw new Error(
        `Auto-scaling minCapacity (${config.scaling.minCapacity}) must be <= maxCapacity (${config.scaling.maxCapacity}).`,
      );
    }
  }
}

export function loadConfig(
  servicePath: string,
  environment: Environment,
): GameServerConfig {
  const envFilePath = path.join(servicePath, '.env');
  let env: Record<string, string> = {};

  if (fs.existsSync(envFilePath)) {
    const content = fs.readFileSync(envFilePath, 'utf-8');
    env = parseDotenv(Buffer.from(content));
  }

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
    },

    redis: {
      enabled:
        parseBoolean(env['ENABLE_REDIS_SIDECAR']) ??
        DEFAULT_REDIS.enabled,
    },

    persistentStorage: {
      enabled:
        parseBoolean(env['ENABLE_PERSISTENT_STORAGE']) ??
        DEFAULT_PERSISTENT_STORAGE.enabled,
      mountPath:
        env['PERSISTENT_MOUNT_PATH'] || DEFAULT_PERSISTENT_STORAGE.mountPath,
    },

    secretRefs: parseSecretRefs(env['SECRET_REFS']),
    deployPrompts: parseDeployPrompts(env['DEPLOY_PROMPTS']),
    gameEnvVars: parseGameEnvVars(env),
    requiredEnvVars: parseRequiredEnvVars(env['REQUIRED_ENV_VARS']),

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
