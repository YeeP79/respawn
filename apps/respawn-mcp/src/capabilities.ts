import type { Manifest } from './manifest.js';
import { MANIFESTS } from './manifests.generated.js';
import { execRcon, type ExecTarget } from './exec.js';

export interface ResolvedCapabilities extends Omit<Manifest, 'maps'> {
  /** Concrete map list: the live server's `maps *` when the manifest says "live". */
  maps?: string[];
  /** Set when `maps` is "live" but the live query could not run. */
  mapsNote?: string;
}

/** Returns the bundled manifest for a service, or undefined if none was authored. */
export function getManifest(service: string): Manifest | undefined {
  return MANIFESTS[service];
}

/** Names of every service that ships a manifest. */
export function manifestedServices(): string[] {
  return Object.keys(MANIFESTS);
}

/** Parses a GoldSrc/Source `maps *` reply into bare map names (no `.bsp`). */
export function parseMapList(raw: string): string[] {
  const maps = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0] ?? '';
    const match = /^([A-Za-z0-9_]+)\.bsp$/.exec(token);
    if (match) maps.add(match[1]!);
  }
  return [...maps].sort();
}

/**
 * Resolves a service's capabilities for the LLM: its bundled manifest, with the
 * map list filled in live from the running server when the manifest says "live".
 *
 * A failed live-maps query degrades to an empty list plus a note — it never
 * throws, so `get_server_options` still returns the useful command/cvar surface.
 */
export async function resolveCapabilities(
  service: string,
  target: ExecTarget | undefined,
): Promise<ResolvedCapabilities | undefined> {
  const manifest = getManifest(service);
  if (!manifest) return undefined;

  const { maps, ...rest } = manifest;
  const resolved: ResolvedCapabilities = { ...rest };

  if (Array.isArray(maps)) {
    resolved.maps = maps;
  } else if (maps === 'live') {
    if (!target) {
      resolved.mapsNote = 'maps are queried live; the server is not running.';
    } else {
      try {
        const result = await execRcon(target, 'maps *');
        resolved.maps = parseMapList(result.output);
      } catch (err) {
        resolved.mapsNote = `could not query live maps: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
  }

  return resolved;
}

/**
 * Which families of tool apply to one service, derived from its config.
 *
 * The MCP's tools are service-PARAMETERISED — one `deploy`, one `run_command`, twenty
 * services — which is the right shape (per-server tools would mean 32 x 20 of them) but
 * leaves a gap: nothing says which families a given service actually supports. The
 * failure that gap produces is not an error, it is a wrong conclusion. `valheim` has no
 * rcon transport at all, so `run_command` there is not an unfinished manifest, it is a
 * category error — and a caller who reads "no manifest" as "not wired up yet" goes
 * looking for a file to write instead of understanding the server is administered a
 * different way.
 *
 * Derived from config in ONE place so a new family cannot be added to the fleet and
 * quietly stay missing from what the MCP advertises.
 */
export interface ServiceFamilies {
  service: string;
  displayName: string;
  /** Mid-game command surface: needs BOTH an rcon transport and a manifest. */
  commands:
    | { available: true; commandCount: number; queryCount: number; unverified: number }
    | { available: false; kind: 'drift' | 'no-transport' | 'no-manifest'; reason: string };
  worldSaves: boolean;
  contentPayload: boolean;
  secrets: string[];
  persistentMountPath: string | null;
  idleShutdown: boolean;
}

/** Tool names each family provides, for reporting. */
export const FAMILY_TOOLS = {
  commands: 'get_server_options, run_command, rcon, query, set_cvar, set_mutators, capture_raw, sample',
  worldSaves: 'world_status, publish_world, pull_world, clear_world, switch_world',
  contentPayload: 'check_content, publish_content, clear_content',
  secrets: 'check_secrets, generate_secret, reveal_secret',
  lifecycle: 'synth, diff, deploy, push, scale, check_updates, destroy',
  observability: 'server_health, server_logs, server_metrics, container_stats',
} as const;

/**
 * @param config - The service's loaded config.
 * @param hasContentScripts - Whether the service ships content tooling; resolved by the
 *   caller, which is the side that knows the filesystem layout.
 */
export function resolveFamilies(
  service: string,
  config: {
    serviceDisplayName: string;
    rconControl: { enabled: boolean };
    worldSync: { enabled: boolean };
    persistentStorage: { enabled: boolean; mountPath: string };
    idleShutdown: { enabled: boolean };
    secretRefs: ReadonlyArray<{ containerEnvVar: string }>;
  },
  hasContentScripts: boolean,
): ServiceFamilies {
  const manifest = getManifest(service);
  // Two independent preconditions, reported separately: a missing manifest is work
  // somebody can do, while a missing transport is a property of the game and no manifest
  // will ever fix it. Collapsing them into "unavailable" loses the distinction that
  // decides whether to go and write one.
  let commands: ServiceFamilies['commands'];
  if (!config.rconControl.enabled && manifest) {
    // Both halves exist but only one is switched on. Almost certainly drift: somebody
    // authored a command surface for this service and the sidecar that carries it was
    // never enabled, so every command tool fails at the transport while the manifest
    // sits there looking complete.
    commands = {
      available: false,
      kind: 'drift',
      reason:
        'a manifest exists but ENABLE_RCON_CONTROL is off, so no rcon-control sidecar is ' +
        'deployed — the commands are declared and unreachable. Likely config drift.',
    };
  } else if (!config.rconControl.enabled) {
    // Deliberately does NOT claim the game has no remote console: config cannot tell
    // "this game offers none" from "nobody turned it on". Valheim is the former and it
    // took research to establish, not a config read.
    commands = {
      available: false,
      kind: 'no-transport',
      reason:
        'no rcon transport configured (ENABLE_RCON_CONTROL is off). Either the game has ' +
        'no remote console, or one exists and is not enabled — the service .env decides.',
    };
  } else if (!manifest) {
    commands = {
      available: false,
      kind: 'no-manifest',
      reason: 'rcon transport is configured but the service ships no rcon-manifest.json',
    };
  } else {
    commands = {
      available: true,
      commandCount: manifest.commands.length,
      queryCount: manifest.queries.length,
      unverified: manifest.commands.filter((c) => c.unverified).length,
    };
  }

  return {
    service,
    displayName: config.serviceDisplayName,
    commands,
    worldSaves: config.worldSync.enabled,
    contentPayload: hasContentScripts,
    secrets: config.secretRefs.map((r) => r.containerEnvVar),
    persistentMountPath: config.persistentStorage.enabled ? config.persistentStorage.mountPath : null,
    idleShutdown: config.idleShutdown.enabled,
  };
}

/** One service's families as readable lines. */
export function formatFamilies(f: ServiceFamilies): string {
  const lines: string[] = [];
  if (f.commands.available) {
    const u = f.commands.unverified > 0 ? `, ${f.commands.unverified} unverified` : '';
    lines.push(
      `  mid-game commands  ${f.commands.commandCount} commands, ${f.commands.queryCount} queries${u}`,
      `                     ${FAMILY_TOOLS.commands}`,
    );
  } else {
    lines.push(`  mid-game commands  UNAVAILABLE — ${f.commands.reason}`);
  }
  if (f.worldSaves) lines.push(`  world saves        ${FAMILY_TOOLS.worldSaves}`);
  if (f.contentPayload) lines.push(`  content payload    ${FAMILY_TOOLS.contentPayload}`);
  if (f.secrets.length > 0) {
    lines.push(`  secrets            ${f.secrets.join(', ')}`, `                     ${FAMILY_TOOLS.secrets}`);
  }
  if (f.persistentMountPath) lines.push(`  persistent volume  ${f.persistentMountPath}`);
  if (f.idleShutdown) lines.push('  idle shutdown      enabled (scales to zero when empty)');
  lines.push(`  lifecycle          ${FAMILY_TOOLS.lifecycle}`);
  lines.push(`  observability      ${FAMILY_TOOLS.observability}`);
  return lines.join('\n');
}
