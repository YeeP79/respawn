import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Reading a service's LOCAL world library — no network, no credentials.
 *
 * Deliberately separate from world_status, which answers a different question ("is the
 * server ahead of my copy?") and needs three S3 round trips to do it. That makes
 * world_status unable to answer "what worlds do we have" at exactly the moments somebody
 * asks it: an expired SSO session turns it into VERDICT UNKNOWN, while the saves are
 * sitting on local disk the whole time.
 */

/** One save in a service's library. */
export interface LibraryWorld {
  name: string;
  service: string;
  /** Valheim's save-format version from the .db header. */
  version: number;
  /** In-game seconds elapsed; Valheim advances this only while a player is connected. */
  netTime: number;
  bytes: number;
  /** vanilla | modded from the provenance stamp, or null when unstamped. */
  flavor: string | null;
  /** Plugin file names recorded in the stamp. */
  mods: string[];
  /** Plugins declared to write no prefabs into the save. */
  modsWorldSafe: string[];
  /** Plugins that may have written prefabs — the ones that make a vanilla load lossy. */
  modsWorldAltering: string[];
  /** A .db with no .fwl beside it will not load. */
  complete: boolean;
}

/** 1800 in-game seconds is a Valheim day. */
export function inGameDays(netTime: number): number {
  return netTime / 1800;
}

/**
 * Save-format version and world clock from a `.db` header: int32 version then a
 * little-endian float64 netTime.
 *
 * Returns undefined rather than throwing on a short or unreadable file — a library
 * listing must still report the other saves.
 */
export function readWorldHeader(dbPath: string): { version: number; netTime: number } | undefined {
  let fd: number | undefined;
  try {
    const buf = Buffer.alloc(12);
    fd = fs.openSync(dbPath, 'r');
    if (fs.readSync(fd, buf, 0, 12, 0) < 12) return undefined;
    return { version: buf.readInt32LE(0), netTime: buf.readDoubleLE(4) };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/** The provenance stamp beside a save, if it has one. */
function readStamp(dir: string, name: string): {
  flavor: string | null;
  mods: string[];
  modsWorldSafe: string[];
  modsWorldAltering: string[];
} {
  try {
    const raw = fs.readFileSync(path.join(dir, `${name}.respawn.json`), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const o = parsed as {
        flavor?: unknown;
        mods?: unknown;
        mods_world_safe?: unknown;
        mods_world_altering?: unknown;
      };
      const strs = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string') : [];
      return {
        flavor: typeof o.flavor === 'string' ? o.flavor : null,
        mods: strs(o.mods),
        // Absent on stamps written before the split existed. Left empty rather than
        // guessed: `flavor` still carries the verdict, and inventing a classification
        // for plugins nobody classified would be the opposite of an audit trail.
        modsWorldSafe: strs(o.mods_world_safe),
        modsWorldAltering: strs(o.mods_world_altering),
      };
    }
  } catch {
    // No stamp, or an unreadable one. Unstamped is a real and reportable state — it means
    // nothing knows whether the save has ever run with mods.
  }
  return { flavor: null, mods: [], modsWorldSafe: [], modsWorldAltering: [] };
}

/** Every save in one service's `worlds/` directory. `.previous/` snapshots are skipped. */
export function readLibrary(servicePath: string, service: string): LibraryWorld[] {
  const dir = path.join(servicePath, 'worlds');
  if (!fs.existsSync(dir)) return [];

  const out: LibraryWorld[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const wdir = path.join(dir, entry.name);
    const db = path.join(wdir, `${entry.name}.db`);
    if (!fs.existsSync(db)) continue;

    const header = readWorldHeader(db);
    const stamp = readStamp(wdir, entry.name);
    out.push({
      name: entry.name,
      service,
      version: header?.version ?? -1,
      netTime: header?.netTime ?? -1,
      bytes: fs.statSync(db).size,
      flavor: stamp.flavor,
      mods: stamp.mods,
      modsWorldSafe: stamp.modsWorldSafe,
      modsWorldAltering: stamp.modsWorldAltering,
      complete: fs.existsSync(path.join(wdir, `${entry.name}.fwl`)),
    });
  }
  return out;
}

/**
 * Copies of one world that disagree.
 *
 * The same world legitimately lives in several libraries — that is how a save moves
 * between the vanilla and modded servers. What matters is whether they have DIVERGED,
 * because then "the world" names two different things and picking the wrong one
 * silently rolls back play or re-runs an upgrade.
 */
export function divergence(copies: LibraryWorld[]): string | null {
  if (copies.length < 2) return null;
  const versions = new Set(copies.map((c) => c.version));
  // Compared exactly: netTime is the same float read from the same header, so two copies
  // of one save agree bit for bit unless one has actually been played further.
  const clocks = new Set(copies.map((c) => c.netTime));
  if (versions.size === 1 && clocks.size === 1) return null;
  const parts: string[] = [];
  if (versions.size > 1) parts.push('save-format version');
  if (clocks.size > 1) parts.push('world clock');
  return parts.join(' and ');
}

/**
 * What loading this save WITHOUT mods would cost.
 *
 * Phrased as a consequence rather than a capability, because "runnable without mods" is
 * not quite true of any of them: a modded save will load on a vanilla server perfectly
 * happily — it just silently deletes every object its mods created, and Valheim writes
 * objects as a continuous stream, so that damage is usually unrepairable. The question
 * worth answering is not "can it run" but "what does running it destroy".
 */
export function unmoddedOutlook(w: LibraryWorld): { verdict: string; detail: string } {
  if (w.flavor === 'modded') {
    const culprits = w.modsWorldAltering.length > 0 ? w.modsWorldAltering.join(', ') : 'a mod that ran on it';
    return {
      verdict: 'DESTRUCTIVE',
      detail: `objects created by ${culprits} would be deleted on load, permanently`,
    };
  }
  if (w.flavor === null) {
    return {
      verdict: 'UNKNOWN',
      detail: 'no provenance stamp, so nothing knows whether a world-altering mod ever ran',
    };
  }
  const safe = w.modsWorldSafe.length;
  return {
    verdict: 'safe',
    detail:
      safe > 0
        ? `${safe} mod(s) have run, all declared world-safe — nothing mod-created is in this save`
        : 'nothing mod-created is in this save',
  };
}
