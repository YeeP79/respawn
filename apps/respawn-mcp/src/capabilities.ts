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
