#!/usr/bin/env node
import { randomInt } from 'node:crypto';
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
} from './capabilities.js';
import { resolveCvarCommand, resolveWireCommand } from './manifest.js';
import { runQuery } from './query-engine.js';
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
      const known = manifestedServices().join(', ') || '(none)';
      return textResult(
        `No options manifest for "${service}". Servers with a manifest: ${known}.`,
        true,
      );
    }
    // A running target lets us fill in live maps; absence is fine (degrades).
    const target = await findTarget(service);
    const caps = await resolveCapabilities(service, target);
    return textResult(JSON.stringify(caps, null, 2));
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

server.registerTool(
  'server_logs',
  {
    title: 'Server logs',
    description:
      'Tail a game server\'s CloudWatch logs, optionally filtered to one container ' +
      '(game-server, rcon-control, idle-shutdown) and a search pattern. The companion ' +
      'to server_health when a task stopped and you need to know why.',
    inputSchema: {
      service: z.string(),
      container: z.enum(['game-server', 'rcon-control', 'idle-shutdown']).optional(),
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`respawn-rcon MCP failed to start: ${err}\n`);
  process.exit(1);
});
