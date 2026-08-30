import { describe, it, expect } from 'vitest';
import { resolveFamilies, formatFamilies } from './capabilities.js';

describe('resolveFamilies', () => {
  const base = {
    serviceDisplayName: 'Test',
    rconControl: { enabled: false },
    worldSync: { enabled: false },
    persistentStorage: { enabled: false, mountPath: '/config' },
    idleShutdown: { enabled: false },
    secretRefs: [] as ReadonlyArray<{ containerEnvVar: string }>,
  };

  // The distinction the whole capability view exists for: a service with no transport is
  // administered a different way, while one with a manifest and no transport is broken.
  // Collapsing them into "unavailable" loses the only bit that says whether to act.
  it('reports a manifest with no transport as drift', () => {
    const f = resolveFamilies('cs2', base, false);
    expect(f.commands.available).toBe(false);
    if (!f.commands.available) {
      expect(f.commands.kind).toBe('drift');
      expect(f.commands.reason).toMatch(/ENABLE_RCON_CONTROL is off/);
    }
  });

  it('reports no transport and no manifest as no-transport', () => {
    const f = resolveFamilies('not-a-service', base, false);
    expect(f.commands.available).toBe(false);
    if (!f.commands.available) expect(f.commands.kind).toBe('no-transport');
  });

  // Must NOT assert the game has no console: config cannot distinguish "offers none"
  // from "nobody enabled it", and Valheim being the former took research, not a config read.
  it('does not claim a game lacks a console when only the flag is off', () => {
    const f = resolveFamilies('not-a-service', base, false);
    if (!f.commands.available) {
      expect(f.commands.reason).toMatch(/Either the game has no remote console, or one exists/);
    }
  });

  it('reports a transport with no manifest as no-manifest', () => {
    const f = resolveFamilies('not-a-service', { ...base, rconControl: { enabled: true } }, false);
    expect(f.commands.available).toBe(false);
    if (!f.commands.available) expect(f.commands.kind).toBe('no-manifest');
  });

  it('counts commands, queries and unverified ones when both halves are present', () => {
    const f = resolveFamilies('valheim-admin', { ...base, rconControl: { enabled: true } }, false);
    expect(f.commands.available).toBe(true);
    if (f.commands.available) {
      expect(f.commands.commandCount).toBeGreaterThan(0);
      expect(f.commands.queryCount).toBeGreaterThan(0);
      // `unverified` tracks which commands have actually been EXECUTED against a live
      // server, and it is meaningful in both directions: most of this surface was
      // authored from the server's own `list` and never run, while dropthat:reload was
      // exercised on a real valheim-loot task. Asserting "all of them" once passed only
      // because nothing had been verified yet, and would fail every time somebody did
      // the work of verifying one.
      expect(f.commands.unverified).toBeGreaterThan(0);
      expect(f.commands.unverified).toBeLessThanOrEqual(f.commands.commandCount);
    }
  });

  it('surfaces the non-command families', () => {
    const f = resolveFamilies(
      'valheim',
      {
        ...base,
        worldSync: { enabled: true },
        persistentStorage: { enabled: true, mountPath: '/config' },
        secretRefs: [{ containerEnvVar: 'SERVER_PASS' }],
      },
      true,
    );
    expect(f.worldSaves).toBe(true);
    expect(f.contentPayload).toBe(true);
    expect(f.secrets).toEqual(['SERVER_PASS']);
    expect(f.persistentMountPath).toBe('/config');
    expect(formatFamilies(f)).toMatch(/world saves/);
  });
});
