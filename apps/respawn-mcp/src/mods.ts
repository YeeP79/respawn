import fs from 'node:fs';
import path from 'node:path';

/**
 * Thunderstore packages installed on a service, read from the variant's tracked
 * `mods.lock`.
 *
 * `mods.lock` is the generated flat set — every package the variant's `mods.txt` reaches
 * through its includes — so it is the one file that answers "what is actually on this
 * server" without resolving includes here. The gitignored `mods/` payload is deliberately
 * NOT the source: it is absent in a fresh clone and on any machine that has not run
 * `valheim:mods:fetch`, which would make a command look unavailable purely because
 * nobody had fetched the payload locally.
 *
 * @returns The installed package set, or `null` when the service ships no `mods.lock` —
 *   which means "nothing is known about mods here", not "no mods". The distinction
 *   matters: a null must gate nothing, or every command on every non-Valheim service
 *   would read as unavailable.
 */
export function readInstalledPackages(servicePath: string): Set<string> | null {
  const lock = path.join(servicePath, 'mods.lock');
  let raw: string;
  try {
    raw = fs.readFileSync(lock, 'utf-8');
  } catch {
    return null;
  }
  const packages = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const name = trimmed.split(/\s+/)[0];
    if (name !== undefined && name.includes('/')) packages.add(name);
  }
  return packages;
}

/**
 * Whether a manifest entry's `requires` is satisfied, and what is missing if not.
 *
 * Unknown is treated as available, on purpose. A service with no `mods.lock` has no mod
 * information at all, and hiding its whole command surface would be a far worse answer
 * than listing a command that turns out not to exist — the first breaks every service in
 * the fleet, the second produces one honest error from the server.
 */
export function requirementsMet(
  entry: { requires?: readonly string[] | undefined },
  installed: Set<string> | null,
): { met: true } | { met: false; missing: string[] } {
  const required = entry.requires ?? [];
  if (required.length === 0 || installed === null) return { met: true };
  const missing = required.filter((pkg) => !installed.has(pkg));
  return missing.length === 0 ? { met: true } : { met: false, missing };
}
