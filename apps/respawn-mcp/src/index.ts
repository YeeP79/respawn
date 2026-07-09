#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { discoverRconServers, RCON_CONTAINER_NAME } from './discovery.js';
import { execRcon, type RconResult } from './exec.js';

const REGION = process.env['RESPAWN_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1';
const PROFILE = process.env['RESPAWN_PROFILE'] ?? process.env['AWS_PROFILE'];

const awsOpts = { region: REGION, profile: PROFILE };

/** Resolves a service name to its running task, or throws a helpful message. */
async function resolveTarget(service: string) {
  const servers = await discoverRconServers(awsOpts);
  const match = servers.find((s) => s.service === service);
  if (!match) {
    const available = servers.map((s) => s.service).join(', ') || '(none running)';
    throw new Error(
      `No running rcon-capable server named "${service}". Available: ${available}. ` +
        `A scaled-to-zero server has no task to control — deploy or wake it first.`,
    );
  }
  return {
    cluster: match.cluster,
    task: match.task,
    container: RCON_CONTAINER_NAME,
    ...awsOpts,
  };
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
  'server_status',
  {
    title: 'Server status',
    description: 'Show who is connected and the current map (rcon "status").',
    inputSchema: { service: z.string().describe('Service name, e.g. "cs16"') },
  },
  async ({ service }) => runAndFormat(service, 'status'),
);

server.registerTool(
  'change_map',
  {
    title: 'Change map',
    description: 'Switch the current map immediately.',
    inputSchema: {
      service: z.string().describe('Service name, e.g. "cs16"'),
      map: z.string().describe('Map name, e.g. "de_nuke"'),
    },
  },
  // GoldSrc uses `changelevel`; Source accepts it too, so it is the portable verb.
  async ({ service, map }) => runAndFormat(service, `changelevel ${map}`),
);

server.registerTool(
  'set_cvar',
  {
    title: 'Set a cvar',
    description: 'Set a server console variable live, e.g. mp_friendlyfire 1.',
    inputSchema: {
      service: z.string(),
      cvar: z.string().describe('Console variable name'),
      value: z.string().describe('New value'),
    },
  },
  async ({ service, cvar, value }) => runAndFormat(service, `${cvar} "${value}"`),
);

server.registerTool(
  'set_server_password',
  {
    title: 'Set join password',
    description:
      'Set (or clear, with an empty value) the password players need to join. ' +
      'This is sv_password — distinct from the rcon admin password.',
    inputSchema: {
      service: z.string(),
      password: z.string().describe('Join password; empty string removes it'),
    },
  },
  async ({ service, password }) =>
    runAndFormat(service, `sv_password "${password}"`),
);

server.registerTool(
  'say',
  {
    title: 'Broadcast a message',
    description: 'Print a message to everyone on the server.',
    inputSchema: { service: z.string(), message: z.string() },
  },
  async ({ service, message }) => runAndFormat(service, `say ${message}`),
);

server.registerTool(
  'rcon',
  {
    title: 'Raw rcon command',
    description:
      'Run an arbitrary rcon command. Escape hatch for anything the typed tools ' +
      'do not cover; the command is passed to the game verbatim.',
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
