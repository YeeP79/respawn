#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { discoverRconServers, RCON_CONTAINER_NAME } from './discovery.js';
import {
  execInfo,
  execPython,
  execRcon,
  type ExecTarget,
  type RconResult,
} from './exec.js';
import {
  clampSample,
  manifestSummary,
  parseTransportInfo,
  summariseSamples,
  type SamplePoint,
  type TransportReport,
} from './introspection.js';
import {
  CONTAINER_STATS_PROBE,
  explainExit,
  fetchHealth,
  fetchLogs,
  fetchMetrics,
  isUnlimited,
  formatLimit,
  sparkline,
  parseContainerStats,
  percentToMiB,
  toMiB,
} from './monitoring.js';
import {
  getManifest,
  manifestedServices,
  resolveCapabilities,
  resolveFamilies,
  formatFamilies,
  type ServiceFamilies,
} from './capabilities.js';
import { resolveCvarCommand, resolveWireCommand } from './manifest.js';
import { readInstalledPackages, requirementsMet } from './mods.js';
import { runQuery } from './query-engine.js';
import { readLibrary, inGameDays, divergence, unmoddedOutlook, type LibraryWorld } from './worlds.js';
import {
  parseTravelContext,
  applyMutatorChanges,
  buildTravelCommand,
  unknownMutators,
} from './mutators.js';
import {
  discoverServices,
  synth as coreSynth,
  diff as coreDiff,
  updates as coreUpdates,
  deploy as coreDeploy,
  push as corePush,
  destroy as coreDestroy,
  scale as coreScale,
  secretExists,
  readSecret,
  setSecret,
  type ActionResult,
  type DiscoveredService,
  type Environment,
} from '@respawn/core';

/**
 * Fills a command template's `{name}` placeholders from args.
 *
 * @throws When the template needs a placeholder the caller did not supply, so a
 *   half-formed rcon command is never sent.
 */
function fillTemplate(template: string, args: Record<string, string>): string {
  const missing: string[] = [];
  const filled = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (args[key] === undefined) {
      missing.push(key);
      return '';
    }
    return args[key];
  });
  if (missing.length > 0) {
    throw new Error(`Missing argument(s): ${missing.join(', ')}.`);
  }
  return filled;
}

const REGION = process.env['RESPAWN_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1';
const PROFILE = process.env['RESPAWN_PROFILE'] ?? process.env['AWS_PROFILE'];

const awsOpts = { region: REGION, profile: PROFILE };

// Lifecycle tools (deploy/destroy/synth/...) read the repo — Dockerfiles, .env files,
// the CDK app — unlike the control tools, which only need AWS. The repo root defaults
// to cwd; set RESPAWN_WORKSPACE_ROOT when the MCP runs outside it. Every mutating action
// is gated off by default, so an LLM cannot deploy, scale or tear down unless asked to.
const WORKSPACE_ROOT = process.env['RESPAWN_WORKSPACE_ROOT'] ?? process.cwd();
// Three tiers rather than one flag, because the actions differ enormously in blast
// radius and were previously all-or-nothing. Waking a server to play is the thing you
// want constantly and can undo in one call; tearing a stack down is neither. Gating them
// together meant enabling the routine case also handed out the irreversible one.
//
//   RESPAWN_ALLOW_SCALE    scale only — wake/sleep. Reversible, the common case.
//   RESPAWN_ALLOW_DEPLOYS  deploy + push, and implies scale (a deploy already replaces
//                          the running task, so withholding scale from it buys nothing).
//   RESPAWN_ALLOW_DESTROY  destroy. Deliberately NOT implied by the above.
const DEPLOYS_ALLOWED = process.env['RESPAWN_ALLOW_DEPLOYS'] === 'true';
const SCALE_ALLOWED = DEPLOYS_ALLOWED || process.env['RESPAWN_ALLOW_SCALE'] === 'true';
const DESTROY_ALLOWED = process.env['RESPAWN_ALLOW_DESTROY'] === 'true';
/** Secrets are written, never read back, unless this is set. See generate_secret. */
const SECRET_WRITES_ALLOWED = process.env['RESPAWN_ALLOW_SECRET_WRITES'] === 'true';
// Reading a secret VALUE gets its own gate rather than reusing the write one. Write
// access does not imply read access here: generate_secret mints a random value and does
// not return it, so someone holding it can replace a secret but cannot learn the one
// already stored. Folding disclosure into the write gate would quietly grant a
// capability nobody chose.
const SECRET_REVEAL_ALLOWED = process.env['RESPAWN_ALLOW_SECRET_REVEAL'] === 'true';

/** Zod schema for the deploy environment, shared by the lifecycle tools. */
const environmentSchema = z
  .enum(['dev', 'staging', 'prod'])
  .default('dev')
  .describe('Target environment (default dev)');

/**
 * Resolves a repo-configured service (filesystem discovery — includes scaled-to-zero
 * and every variant), distinct from discoverRconServers which only finds running tasks.
 *
 * @throws When the service is not found under the workspace root.
 */
function resolveConfiguredService(service: string, environment: Environment): DiscoveredService {
  const match = discoverServices(WORKSPACE_ROOT, environment).find((s) => s.name === service);
  if (!match) {
    const known = discoverServices(WORKSPACE_ROOT, environment).map((s) => s.name).join(', ') || '(none)';
    throw new Error(
      `No configured service "${service}" under ${WORKSPACE_ROOT}. Known: ${known}. ` +
        `Set RESPAWN_WORKSPACE_ROOT to the repo root if the MCP runs elsewhere.`,
    );
  }
  return match;
}

/** Formats an action's ActionResult as a tool reply, marking failure. */
function actionResult(result: ActionResult) {
  return textResult(
    `${result.success ? '✓' : '✗'} ${result.serviceName} ${result.action}: ${result.message}`,
    !result.success,
  );
}

/** A service's tool families, with content tooling resolved off the filesystem. */
function familiesFor(svc: DiscoveredService): ServiceFamilies {
  return resolveFamilies(
    svc.name,
    svc.config,
    resolveServiceScript(svc.path, 'check-content') !== null,
    svc.path,
  );
}

/** Base context shared by every lifecycle action. */
function actionContext(service: DiscoveredService, environment: Environment) {
  return {
    service,
    environment,
    workspaceRoot: WORKSPACE_ROOT,
    ...(PROFILE ? { profile: PROFILE } : {}),
  };
}

/** Resolves a service to its running task, or undefined if it is not up. */
async function findTarget(service: string): Promise<ExecTarget | undefined> {
  const servers = await discoverRconServers(awsOpts);
  const match = servers.find((s) => s.service === service);
  if (!match) return undefined;
  return {
    cluster: match.cluster,
    task: match.task,
    container: RCON_CONTAINER_NAME,
    ...awsOpts,
  };
}

/** Like findTarget, but throws a helpful message when the server is not running. */
async function resolveTarget(service: string): Promise<ExecTarget> {
  const target = await findTarget(service);
  if (!target) {
    const servers = await discoverRconServers(awsOpts);
    const available = servers.map((s) => s.service).join(', ') || '(none running)';
    throw new Error(
      `No running rcon-capable server named "${service}". Available: ${available}. ` +
        `A scaled-to-zero server has no task to control — deploy or wake it first.`,
    );
  }
  return target;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

/** Runs a command and formats the reply, turning a non-zero rcon exit into an error. */
async function runAndFormat(service: string, command: string, opts: { write?: boolean } = {}) {
  const target = await resolveTarget(service);
  const result: RconResult = await execRcon(target, command, undefined, opts);
  if (result.exitCode !== 0) {
    return textResult(
      `rcon failed (exit ${result.exitCode}) on ${service}:\n${result.output || '(no output)'}`,
      true,
    );
  }
  return textResult(result.output || '(no output)');
}


/**
 * Runs a content script a service ships in its own `scripts/` dir.
 *
 * Deliberately generic: the MCP does not know what a map is, only that a service may
 * declare `scripts/<name>.sh` — the same "run what it declares" rule the rcon manifests
 * follow. A service without the script gets a clear answer rather than a stack trace.
 *
 * Output is returned VERBATIM. These scripts already explain their own failures and
 * name the fix; re-wording them here would mean two descriptions of the same failure
 * drifting apart.
 */
/**
 * A service's script, from its own `scripts/` dir or — for a variant — its project's.
 *
 * Variants of one project usually share tooling: apps/valheim's world scripts are
 * identical for every variant and take the variant as an argument, so
 * duplicating them per variant would mean two copies drifting apart. Falls back rather
 * than replacing, so a variant can still override with its own copy.
 */
function resolveServiceScript(servicePath: string, scriptName: string): string | null {
  const own = path.join(servicePath, 'scripts', `${scriptName}.sh`);
  if (fs.existsSync(own)) return own;
  // <project>/variants/<variant> -> <project>
  const shared = path.join(servicePath, '..', '..', 'scripts', `${scriptName}.sh`);
  return fs.existsSync(shared) ? shared : null;
}

/** The variant segment of a service path, or null for a flat project. */
function variantOf(servicePath: string): string | null {
  const parts = servicePath.split(path.sep);
  return parts.length >= 2 && parts[parts.length - 2] === 'variants'
    ? parts[parts.length - 1]!
    : null;
}

/**
 * Runs one of the shared world-save scripts for a variant service.
 *
 * Every one of them takes the VARIANT first — the save library, the S3 prefix and the
 * modded/vanilla flavor are all per-variant, and a service that is not a variant has no
 * world library at all, so that is an error rather than a default.
 */
async function runWorldScript(
  svc: DiscoveredService,
  scriptName: string,
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  const variant = variantOf(svc.path);
  if (!variant) {
    return {
      exitCode: 127,
      output:
        `${svc.name} is not a variant service, so it has no per-variant world library. ` +
        `World tooling lives at apps/<project>/scripts and is addressed by variant.`,
    };
  }
  return runContentScript(svc.path, scriptName, [variant, ...args]);
}

async function runContentScript(
  servicePath: string,
  scriptName: string,
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  const script = resolveServiceScript(servicePath, scriptName);
  if (!script) {
    return {
      exitCode: 127,
      output:
        `This service ships no scripts/${scriptName}.sh. Content tooling is per-service; ` +
        `only services with a custom content payload (see apps/tfc/variants/modded) have it.`,
    };
  }
  return new Promise((resolve) => {
    const child = spawn('bash', [script, ...args], {
      cwd: WORKSPACE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, output: out }));
    child.on('error', (err) => resolve({ exitCode: 1, output: err.message }));
  });
}

/** Bucket from an explicit arg, else parsed out of the service's FASTDL_URL. */
function resolveBucket(explicit: string | undefined, gameEnv: Record<string, string>): string | null {
  if (explicit) return explicit;
  const url = gameEnv['FASTDL_URL'];
  if (!url) return null;
  const m = /^https?:\/\/([^.]+)\.s3[.-]/.exec(url);
  return m?.[1] ?? null;
}

const server = new McpServer({ name: 'respawn-rcon', version: '0.1.0' });

server.registerTool(
  'list_servers',
  {
    title: 'List servers',
    description:
      'List Respawn game servers that are running and controllable via rcon. ' +
      'A server scaled to zero will not appear.',
    inputSchema: {},
  },
  async () => {
    const servers = await discoverRconServers(awsOpts);
    if (servers.length === 0) {
      return textResult('No running rcon-capable servers.');
    }
    const lines = servers.map((s) => `- ${s.service}  (cluster ${s.cluster})`);
    return textResult(`Controllable servers:\n${lines.join('\n')}`);
  },
);

server.registerTool(
  'get_server_options',
  {
    title: 'Get server options',
    description:
      'List everything you can do to a server: its commands (including mod-added ' +
      'ones), tunable cvars with valid ranges, and its maps. Call this before ' +
      'changing settings so you use valid values. Maps marked "live" are read ' +
      'from the running server.',
    inputSchema: { service: z.string().describe('Service name, e.g. "cs16"') },
  },
  async ({ service }) => {
    if (!getManifest(service)) {
      // Deliberately NOT an error. Nothing is broken: `valheim` has no remote console at
      // all, so "no manifest" there is a category fact about the game, not a missing
      // file. Returning isError made a fully working service read as misconfigured, and
      // sent the reader looking for a manifest to write that could never help.
      const svc = resolveConfiguredService(service, 'dev');
      const f = familiesFor(svc);
      return textResult(
        `${service} (${f.displayName}) — no rcon manifest, so the command/cvar tools ` +
          `have nothing to resolve.\n\nWhat applies to this service:\n${formatFamilies(f)}\n\n` +
          `Services shipping a manifest: ${manifestedServices().join(', ') || '(none)'}.`,
      );
    }
    // A running target lets us fill in live maps; absence is fine (degrades).
    const target = await findTarget(service);
    const caps = await resolveCapabilities(service, target, resolveConfiguredService(service, 'dev').path);
    // The family summary goes on BOTH branches. It used to exist only where a manifest
    // was missing, so the services with the richest surface were the ones told least
    // about it — a manifested service never learned that world saves or secrets applied.
    const f = familiesFor(resolveConfiguredService(service, 'dev'));
    return textResult(
      `${service} (${f.displayName}) — tool families:\n${formatFamilies(f)}\n\n` +
        `Command/cvar detail:\n${JSON.stringify(caps, null, 2)}`,
    );
  },
);

server.registerResource(
  'server-capabilities',
  new ResourceTemplate('respawn://{service}/capabilities', {
    list: async () => ({
      resources: manifestedServices().map((service) => ({
        uri: `respawn://${service}/capabilities`,
        name: `${service} options`,
        description: `Commands, cvars and maps available on ${service}`,
        mimeType: 'application/json',
      })),
    }),
  }),
  {
    title: 'Server capabilities',
    description: 'What each server lets you change, as JSON.',
  },
  async (uri, { service }) => {
    const name = Array.isArray(service) ? service[0]! : service;
    const target = await findTarget(name);
    const caps = await resolveCapabilities(name, target);
    if (!caps) {
      throw new Error(`No options manifest for "${name}".`);
    }
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(caps, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  'run_command',
  {
    title: 'Run a server command',
    description:
      'Run one of a server\'s declared commands (from get_server_options) — ' +
      'change_map, kick_player, mod commands, and so on. Pass args by name. The ' +
      'command list is game-specific and comes from the server\'s manifest, not ' +
      'this tool.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "cs16"'),
      command: z.string().describe('Command name from get_server_options'),
      args: z
        .record(z.string())
        .optional()
        .describe('Argument values by name, e.g. { "map": "de_nuke" }'),
    },
  },
  async ({ service, command, args }) => {
    const manifest = getManifest(service);
    const def = manifest?.commands.find((c) => c.name === command);
    if (!def) {
      const names = manifest?.commands.map((c) => c.name).join(', ') || '(none)';
      return textResult(
        `No command "${command}" for ${service}. Available: ${names}.`,
        true,
      );
    }
    // Declared in the manifest but not installed on THIS variant. Without this the call
    // would reach the console and come back "Command 'x' executed." — Valheim's
    // consoleCommand reports that for a command that does not exist just as readily as
    // for one that ran, so the failure would be silent and read as success.
    const gate = requirementsMet(def, readInstalledPackages(resolveConfiguredService(service, 'dev').path));
    if (!gate.met) {
      // Must NOT reuse requirementsMet here. Its unknown-is-available fallback is right for
      // the gate (a service with no mods.lock must not lose its command surface) and wrong
      // for this suggestion: every non-Valheim service returns null and would be listed as
      // "carrying" a Valheim mod. A carrier is a service that demonstrably HAS the package.
      const carriers = manifestedServices().filter((other) => {
        try {
          const packages = readInstalledPackages(resolveConfiguredService(other, 'dev').path);
          return packages !== null && (def.requires ?? []).every((pkg) => packages.has(pkg));
        } catch {
          return false;
        }
      });
      return textResult(
        `"${command}" is declared for ${service} but this server does not carry ` +
          `${gate.missing.join(', ')}, so the command does not exist on it. ` +
          `Valheim's consoleCommand answers "executed" either way, so calling it would ` +
          `look like it worked.\n\n` +
          `Servers that do carry it: ${carriers.join(', ') || '(none configured)'}.`,
        true,
      );
    }
    let rcon: string;
    try {
      rcon = fillTemplate(def.rcon, args ?? {});
    } catch (err) {
      return textResult((err as Error).message, true);
    }
    // Commands change state → the write transport (RCON_WRITE_*), which for UT99 is
    // the authenticated uweb admin console rather than the read-only gamespy port.
    return runAndFormat(service, rcon, { write: true });
  },
);

server.registerTool(
  'check_secrets',
  {
    title: 'Check secrets exist',
    description:
      "Report which of a service's SECRET_REFS already exist in Secrets Manager / SSM, " +
      'and which are missing. Read-only: it never returns a secret VALUE, only whether ' +
      'each one is present. Run this before a first deploy — ECS resolves secrets before ' +
      'the container starts, so a missing one fails the task after a full deploy. Secrets ' +
      'live per account AND per region, so moving a service leaves them behind.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "ut99"'),
      environment: environmentSchema,
    },
  },
  async ({ service, environment }) => {
    const config = resolveConfiguredService(service, environment).config;
    const region = config.aws.region ?? REGION;
    const refs = config.secretRefs;
    if (refs.length === 0) return textResult(`${service} declares no SECRET_REFS.`);

    const checked = await Promise.all(
      refs.map(async (ref) => ({
        ref,
        exists: await secretExists({
          store: ref.store,
          sourceId: ref.sourceId,
          region,
          ...(PROFILE ? { profile: PROFILE } : {}),
        }),
      })),
    );
    const missing = checked.filter((c) => !c.exists);
    const lines = [
      `${service} secrets in ${region} (account of profile ${PROFILE ?? '(default)'}):`,
      ...checked.map(
        ({ ref, exists }) =>
          `  ${exists ? '✓' : '✗'} ${ref.containerEnvVar} -> ${ref.store}:${ref.sourceId}`,
      ),
    ];
    if (missing.length > 0) {
      lines.push(
        '',
        `${missing.length} missing — a deploy would fail preflight. Create each with ` +
          'generate_secret, or the Secrets CLI action if you need a specific value.',
      );
    }
    return textResult(lines.join('\n'), missing.length > 0);
  },
);

server.registerTool(
  'generate_secret',
  {
    title: 'Generate and store a secret',
    description:
      "Generate a strong random value for one of a service's SECRET_REFS and store it. " +
      'Generating server-side is deliberate: a tool that ACCEPTED a value would copy that ' +
      'plaintext into the conversation transcript, which is exactly what keeping secrets ' +
      'out of argv and task definitions is meant to prevent. The value is therefore not ' +
      'returned unless reveal=true, which you need for a password humans must type (a ' +
      'game join password) and should not use otherwise. Overwrites an existing value.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "ut99"'),
      secret: z
        .string()
        .describe('Container env var name from SECRET_REFS, e.g. "UT_GAMEPWD"'),
      environment: environmentSchema,
      length: z
        .number()
        .int()
        .min(8)
        .max(128)
        .default(24)
        .describe('Character count. Keep it typeable for a password players enter.'),
      reveal: z
        .boolean()
        .default(false)
        .describe('Return the value in the reply, putting it in the transcript. Opt-in.'),
    },
  },
  async ({ service, secret, environment, length, reveal }) => {
    if (!SECRET_WRITES_ALLOWED) {
      return textResult(
        'Secret writes are disabled. Set RESPAWN_ALLOW_SECRET_WRITES=true to enable ' +
          'generate_secret; check_secrets is read-only and always available.',
        true,
      );
    }
    const config = resolveConfiguredService(service, environment).config;
    const ref = config.secretRefs.find((r) => r.containerEnvVar === secret);
    if (!ref) {
      const known = config.secretRefs.map((r) => r.containerEnvVar).join(', ') || '(none)';
      return textResult(
        `${service} has no SECRET_REFS entry named "${secret}". Declared: ${known}. ` +
          'Add it to SECRET_REFS in the service .env first — this tool only fills in a ' +
          'secret the config already references.',
        true,
      );
    }

    // Alphanumeric only: these are typed by hand into a game console, where a symbol is
    // a support request. randomInt is rejection-sampled, so the distribution stays even.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const value = Array.from(
      { length },
      () => ALPHABET[randomInt(ALPHABET.length)]!,
    ).join('');

    const region = config.aws.region ?? REGION;
    await setSecret({
      store: ref.store,
      sourceId: ref.sourceId,
      value,
      region,
      ...(PROFILE ? { profile: PROFILE } : {}),
    });

    const lines = [
      `Stored ${ref.store}:${ref.sourceId} (${service}/${secret}) in ${region} — ${length} chars.`,
      reveal
        ? `  value: ${value}`
        : '  value withheld; pass reveal=true if a human needs to type it.',
      '  Takes effect on the next task start: ECS injects secrets at start, so a running',
      '  server keeps the old value until it is restarted.',
    ];
    return textResult(lines.join('\n'));
  },
);

server.registerTool(
  'set_mutators',
  {
    title: 'Turn mutators on or off',
    description:
      'Add or remove mutators on a running UE1 server (map voting, relics, and so on) ' +
      'without disturbing the current map, game type or match settings. Prefer this over ' +
      'hand-writing a servertravel: the mutator list is ABSOLUTE, so a travel that forgets ' +
      'a running mutator silently switches it off. Reloads the current map, which resets ' +
      'scores but keeps players connected. Use get_server_options to see each mod and its ' +
      'mutatorClass.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "ut99"'),
      add: z
        .array(z.string())
        .optional()
        .describe('Mutator CLASSES to enable, e.g. ["Relics.RelicSpeed"] (not package names)'),
      remove: z
        .array(z.string())
        .optional()
        .describe('Mutator classes to disable, matched case-insensitively'),
    },
  },
  async ({ service, add, remove }) => {
    if (!add?.length && !remove?.length) {
      return textResult('Nothing to do: pass add and/or remove.', true);
    }

    // The running set comes from the engine's own LoadMap line, not the `rules` query —
    // rules reports display names ("MapVote MVE2h"), which cannot be turned back into
    // the classes a travel needs.
    const { events } = await fetchLogs(service, awsOpts, {
      container: 'game-server',
      pattern: 'LoadMap',
      minutes: 1440,
      limit: 50,
    });
    const context = parseTravelContext(events.map((e) => e.message ?? ''));
    if (!context) {
      return textResult(
        `Could not read ${service}'s current map and mutators from its logs, so changing ` +
          `them would mean guessing — and a wrong guess silently drops whatever is running. ` +
          `Check the server is up (server_health) and has changed level at least once.`,
        true,
      );
    }

    const next = applyMutatorChanges(context.mutators, {
      ...(add ? { add } : {}),
      ...(remove ? { remove } : {}),
    });
    if (
      next.length === context.mutators.length &&
      next.every((m, i) => m === context.mutators[i])
    ) {
      return textResult(
        `No change: ${service} is already running exactly [${next.join(', ') || 'none'}].`,
      );
    }

    // A class the manifest does not know is not refused — a server may legitimately run
    // one — but it is called out, because a misspelled class produces NO error anywhere:
    // the console accepts it and the engine skips it.
    const known = (getManifest(service)?.modData as { mutatorClass?: string | null }[] | undefined)
      ?.map((m) => m.mutatorClass)
      .filter((c): c is string => typeof c === 'string' && c.length > 0);
    const unknown = known?.length ? unknownMutators(add ?? [], known) : [];

    const command = buildTravelCommand({
      map: context.map,
      gametype: context.gametype,
      mutators: next,
      extras: context.extras,
    });

    const target = await resolveTarget(service);
    const issuedAt = Date.now();
    const sent = await execRcon(target, command, undefined, { write: true });
    // A non-zero exit is a real dispatch failure and must not be reported as success.
    // It does NOT include the transport error a successful travel provokes while the
    // level reloads — rcon.py returns that as ordinary output, not a failure.
    if (sent.exitCode !== 0) {
      return textResult(
        `${service}: the travel was not accepted, so mutators are unchanged.\n` +
          `  command: ${command}\n  ${sent.output || '(no output)'}`,
        true,
      );
    }

    // Never report the rcon reply as the outcome: a travel that SUCCEEDS commonly answers
    // with a transport error, because the level change tears down the web admin while the
    // reply is being read. Confirm from the engine log instead — but only lines written
    // AFTER the travel was issued. A wider window picks up the PREVIOUS level's load and
    // "confirms" the mutator set we just replaced, which looks like the change silently
    // failed. CloudWatch also lags a few seconds behind the engine, so an empty result
    // here means "too early to tell", never "it did not work".
    const after = await fetchLogs(service, awsOpts, {
      container: 'game-server',
      pattern: 'Add mutator',
      minutes: 5,
      limit: 60,
    });
    const loaded = after.events
      .filter((e) => (e.timestamp ?? 0) >= issuedAt)
      .map((e) => /Add mutator\s+(\S+)/.exec(e.message ?? '')?.[1])
      .filter((c): c is string => Boolean(c));

    const lines = [
      `${service}: reloaded ${context.map} (${context.gametype}).`,
      `  was:  ${context.mutators.join(', ') || '(none)'}`,
      `  now:  ${next.join(', ') || '(none)'}`,
      loaded.length
        ? `  engine confirmed loading: ${[...new Set(loaded)].join(', ')}`
        : '  the travel was accepted, but the engine has not logged "Add mutator" yet — ' +
          'CloudWatch lags the server by a few seconds. Re-check with server_logs; do NOT ' +
          'reissue on the strength of this line.',
    ];
    if (unknown.length) {
      lines.push(
        `  WARNING: not in ${service}'s manifest: ${unknown.join(', ')}. A misspelled class ` +
          `fails silently, so verify it appears in the confirmed list above.`,
      );
    }
    return textResult(lines.join('\n'));
  },
);

server.registerTool(
  'query',
  {
    title: 'Query the server',
    description:
      'Run one of a server\'s declared queries (from get_server_options), e.g. ' +
      '"players", and get structured JSON back. How each query is parsed is ' +
      'defined per-game in the server\'s manifest, not in this tool.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "cs16"'),
      query: z.string().describe('Query name from get_server_options, e.g. "players"'),
    },
  },
  async ({ service, query }) => {
    const manifest = getManifest(service);
    const def = manifest?.queries.find((q) => q.name === query);
    if (!def) {
      const names = manifest?.queries.map((q) => q.name).join(', ') || '(none)';
      return textResult(
        `No query "${query}" for ${service}. Available: ${names}.`,
        true,
      );
    }
    const target = await resolveTarget(service);
    const result = await execRcon(target, def.rcon);
    if (result.exitCode !== 0) {
      return textResult(
        `rcon failed on ${service}:\n${result.output || '(no output)'}`,
        true,
      );
    }
    return textResult(JSON.stringify(runQuery(def, result.output), null, 2));
  },
);

server.registerTool(
  'set_cvar',
  {
    title: 'Set a cvar',
    description:
      'Set a console variable live, e.g. mp_friendlyfire 1. Check get_server_options ' +
      'for the documented cvars and their valid ranges first.',
    inputSchema: {
      service: z.string(),
      cvar: z.string().describe('Console variable name'),
      value: z.string().describe('New value'),
    },
  },
  async ({ service, cvar, value }) =>
    // A Quake-family console takes `<name> "<value>"`; a manifest may override per-cvar for
    // a console that works differently (UE1: `set <Package.Class> <Prop> <value>`).
    runAndFormat(service, resolveCvarCommand(getManifest(service), cvar, value), {
      write: true,
    }),
);

server.registerTool(
  'rcon',
  {
    title: 'Raw rcon command',
    description:
      'Run an arbitrary rcon command. Escape hatch for anything the declared ' +
      'commands do not cover; passed to the game verbatim. Defaults to the write ' +
      'transport (state-changing); set write=false to force the read transport, which ' +
      'only matters for a game with a separate read/write path (UT99: gamespy vs uweb).',
    inputSchema: {
      service: z.string(),
      command: z.string(),
      write: z
        .boolean()
        .optional()
        .describe('Use the write transport. Default true; false forces the read path.'),
    },
  },
  async ({ service, command, write }) => runAndFormat(service, command, { write: write ?? true }),
);

server.registerTool(
  'capture_raw',
  {
    title: 'Capture a raw reply',
    description:
      'Run a query and return the transport reply UNPARSED, before any protocol ' +
      'normalization. This is the tool for authoring or debugging a manifest against ' +
      'an unfamiliar server: see the real wire format, then write patterns for it. ' +
      'Works for every protocol; for one whose sidecar reshapes its output (e.g. ' +
      'UT99 GameSpy), this shows what the reshaping started from.',
    inputSchema: {
      service: z.string(),
      command: z
        .string()
        .describe(
          'A declared query name (e.g. "server_info") — resolved to its raw transport ' +
            'token via the manifest — or, for a server with no manifest, a raw token to ' +
            'send verbatim (e.g. gamespy "info"/"status", goldsrc "status").',
        ),
    },
  },
  async ({ service, command }) => {
    // A declared query name resolves to its wire token; anything else goes verbatim, so an
    // unfamiliar/manifest-less server can still be probed. See resolveWireCommand.
    const wire = resolveWireCommand(getManifest(service), command);
    const target = await resolveTarget(service);
    const result = await execRcon(target, wire, undefined, { raw: true });
    if (result.exitCode !== 0) {
      return textResult(`capture failed on ${service}:\n${result.output || '(no output)'}`, true);
    }
    return textResult(result.output || '(empty reply)');
  },
);

server.registerTool(
  'describe_transport',
  {
    title: 'Describe a server\'s control transport',
    description:
      'What the MCP can do to a server and how: the protocol and port its sidecar ' +
      'speaks (read live when running), plus the queries, commands and cvars its ' +
      'manifest declares. The manifest half works when the server is scaled to zero; ' +
      'the live half needs it running. Start here when a tool is not behaving.',
    inputSchema: { service: z.string() },
  },
  async ({ service }) => {
    const manifest = manifestSummary(getManifest(service));
    const report: TransportReport = { service, reachable: false };
    if (manifest) report.manifest = manifest;

    const target = await findTarget(service);
    if (!target) {
      report.note = 'server is not running; showing manifest-declared surface only.';
    } else {
      try {
        const info = await execInfo(target);
        if (info.exitCode === 0) {
          report.reachable = true;
          report.live = parseTransportInfo(info.output);
        } else {
          report.note = `sidecar --info failed:\n${info.output || '(no output)'}`;
        }
      } catch (err) {
        report.note = `could not reach the sidecar: ${(err as Error).message}`;
      }
    }
    if (!manifest && !report.reachable) {
      return textResult(
        `No manifest for "${service}" and it is not running. ` +
          `Servers with a manifest: ${manifestedServices().join(', ') || '(none)'}.`,
        true,
      );
    }
    return textResult(JSON.stringify(report, null, 2));
  },
);

server.registerTool(
  'sample',
  {
    title: 'Sample a query over time',
    description:
      'Run a declared query repeatedly and report how one field changes — the ' +
      'game-state counterpart to server_metrics. Use it to watch player count settle, ' +
      'ping drift, or a map rotate. Each sample is one ECS Exec session, so runs are ' +
      'capped and spaced; this call blocks for roughly count x interval seconds.',
    inputSchema: {
      service: z.string(),
      query: z.string().describe('Declared query name, e.g. "server_info"'),
      field: z
        .string()
        .describe('Field to track from the query result, e.g. "playerCount", or "rows" for its row count'),
      count: z.number().int().optional().describe('Samples to take (1-10, default 5)'),
      intervalSeconds: z.number().optional().describe('Seconds between samples (3-60, default 10)'),
    },
  },
  async ({ service, query, field, count, intervalSeconds }) => {
    const manifest = getManifest(service);
    const def = manifest?.queries.find((q) => q.name === query);
    if (!def) {
      const names = manifest?.queries.map((q) => q.name).join(', ') || '(none)';
      return textResult(`No query "${query}" for ${service}. Available: ${names}.`, true);
    }
    const bounds = clampSample(count ?? 5, intervalSeconds ?? 10);
    const target = await resolveTarget(service);

    const points: SamplePoint[] = [];
    for (let n = 1; n <= bounds.count; n++) {
      if (n > 1) await new Promise((r) => setTimeout(r, bounds.intervalSeconds * 1000));
      let value: string | null = null;
      try {
        const result = await execRcon(target, def.rcon);
        if (result.exitCode === 0) {
          const parsed = runQuery(def, result.output);
          const raw = field === 'rows' ? parsed.rows?.length : parsed[field];
          if (raw !== undefined && raw !== null) value = String(raw);
        }
      } catch {
        value = null;
      }
      points.push({ n, value });
    }

    const { distinct, misses } = summariseSamples(points);
    const report = {
      service,
      query,
      field,
      count: bounds.count,
      intervalSeconds: bounds.intervalSeconds,
      distinct,
      misses,
      points,
    };
    return textResult(JSON.stringify(report, null, 2));
  },
);

server.registerTool(
  'server_health',
  {
    title: 'Server health',
    description:
      'Infrastructure health of a game server: desired/running task counts, per-container ' +
      'state, ECS Exec agent status, recent stops with their exit codes explained, and ' +
      'recent service events. Works when the server is scaled to zero — use this to answer ' +
      '"is it running, and if not, why".',
    inputSchema: { service: z.string().describe('Service name, e.g. "doom2"') },
  },
  async ({ service }) => {
    const h = await fetchHealth(service, awsOpts);
    const lines: string[] = [
      `${h.service} (${h.cluster})`,
      `  desired=${h.desired} running=${h.running} pending=${h.pending}` +
        (h.rolloutState ? ` rollout=${h.rolloutState}` : ''),
    ];
    if (h.tasks.length === 0) {
      lines.push('  no running tasks (scaled to zero, or failing to start)');
    }
    for (const t of h.tasks) {
      lines.push(`  task ${t.id} ${t.status ?? '?'} (${t.taskDefinition}) started ${t.startedAt ?? '?'}`);
      for (const c of t.containers) {
        lines.push(`    ${c.name}: ${c.status ?? '?'}${c.execAgent ? ` execAgent=${c.execAgent}` : ''}`);
      }
    }
    if (h.recentStops.length > 0) {
      lines.push('  recent stops:');
      for (const s of h.recentStops) {
        lines.push(`    ${s.stoppedAt ?? '?'} [${s.stopCode ?? '?'}] ${s.reason ?? ''}`);
        for (const c of s.containers) {
          lines.push(`      ${c.name}: ${explainExit(c, s.stopCode)}`);
        }
      }
    }
    if (h.events.length > 0) {
      lines.push('  events:');
      for (const e of h.events) lines.push(`    ${e.at ?? ''} ${e.message ?? ''}`);
    }
    return textResult(lines.join('\n'));
  },
);

server.registerTool(
  'server_metrics',
  {
    title: 'Server metrics',
    description:
      'CloudWatch CPU and memory utilization for a game server over a time window, ' +
      'reported as both a percentage and absolute MiB. These are task-level totals ' +
      'across all containers — for a per-container breakdown use container_stats.',
    inputSchema: {
      service: z.string(),
      minutes: z.number().int().min(5).max(1440).optional().describe('Lookback window, default 60'),
      resolution: z
        .enum(['1m', '5m'])
        .optional()
        .describe('Datapoint period. 1m reveals short spikes a 5m average hides. Default 5m'),
      series: z
        .boolean()
        .optional()
        .describe('Include the per-datapoint timeline, not just avg/peak. Default true'),
    },
  },
  async ({ service, minutes, resolution, series }) => {
    const period = resolution === '1m' ? 60 : 300;
    const m = await fetchMetrics(service, minutes ?? 60, awsOpts, period);
    const showSeries = series ?? true;
    const lines = [
      `${m.service} — last ${m.minutes}m @ ${m.periodSeconds}s (task: ${m.taskCpuUnits ?? '?'} cpu / ${m.taskMemoryMiB ?? '?'} MiB)`,
    ];
    if (!m.cpu && !m.memory) {
      lines.push('  no datapoints — the service was scaled to zero for the whole window');
    }
    if (m.cpu) {
      lines.push(`  cpu:    avg ${m.cpu.average.toFixed(1)}%  peak ${m.cpu.maximum.toFixed(1)}%  ${sparkline(m.cpu.series.map((p) => p.maximum))}`);
    }
    if (m.memory) {
      const abs = m.taskMemoryMiB
        ? `  (avg ${percentToMiB(m.memory.average, m.taskMemoryMiB)} MiB, peak ${percentToMiB(m.memory.maximum, m.taskMemoryMiB)} MiB)`
        : '';
      lines.push(`  memory: avg ${m.memory.average.toFixed(1)}%  peak ${m.memory.maximum.toFixed(1)}%${abs}  ${sparkline(m.memory.series.map((p) => p.maximum))}`);
    }
    if (m.liveTasks) lines.push(`  tasks:  avg ${m.liveTasks.average.toFixed(2)}`);

    // CPUUtilization is a task-level metric: an ECS Exec session's own CPU lands in it.
    // Without the timeline you cannot tell the game from the observer.
    if (showSeries && m.cpu && m.cpu.series.length > 0) {
      lines.push('  cpu timeline (avg / peak):');
      for (const p of m.cpu.series) {
        lines.push(`    ${p.at}  ${p.average.toFixed(1).padStart(5)}% / ${p.maximum.toFixed(1).padStart(5)}%`);
      }
    }
    return textResult(lines.join('\n'));
  },
);

/**
 * Every log stream prefix the CDK constructs emit, so `server_logs` can filter to any
 * container the fleet actually runs.
 *
 * MUST track the `streamPrefix` values in apps/respawn/src/constructs/*.ts. A prefix
 * missing here is not a visible error — the container's logs are still IN the group, so
 * an unfiltered read shows them and only the filter is impossible. That is how
 * `world-sync` ended up unfilterable: the sidecar was added and this list was not, and
 * nothing failed to say so.
 */
const LOG_CONTAINERS = [
  'game-server',
  'rcon-control',
  'idle-shutdown',
  'world-sync',
  'mysql',
  'mysql-backup',
  'redis',
] as const;

server.registerTool(
  'server_logs',
  {
    title: 'Server logs',
    description:
      "Tail a game server's CloudWatch logs, optionally filtered to one container and a " +
      `search pattern. Containers: ${LOG_CONTAINERS.join(', ')} — only those a service ` +
      'actually runs will have streams. The companion to server_health when a task ' +
      'stopped and you need to know why.',
    inputSchema: {
      service: z.string(),
      container: z.enum(LOG_CONTAINERS).optional(),
      minutes: z.number().int().min(1).max(1440).optional().describe('Relative lookback, default 30'),
      since: z
        .string()
        .optional()
        .describe('Absolute window start, e.g. "2026-07-09T19:46:00Z". Overrides minutes.'),
      until: z.string().optional().describe('Absolute window end. Requires since; defaults to now.'),
      pattern: z.string().optional().describe('CloudWatch filter pattern, e.g. "ERROR"'),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ service, container, minutes, since, until, pattern, limit }) => {
    const { logGroup, events } = await fetchLogs(service, awsOpts, {
      ...(container !== undefined ? { container } : {}),
      ...(minutes !== undefined ? { minutes } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(pattern !== undefined ? { pattern } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (events.length === 0) return textResult(`No log events in ${logGroup} for that window.`);
    const lines = events.map((e) => {
      const when = e.timestamp ? new Date(e.timestamp).toISOString() : '?';
      const who = (e.logStreamName ?? '').split('/')[0] ?? '';
      return `${when} [${who}] ${e.message?.trimEnd() ?? ''}`;
    });
    return textResult(`${logGroup} (${events.length} events)\n${lines.join('\n')}`);
  },
);

server.registerTool(
  'container_stats',
  {
    title: 'Live per-container stats',
    description:
      'Live CPU and memory for each container in a running task, read from the ECS task ' +
      'metadata endpoint from inside the task. Reports rss (what a memory limit must cover) ' +
      'separately from usage (which counts page cache and expands to fill any limit). ' +
      'Requires a running task and costs one ECS Exec session.',
    inputSchema: { service: z.string() },
  },
  async ({ service }) => {
    const target = await resolveTarget(service);
    const result = await execPython(target, CONTAINER_STATS_PROBE);
    if (result.exitCode !== 0) {
      return textResult(`container stats probe failed (exit ${result.exitCode}):\n${result.output}`, true);
    }
    const stats = parseContainerStats(result.output);
    const lines = [`${service} — live per-container stats`];
    for (const c of stats) {
      const pct =
        typeof c.rssBytes === 'number' && !isUnlimited(c.limitBytes)
          ? ` (${((c.rssBytes / c.limitBytes!) * 100).toFixed(0)}% of limit)`
          : '';
      lines.push(
        `  ${c.name}: cpu ${c.cpuPercent ?? '?'}%  rss ${toMiB(c.rssBytes)}${pct}  ` +
          `cache ${toMiB(c.cacheBytes)}  usage ${toMiB(c.usageBytes)}  limit ${formatLimit(c.limitBytes)}`,
      );
    }
    return textResult(lines.join('\n'));
  },
);

// --- Lifecycle tools: the CLI's deploy pipeline, exposed over MCP ------------
// Read/preview actions are ungated; mutating ones require RESPAWN_ALLOW_DEPLOYS, and
// destroy additionally requires typing the service name to confirm.

server.registerTool(
  'synth',
  {
    title: 'Synthesize CloudFormation',
    description:
      'Preview the CloudFormation a service would deploy — no changes made. Reads the ' +
      'repo (set RESPAWN_WORKSPACE_ROOT if the MCP runs outside it).',
    inputSchema: { service: z.string(), environment: environmentSchema },
  },
  async ({ service, environment }) =>
    actionResult(await coreSynth(actionContext(resolveConfiguredService(service, environment), environment))),
);

server.registerTool(
  'diff',
  {
    title: 'Diff infrastructure',
    description: 'Show the pending CloudFormation changes for a service (no changes made).',
    inputSchema: { service: z.string(), environment: environmentSchema },
  },
  async ({ service, environment }) =>
    actionResult(await coreDiff(actionContext(resolveConfiguredService(service, environment), environment))),
);

server.registerTool(
  'check_updates',
  {
    title: 'Check for updates',
    description:
      'Check whether a service has an upstream image / game update available, against the ' +
      'last recorded deploy baseline. Read-only (does not record a new baseline).',
    inputSchema: { service: z.string(), environment: environmentSchema },
  },
  async ({ service, environment }) =>
    actionResult(
      await coreUpdates({ ...actionContext(resolveConfiguredService(service, environment), environment), record: false }),
    ),
);

server.registerTool(
  'deploy',
  {
    title: 'Deploy a server',
    description:
      'Build/push the image if needed and deploy the service via CDK. DESTRUCTIVE-ish ' +
      '(changes live infrastructure) — disabled unless RESPAWN_ALLOW_DEPLOYS=true, which ' +
      'covers deploy and push but NOT destroy. Ensure required secrets exist first: they ' +
      'are preflighted, and check_secrets reports them without deploying.',
    inputSchema: { service: z.string(), environment: environmentSchema },
  },
  async ({ service, environment }) => {
    if (!DEPLOYS_ALLOWED) {
      return textResult('Deploys are disabled. Set RESPAWN_ALLOW_DEPLOYS=true to enable deploy and push.', true);
    }
    return actionResult(
      await coreDeploy({
        ...actionContext(resolveConfiguredService(service, environment), environment),
        requireApproval: 'never',
      }),
    );
  },
);

server.registerTool(
  'push',
  {
    title: 'Build & push image',
    description:
      'Build and push a service image to ECR without deploying. Requires Docker and ' +
      'RESPAWN_ALLOW_DEPLOYS=true.',
    inputSchema: { service: z.string(), environment: environmentSchema },
  },
  async ({ service, environment }) => {
    if (!DEPLOYS_ALLOWED) {
      return textResult('Pushes are disabled. Set RESPAWN_ALLOW_DEPLOYS=true to enable deploy and push.', true);
    }
    return actionResult(await corePush(actionContext(resolveConfiguredService(service, environment), environment)));
  },
);

server.registerTool(
  'destroy',
  {
    title: 'Destroy a server',
    description:
      'Tear down a service\'s stacks. DESTRUCTIVE and irreversible. Requires ' +
      'RESPAWN_ALLOW_DESTROY=true AND passing confirm=<service name>. That flag is its ' +
      'own, on purpose: allowing deploys or scaling never allows a teardown.',
    inputSchema: {
      service: z.string(),
      environment: environmentSchema,
      confirm: z.string().describe('Type the exact service name to confirm this teardown.'),
    },
  },
  async ({ service, environment, confirm }) => {
    if (!DESTROY_ALLOWED) {
      return textResult(
        'Destroy is disabled. Set RESPAWN_ALLOW_DESTROY=true to enable it — deliberately ' +
          'its own flag, so allowing deploys or scaling never allows a teardown.',
        true,
      );
    }
    if (confirm !== service) {
      return textResult(`Confirmation mismatch: pass confirm="${service}" to destroy it.`, true);
    }
    return actionResult(
      await coreDestroy({
        ...actionContext(resolveConfiguredService(service, environment), environment),
        force: true,
      }),
    );
  },
);

server.registerTool(
  'scale',
  {
    title: 'Scale a server (wake / sleep)',
    description:
      'Set a service\'s ECS desiredCount — wake a task (1) or sleep it (0) WITHOUT a ' +
      'redeploy. This is the one thing the control tools cannot do on their own: they ' +
      'drive a running task but cannot start one. Changes live infrastructure and billing, ' +
      'so it is disabled unless RESPAWN_ALLOW_SCALE=true (RESPAWN_ALLOW_DEPLOYS implies ' +
      'it). Returns immediately; reaching ' +
      'RUNNING takes ~1–2 min — poll server_health for the task and its rcon-control agent.',
    inputSchema: {
      service: z.string(),
      environment: environmentSchema,
      desiredCount: z
        .number()
        .int()
        .min(0)
        .max(1)
        .describe('0 = sleep (stop the task), 1 = wake (start one task).'),
    },
  },
  async ({ service, environment, desiredCount }) => {
    if (!SCALE_ALLOWED) {
      return textResult(
        'Scaling is disabled. Set RESPAWN_ALLOW_SCALE=true to allow waking and sleeping ' +
          'servers without also allowing deploys or destroys.',
        true,
      );
    }
    return actionResult(
      await coreScale({
        ...actionContext(resolveConfiguredService(service, environment), environment),
        desiredCount,
        region: REGION,
      }),
    );
  },
);

server.registerTool(
  'check_content',
  {
    title: 'Check content is launch-ready',
    description:
      "Verify BOTH halves of a service's custom content before launching, and report " +
      'what is wrong. The halves drift independently and both fail silently at launch: ' +
      'if the pushed image predates a map you added, `changelevel` fails outright; if ' +
      "FastDL is missing files, the map loads but joiners fall back to HLDS's 8 kB/s " +
      'cap and time out instead of connecting. Read-only, always available. Run before ' +
      'deploy or scale, not after a player complains.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "tfc"'),
      environment: environmentSchema,
      bucket: z.string().optional().describe('FastDL bucket; defaults to the FASTDL_URL one.'),
      cycle: z.string().optional().describe('Mapcycle to check, e.g. "skill". Default: all.'),
    },
  },
  async ({ service, environment, bucket, cycle }) => {
    const svc = resolveConfiguredService(service, environment);
    const resolved = resolveBucket(bucket, svc.config.gameEnvVars);
    if (!resolved) {
      return textResult(
        `No bucket given and ${service} has no GAME_ENV_FASTDL_URL to infer one from. ` +
          'Pass bucket explicitly, or set FASTDL_URL once content is published.',
        true,
      );
    }
    const args = [resolved];
    if (svc.config.aws.profile) args.push(svc.config.aws.profile);
    if (cycle) args.push('--cycle', cycle);
    const r = await runContentScript(svc.path, 'check-content', args);
    return textResult(r.output || '(no output)', r.exitCode !== 0);
  },
);

server.registerTool(
  'publish_content',
  {
    title: 'Publish content to FastDL',
    description:
      "Mirror a service's content payload to its FastDL bucket so joining players " +
      "download at full speed rather than HLDS's 8 kB/s cap. A PRE-PLAY step, not a " +
      'runtime dependency: the server never reads the bucket, so publishing late only ' +
      'makes joins slow. The prefix must be PUBLIC-READ (game clients send no ' +
      'credentials), so anything published is openly downloadable. Requires ' +
      'RESPAWN_ALLOW_DEPLOYS=true.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "tfc"'),
      environment: environmentSchema,
      bucket: z.string().optional().describe('Target bucket; defaults to the FASTDL_URL one.'),
    },
  },
  async ({ service, environment, bucket }) => {
    if (!DEPLOYS_ALLOWED) {
      return textResult(
        'Content publishing is disabled. Set RESPAWN_ALLOW_DEPLOYS=true. check_content ' +
          'is read-only and always available.',
        true,
      );
    }
    const svc = resolveConfiguredService(service, environment);
    const resolved = resolveBucket(bucket, svc.config.gameEnvVars);
    if (!resolved) return textResult(`No bucket given and ${service} has no FASTDL_URL.`, true);
    const args = [resolved];
    if (svc.config.aws.profile) args.push(svc.config.aws.profile);
    const r = await runContentScript(svc.path, 'publish-fastdl', args);
    return textResult(r.output || '(no output)', r.exitCode !== 0);
  },
);

server.registerTool(
  'clear_content',
  {
    title: 'Clear published FastDL content',
    description:
      "Remove a service's published content from its FastDL bucket — the teardown for " +
      'the pre-play publish. Worth doing after a session, because the prefix is ' +
      'public-read by necessity and content left there stays openly downloadable. ' +
      'DESTRUCTIVE and irreversible: confirm must equal the bucket name, the same guard ' +
      'the shell script uses. Requires RESPAWN_ALLOW_DEPLOYS=true. Unset ' +
      'GAME_ENV_FASTDL_URL afterwards so config and bucket stay in step.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "tfc"'),
      environment: environmentSchema,
      bucket: z.string().optional().describe('Target bucket; defaults to the FASTDL_URL one.'),
      confirm: z.string().describe('Must equal the bucket name.'),
    },
  },
  async ({ service, environment, bucket, confirm }) => {
    if (!DEPLOYS_ALLOWED) {
      return textResult('Content clearing is disabled. Set RESPAWN_ALLOW_DEPLOYS=true.', true);
    }
    const svc = resolveConfiguredService(service, environment);
    const resolved = resolveBucket(bucket, svc.config.gameEnvVars);
    if (!resolved) return textResult(`No bucket given and ${service} has no FASTDL_URL.`, true);
    if (confirm !== resolved) {
      return textResult(
        `confirm must equal the bucket name. Got "${confirm}", expected "${resolved}". ` +
          'Nothing was deleted.',
        true,
      );
    }
    const args = [resolved];
    if (svc.config.aws.profile) args.push(svc.config.aws.profile);
    // --yes because this tool already required `confirm` to match the bucket name.
    // Without it the script prompts on a stdin the MCP has closed, reads EOF, and
    // aborts every time — safe, but the tool would never do anything.
    args.push('--clear', '--yes');
    const r = await runContentScript(svc.path, 'publish-fastdl', args);
    return textResult(r.output || '(no output)', r.exitCode !== 0);
  },
);


// --- World-save lifecycle -------------------------------------------------------
//
// A world save is the only artifact in the fleet that cannot be regenerated: there is no
// manifest to refetch it from, and Valheim writes objects as a continuous stream, so a
// corrupted one is usually unrepairable. Every tool here therefore reports the shell
// script's output VERBATIM — the scripts already refuse, explain and name the fix, and
// re-wording them here would mean two descriptions of the same refusal drifting apart.

server.registerTool(
  'world_status',
  {
    title: 'World save status',
    description:
      "Report every copy of every world for a service: the local library (with each " +
      "save's in-game clock and its vanilla/modded provenance stamp), what is STAGED in " +
      "S3 for the next start, and what the server has MIRRORED back. Ends with a verdict " +
      'saying which side is ahead. Read-only and always available. Run it BEFORE ' +
      'publishing (a stale push discards played progress) and BEFORE rotating. An ' +
      'unreachable bucket is reported as UNKNOWN, never as "nothing staged".',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "valheim" or "valheim-qol"'),
      environment: environmentSchema,
    },
  },
  async ({ service, environment }) => {
    const svc = resolveConfiguredService(service, environment);
    const args: string[] = [''];
    if (svc.config.aws.profile) args.push(svc.config.aws.profile);
    const r = await runWorldScript(svc, 'check-content', args);
    return textResult(r.output || '(no output)', r.exitCode !== 0);
  },
);

server.registerTool(
  'publish_world',
  {
    title: 'Stage a world save for the next start',
    description:
      "Upload a world from the service's local library to its S3 inbox. The sidecar " +
      'installs it at the next task start and then clears the inbox, so this is a ' +
      'handoff, not a setting — the running server keeps playing whatever it booted on ' +
      'until it restarts. REFUSED if the server has been played since your local copy ' +
      '(that would discard progress), or if the save has ever run MODDED and the target ' +
      'is a vanilla server (that would destroy every object its mods created, ' +
      'permanently). Requires RESPAWN_ALLOW_DEPLOYS=true.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "valheim"'),
      environment: environmentSchema,
      world: z.string().describe('World name as it appears in the library, e.g. "respawn-world"'),
      force: z
        .boolean()
        .optional()
        .describe('Publish even though the server is ahead — a deliberate rollback that discards played progress.'),
      assumeVanilla: z
        .boolean()
        .optional()
        .describe('Assert an UNSTAMPED save has never run modded. Only for a save whose history you know.'),
    },
  },
  async ({ service, environment, world, force, assumeVanilla }) => {
    if (!DEPLOYS_ALLOWED) {
      return textResult(
        'Publishing a world is disabled. Set RESPAWN_ALLOW_DEPLOYS=true. world_status is ' +
          'read-only and always available.',
        true,
      );
    }
    const svc = resolveConfiguredService(service, environment);
    const args = [world];
    if (svc.config.aws.profile) args.push(svc.config.aws.profile);
    if (force) args.push('--force');
    if (assumeVanilla) args.push('--assume-vanilla');
    const r = await runWorldScript(svc, 'publish-world', args);
    return textResult(r.output || '(no output)', r.exitCode !== 0);
  },
);

server.registerTool(
  'pull_world',
  {
    title: 'Pull the played world back',
    description:
      "Download the server's mirrored world into the local library — the half that makes " +
      'rotation safe, because the mirror is the ONLY copy carrying the session\'s ' +
      'progress. Rotating to a different world without pulling first discards everything ' +
      'played. The copy being replaced is kept under worlds/.previous/. Refuses if your ' +
      'local copy is ahead of the server\'s. `clear` also empties the S3 copies ' +
      'afterwards, and only ever runs after a verified download.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "valheim"'),
      environment: environmentSchema,
      world: z.string().describe('World name, e.g. "respawn-world"'),
      force: z.boolean().optional().describe('Overwrite a local copy that is ahead of the server\'s.'),
      clear: z
        .boolean()
        .optional()
        .describe('Empty the S3 copies after a verified download. Requires RESPAWN_ALLOW_DEPLOYS=true.'),
    },
  },
  async ({ service, environment, world, force, clear }) => {
    if (clear && !DEPLOYS_ALLOWED) {
      return textResult(
        'clear deletes from S3 and is disabled. Set RESPAWN_ALLOW_DEPLOYS=true, or pull ' +
          'without clear — the download itself is not gated.',
        true,
      );
    }
    const svc = resolveConfiguredService(service, environment);
    const args = [world];
    if (svc.config.aws.profile) args.push(svc.config.aws.profile);
    if (force) args.push('--force');
    if (clear) args.push('--clear');
    const r = await runWorldScript(svc, 'pull-world', args);
    return textResult(r.output || '(no output)', r.exitCode !== 0);
  },
);

server.registerTool(
  'clear_world',
  {
    title: 'Empty a world from S3',
    description:
      "Remove a world's staged and mirrored copies from S3 after a session. Housekeeping " +
      'rather than an exposure fix (the bucket is private) — what it prevents is a stale ' +
      'mirror being pulled down months later and treated as current. REFUSES unless the ' +
      'local library already holds a copy at least as new, because the mirror is ' +
      'otherwise the only record of the session. Does NOT remove the world from the ' +
      "server's volume, and a running task re-mirrors it within the sync interval — " +
      'scale to 0 first if the bucket must stay empty. Requires RESPAWN_ALLOW_DEPLOYS=true.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "valheim"'),
      environment: environmentSchema,
      world: z.string().describe('World name, e.g. "respawn-world"'),
      confirm: z.string().describe('Must equal the world name.'),
    },
  },
  async ({ service, environment, world, confirm }) => {
    if (!DEPLOYS_ALLOWED) {
      return textResult('Clearing a world is disabled. Set RESPAWN_ALLOW_DEPLOYS=true.', true);
    }
    if (confirm !== world) {
      return textResult(
        `confirm must equal the world name. Got "${confirm}", expected "${world}". Nothing was deleted.`,
        true,
      );
    }
    const svc = resolveConfiguredService(service, environment);
    const args = [world];
    if (svc.config.aws.profile) args.push(svc.config.aws.profile);
    args.push('--yes');
    const r = await runWorldScript(svc, 'clear-world', args);
    return textResult(r.output || '(no output)', r.exitCode !== 0);
  },
);

server.registerTool(
  'switch_world',
  {
    title: 'Switch which world the server runs',
    description:
      'Deploy the service with a different world selected. The world name IS the save ' +
      'file name, so this points the server at a different save; the world-sync sidecar ' +
      'follows the same value, which is what keeps the running world and the mirrored ' +
      'one the same file. Worlds ACCUMULATE on the volume by name, so switching back to ' +
      'one that has already run here needs no S3 round trip at all. This REPLACES the ' +
      'task and restarts the server — an in-progress session ends. Pull the current ' +
      "world first if its progress matters (the sidecar's shutdown mirror is best-effort: " +
      'a task killed without SIGTERM never runs it). Requires RESPAWN_ALLOW_DEPLOYS=true.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "valheim"'),
      environment: environmentSchema,
      world: z.string().describe('World name to switch to, e.g. "respawn-world-archive"'),
    },
  },
  async ({ service, environment, world }) => {
    if (!DEPLOYS_ALLOWED) {
      return textResult('Switching worlds redeploys the service and is disabled. Set RESPAWN_ALLOW_DEPLOYS=true.', true);
    }
    const svc = resolveConfiguredService(service, environment);
    const variant = variantOf(svc.path);
    if (!variant) {
      return textResult(`${service} is not a variant service and has no world library.`, true);
    }
    // Refuse a name the library does not have. Deploying an unknown world does not fail:
    // Valheim CREATES a new empty world of that name and happily runs it, so a typo
    // silently replaces the session with a fresh spawn rather than erroring.
    const worldDir = path.join(svc.path, 'worlds', world);
    if (!fs.existsSync(path.join(worldDir, `${world}.db`))) {
      const dir = path.join(svc.path, 'worlds');
      const have = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((d) => !d.startsWith('.')).join(', ') || '(none)'
        : '(no library)';
      return textResult(
        `${service} has no world "${world}" in its library. Have: ${have}.\n` +
          `Deploying an unknown name does not fail — Valheim creates a NEW empty world ` +
          `and runs it, so this is refused rather than risked. Note the library lists ` +
          `only worlds that have passed through this machine; the volume may hold others.`,
        true,
      );
    }
    return actionResult(
      await coreDeploy({
        ...actionContext(svc, environment),
        requireApproval: 'never',
        gameEnvOverrides: { WORLD_NAME: world },
      }),
    );
  },
);


server.registerTool(
  'reveal_secret',
  {
    title: 'Read a secret value',
    description:
      "Return the plaintext of one of a service's SECRET_REFS — for a value a HUMAN has " +
      'to use, such as the join password players type. PUTS THE VALUE IN THIS ' +
      'TRANSCRIPT, so call it when someone actually needs the value, not to check a ' +
      "secret exists: check_secrets answers that without disclosing anything. Requires " +
      'RESPAWN_ALLOW_SECRET_REVEAL=true, which is deliberately separate from the write ' +
      'gate — generate_secret mints a random value and does not return it, so being able ' +
      'to replace a secret does not imply being able to learn the stored one.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "valheim-qol"'),
      secret: z.string().describe('Container env var name from SECRET_REFS, e.g. "SERVER_PASS"'),
      environment: environmentSchema,
    },
  },
  async ({ service, secret, environment }) => {
    if (!SECRET_REVEAL_ALLOWED) {
      return textResult(
        'Reading secret values is disabled. Set RESPAWN_ALLOW_SECRET_REVEAL=true in the ' +
          "MCP server's env to enable it. check_secrets reports presence without " +
          'disclosing anything and is always available.',
        true,
      );
    }
    const config = resolveConfiguredService(service, environment).config;
    const ref = config.secretRefs.find((r) => r.containerEnvVar === secret);
    if (!ref) {
      const known = config.secretRefs.map((r) => r.containerEnvVar).join(', ') || '(none)';
      return textResult(
        `${service} declares no SECRET_REFS entry named "${secret}". Has: ${known}.`,
        true,
      );
    }
    const value = await readSecret({
      store: ref.store,
      sourceId: ref.sourceId,
      ...(ref.jsonKey ? { jsonKey: ref.jsonKey } : {}),
      region: config.aws.region ?? REGION,
      ...(PROFILE ? { profile: PROFILE } : {}),
    });
    if (value === undefined) {
      return textResult(
        `${secret} -> ${ref.store}:${ref.sourceId} could not be read. It may not exist ` +
          `yet (check_secrets confirms), or the profile may lack permission. Secrets are ` +
          `per account AND per region.`,
        true,
      );
    }
    return textResult(`${service} ${secret} (${ref.store}:${ref.sourceId}):\n\n${value}`);
  },
);


server.registerTool(
  'list_services',
  {
    title: 'List every configured service and what applies to it',
    description:
      'Every service configured in the repo, with the tool families each supports. ' +
      'DIFFERENT FROM list_servers, which shows only servers that are RUNNING and ' +
      'rcon-capable — a service that is scaled to zero, or that has no remote console at ' +
      'all, appears here and nowhere else. Start here when you do not already know a ' +
      "service's name or how it is administered. Read-only.",
    inputSchema: {
      environment: environmentSchema,
      detail: z
        .boolean()
        .default(false)
        .describe('Expand every family per service instead of a one-line summary.'),
    },
  },
  async ({ environment, detail }) => {
    const services = discoverServices(WORKSPACE_ROOT, environment).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (services.length === 0) return textResult('No configured services found.', true);

    const out: string[] = [`${services.length} configured service(s) in ${environment}:`, ''];
    for (const svc of services) {
      const f = familiesFor(svc);
      if (detail) {
        out.push(`${f.service} (${f.displayName})`, formatFamilies(f), '');
      } else {
        const tags: string[] = [];
        // Drift gets its own token rather than folding into "none". The summary is what
        // people scan, so a manifest that exists and cannot be reached has to be visible
        // HERE — hiding it behind a per-service call defeats the point of the listing.
        tags.push(
          f.commands.available
            ? `commands:${f.commands.commandCount}`
            : f.commands.kind === 'drift'
              ? 'commands:UNREACHABLE(drift)'
              : f.commands.kind === 'no-manifest'
                ? 'commands:no-manifest'
                : 'commands:none',
        );
        if (f.worldSaves) tags.push('world-saves');
        if (f.contentPayload) tags.push('content');
        if (f.persistentMountPath) tags.push('persistent');
        if (f.idleShutdown) tags.push('idle-scale-0');
        if (f.secrets.length > 0) tags.push(`secrets:${f.secrets.length}`);
        out.push(`  ${f.service.padEnd(16)} ${tags.join('  ')}`);
      }
    }
    out.push(
      '',
      'Every service also supports lifecycle (synth/diff/deploy/push/scale/check_updates) ' +
        'and observability (server_health/server_logs/server_metrics/container_stats).',
      'commands:none means no mid-game command surface — get_server_options says whether ' +
        'that is a missing manifest or a game with no remote console at all.',
    );
    return textResult(out.join('\n'));
  },
);


server.registerTool(
  'list_worlds',
  {
    title: 'What worlds do we have',
    description:
      'Every world save in every service\'s local library, with its in-game age, ' +
      'save-format version and vanilla/modded provenance. THE ANSWER TO "which worlds do ' +
      'we have" — start here before publish_world or switch_world, which both need a name ' +
      'you can only get from somewhere.\n\n' +
      'Reads local disk only: no AWS calls, no credentials, instant, and it still works ' +
      'when your SSO session has expired — unlike world_status, which needs S3 and reports ' +
      'UNKNOWN when it cannot reach it. Use world_status instead when the question is ' +
      '"has the server been played since my copy", which this cannot answer.',
    inputSchema: {
      environment: environmentSchema,
      service: z
        .string()
        .optional()
        .describe('Limit to one service. Omit for every service that keeps worlds.'),
    },
  },
  async ({ environment, service }) => {
    const services = discoverServices(WORKSPACE_ROOT, environment)
      .filter((s) => s.config.worldSync.enabled)
      .filter((s) => service === undefined || s.name === service)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (services.length === 0) {
      return textResult(
        service !== undefined
          ? `${service} does not keep a world library (ENABLE_WORLD_SYNC is off, or no such service).`
          : 'No service keeps a world library.',
        true,
      );
    }

    const all: LibraryWorld[] = services.flatMap((s) => readLibrary(s.path, s.name));
    if (all.length === 0) {
      return textResult(
        `No worlds in ${services.map((s) => s.name).join(', ')}. Pull one from a server ` +
          'with pull_world, or place a save in the service\'s worlds/ directory.',
      );
    }

    // Grouped by NAME rather than by service: "which worlds do we have" is a question
    // about worlds, and the same save living in two libraries is one world, not two.
    const byName = new Map<string, LibraryWorld[]>();
    for (const w of all) {
      const list = byName.get(w.name) ?? [];
      list.push(w);
      byName.set(w.name, list);
    }

    const lines: string[] = [
      `${byName.size} world(s) across ${services.length} service librar${services.length === 1 ? 'y' : 'ies'}:`,
      '',
    ];
    for (const [name, copies] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
      const first = copies[0]!;
      const flavor = first.flavor ?? 'unstamped';
      const mb = (first.bytes / 1024 / 1024).toFixed(1);
      lines.push(
        `  ${name}`,
        `      ${inGameDays(first.netTime).toFixed(1)} in-game days   save v${first.version}   ${mb} MB   [${flavor}]`,
        `      in: ${copies.map((c) => c.service).join(', ')}`,
      );
      if (first.mods.length > 0) {
        // Annotated, because the bare list does not say which of them threaten a later
        // vanilla load — and that is the only reason the list matters operationally.
        const annotated = first.mods.map((m) => {
          if (first.modsWorldSafe.includes(m)) return `${m} (world-safe)`;
          if (first.modsWorldAltering.includes(m)) return `${m} (world-altering)`;
          return m;
        });
        lines.push(`      mods run: ${annotated.join(', ')}`);
      }
      // Phrased as a consequence, not a capability: a modded save DOES load on a vanilla
      // server, it just deletes what the mods built. "Can it run" is the wrong question.
      const outlook = unmoddedOutlook(first);
      lines.push(`      without mods: ${outlook.verdict} — ${outlook.detail}`);
      for (const c of copies.filter((x) => !x.complete)) {
        lines.push(`      ! ${c.service}: .db with no .fwl — will not load`);
      }
      const diverged = divergence(copies);
      if (diverged) {
        lines.push(`      ! COPIES DISAGREE on ${diverged}:`);
        for (const c of copies) {
          lines.push(`          ${c.service}: save v${c.version}, ${inGameDays(c.netTime).toFixed(1)} days`);
        }
      }
      lines.push('');
    }
    lines.push(
      'Local libraries only — this says nothing about what a server is currently running.',
      'world_status <service> compares these against S3; switch_world picks one to run.',
    );
    return textResult(lines.join('\n'));
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`respawn-rcon MCP failed to start: ${err}\n`);
  process.exit(1);
});
