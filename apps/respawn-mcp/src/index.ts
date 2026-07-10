#!/usr/bin/env node
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { discoverRconServers, RCON_CONTAINER_NAME } from './discovery.js';
import { execPython, execRcon, type ExecTarget, type RconResult } from './exec.js';
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
import { runQuery } from './query-engine.js';

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
async function runAndFormat(service: string, command: string) {
  const target = await resolveTarget(service);
  const result: RconResult = await execRcon(target, command);
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
    return runAndFormat(service, rcon);
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
  async ({ service, cvar, value }) => runAndFormat(service, `${cvar} "${value}"`),
);

server.registerTool(
  'rcon',
  {
    title: 'Raw rcon command',
    description:
      'Run an arbitrary rcon command. Escape hatch for anything the declared ' +
      'commands do not cover; passed to the game verbatim.',
    inputSchema: { service: z.string(), command: z.string() },
  },
  async ({ service, command }) => runAndFormat(service, command),
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`respawn-rcon MCP failed to start: ${err}\n`);
  process.exit(1);
});
