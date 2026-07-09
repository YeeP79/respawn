#!/usr/bin/env node
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { discoverRconServers, RCON_CONTAINER_NAME } from './discovery.js';
import { execRcon, type ExecTarget, type RconResult } from './exec.js';
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`respawn-rcon MCP failed to start: ${err}\n`);
  process.exit(1);
});
