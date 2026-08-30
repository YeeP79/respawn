import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readWorldHeader, readLibrary, divergence, inGameDays, unmoddedOutlook } from './worlds.js';

let root: string;

/** A save with a real header: int32 version + little-endian float64 netTime. */
function writeWorld(
  svc: string,
  name: string,
  opts: {
    version?: number; netTime?: number; fwl?: boolean; flavor?: string | null;
    mods?: string[]; safeMods?: string[]; alteringMods?: string[];
  } = {},
): void {
  const dir = path.join(root, svc, 'worlds', name);
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.alloc(64);
  buf.writeInt32LE(opts.version ?? 37, 0);
  buf.writeDoubleLE(opts.netTime ?? 380746.24, 4);
  fs.writeFileSync(path.join(dir, `${name}.db`), buf);
  if (opts.fwl !== false) fs.writeFileSync(path.join(dir, `${name}.fwl`), Buffer.alloc(50));
  if (opts.flavor !== null) {
    fs.writeFileSync(
      path.join(dir, `${name}.respawn.json`),
      JSON.stringify({
        world: name,
        flavor: opts.flavor ?? 'vanilla',
        mods: opts.mods ?? [],
        ...(opts.safeMods ? { mods_world_safe: opts.safeMods } : {}),
        ...(opts.alteringMods ? { mods_world_altering: opts.alteringMods } : {}),
      }),
    );
  }
}

describe('world library', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'respawn-worlds-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads the save-format version and world clock from the header', () => {
    writeWorld('vanilla', 'Respawn World', { version: 37, netTime: 380746.24 });
    const h = readWorldHeader(path.join(root, 'vanilla', 'worlds', 'Respawn World', 'Respawn World.db'));
    expect(h?.version).toBe(37);
    expect(h?.netTime).toBeCloseTo(380746.24, 2);
    expect(inGameDays(h!.netTime)).toBeCloseTo(211.5, 1);
  });

  it('survives an unreadable or truncated save rather than failing the whole listing', () => {
    const dir = path.join(root, 'vanilla', 'worlds', 'Truncated');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Truncated.db'), Buffer.alloc(4));
    expect(readWorldHeader(path.join(dir, 'Truncated.db'))).toBeUndefined();
    expect(readWorldHeader(path.join(dir, 'nope.db'))).toBeUndefined();
    expect(readLibrary(path.join(root, 'vanilla'), 'valheim')).toHaveLength(1);
  });

  it('reads names, flavor and mods, and skips .previous snapshots', () => {
    writeWorld('vanilla', 'Respawn World', { flavor: 'vanilla', mods: ['ValheimRcon.dll'] });
    fs.mkdirSync(path.join(root, 'vanilla', 'worlds', '.previous', 'Respawn World-2026'), { recursive: true });
    fs.writeFileSync(path.join(root, 'vanilla', 'worlds', '.previous', 'Respawn World-2026', 'Respawn World.db'), Buffer.alloc(64));
    const lib = readLibrary(path.join(root, 'vanilla'), 'valheim');
    expect(lib.map((w) => w.name)).toEqual(['Respawn World']);
    expect(lib[0]!.flavor).toBe('vanilla');
    expect(lib[0]!.mods).toEqual(['ValheimRcon.dll']);
  });

  it('reports an unstamped save as unknown provenance rather than assuming vanilla', () => {
    writeWorld('vanilla', 'Mystery', { flavor: null });
    expect(readLibrary(path.join(root, 'vanilla'), 'valheim')[0]!.flavor).toBeNull();
  });

  // A .db without its .fwl will not load, and the pair is easy to break by hand-copying.
  it('flags a save missing its .fwl', () => {
    writeWorld('vanilla', 'Half', { fwl: false });
    expect(readLibrary(path.join(root, 'vanilla'), 'valheim')[0]!.complete).toBe(false);
  });

  describe('divergence', () => {
    const copy = (service: string, version: number, netTime: number) => ({
      name: 'Respawn World', service, version, netTime,
      bytes: 1, flavor: 'vanilla', mods: [], modsWorldSafe: [], modsWorldAltering: [], complete: true,
    });

    // One world legitimately lives in several libraries — that is how a save moves
    // between the vanilla and modded servers. Only DISAGREEMENT matters.
    it('is silent when copies agree', () => {
      expect(divergence([copy('valheim', 37, 380746.24), copy('valheim-qol', 37, 380746.24)])).toBeNull();
    });

    it('is silent for a single copy', () => {
      expect(divergence([copy('valheim', 37, 380746.24)])).toBeNull();
    });

    // The exact case from the upgrade run: one library upgraded, the other not yet.
    it('reports a save-format split', () => {
      expect(divergence([copy('valheim', 35, 380746.24), copy('valheim-qol', 37, 380746.24)]))
        .toBe('save-format version');
    });

    it('reports a world-clock split — one copy has been played further', () => {
      expect(divergence([copy('valheim', 37, 380746.24), copy('valheim-qol', 37, 500000)]))
        .toBe('world clock');
    });

    it('reports both when both differ', () => {
      expect(divergence([copy('valheim', 35, 380746.24), copy('valheim-qol', 37, 500000)]))
        .toBe('save-format version and world clock');
    });

    // The branch case, and the reason provenance is checked at all. Running a save on a
    // modded rung stamps THAT copy `modded` for ever while its siblings stay `vanilla` —
    // and it changes neither the version nor the clock, so version+clock alone report
    // agreement about two copies that can no longer be used interchangeably.
    const branched = (service: string, flavor: string, altering: string[] = []) => ({
      name: 'IJT World', service, version: 37, netTime: 380746.24,
      bytes: 1, flavor, mods: altering, modsWorldSafe: [], modsWorldAltering: altering,
      complete: true,
    });

    it('reports a provenance split when one copy has been branched onto a modded rung', () => {
      expect(divergence([
        branched('valheim', 'vanilla'),
        branched('valheim-loot', 'modded', ['EpicLoot.dll']),
      ])).toBe('provenance');
    });

    it('treats an unstamped copy as disagreeing with a stamped one', () => {
      expect(divergence([
        branched('valheim', 'vanilla'),
        { ...branched('valheim-qol', 'vanilla'), flavor: null },
      ])).toBe('provenance');
    });

    it('reports provenance alongside the other splits', () => {
      expect(divergence([
        branched('valheim', 'vanilla'),
        { ...branched('valheim-loot', 'modded', ['EpicLoot.dll']), version: 35, netTime: 500000 },
      ])).toBe('save-format version and world clock and provenance');
    });
  });

  // The question is not "can it run without mods" — a modded save loads on vanilla
  // perfectly happily and silently deletes what the mods built. It is "what would that
  // cost", which is why the verdict is phrased as a consequence.
  describe('unmodded outlook', () => {
    it('is safe when no mod has run', () => {
      writeWorld('vanilla', 'Clean', { flavor: 'vanilla' });
      const w = readLibrary(path.join(root, 'vanilla'), 'valheim')[0]!;
      expect(unmoddedOutlook(w).verdict).toBe('safe');
      expect(unmoddedOutlook(w).detail).toMatch(/nothing mod-created/);
    });

    it('is safe when only world-safe mods have run, and says how many', () => {
      writeWorld('qol', 'Admin', {
        flavor: 'vanilla', mods: ['ValheimRcon.dll'], safeMods: ['ValheimRcon.dll'], alteringMods: [],
      });
      const w = readLibrary(path.join(root, 'qol'), 'valheim-qol')[0]!;
      expect(unmoddedOutlook(w).verdict).toBe('safe');
      expect(unmoddedOutlook(w).detail).toMatch(/1 mod\(s\) have run, all declared world-safe/);
    });

    // Naming the culprit is the point: "this is modded" does not tell you what you lose.
    it('names the world-altering mods when a vanilla load would destroy content', () => {
      writeWorld('qol', 'Tainted', {
        flavor: 'modded', mods: ['ValheimRcon.dll', 'EpicLoot.dll'],
        safeMods: ['ValheimRcon.dll'], alteringMods: ['EpicLoot.dll'],
      });
      const w = readLibrary(path.join(root, 'qol'), 'valheim-qol')[0]!;
      expect(unmoddedOutlook(w).verdict).toBe('DESTRUCTIVE');
      expect(unmoddedOutlook(w).detail).toMatch(/EpicLoot\.dll/);
      expect(unmoddedOutlook(w).detail).toMatch(/permanently/);
    });

    // Stamps written before the split have no mods_world_altering, so the detail must
    // still be truthful without inventing a culprit.
    it('degrades honestly on a stamp that predates the split', () => {
      writeWorld('qol', 'Old', { flavor: 'modded', mods: ['Something.dll'] });
      const w = readLibrary(path.join(root, 'qol'), 'valheim-qol')[0]!;
      expect(w.modsWorldAltering).toEqual([]);
      expect(unmoddedOutlook(w).verdict).toBe('DESTRUCTIVE');
      expect(unmoddedOutlook(w).detail).toMatch(/a mod that ran on it/);
    });

    it('is unknown, not safe, when the save is unstamped', () => {
      writeWorld('vanilla', 'Mystery2', { flavor: null });
      const w = readLibrary(path.join(root, 'vanilla'), 'valheim').find((x) => x.name === 'Mystery2')!;
      expect(unmoddedOutlook(w).verdict).toBe('UNKNOWN');
    });
  });
});
