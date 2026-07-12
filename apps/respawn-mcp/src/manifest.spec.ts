import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseManifest, resolveCvarCommand, resolveWireCommand } from './manifest.js';
import { parseMapList } from './capabilities.js';
import { MOD_DATA_SCHEMAS } from './mod-data.js';

describe('parseManifest', () => {
  it('defaults service to the directory name', () => {
    const m = parseManifest({ commands: [] }, 'cs16');
    expect(m.service).toBe('cs16');
  });

  it('keeps an explicit service name', () => {
    const m = parseManifest({ service: 'custom', commands: [] }, 'cs16');
    expect(m.service).toBe('custom');
  });

  it('defaults commands and cvars to empty arrays', () => {
    const m = parseManifest({}, 'x');
    expect(m.commands).toEqual([]);
    expect(m.cvars).toEqual([]);
  });

  it('accepts a mod-flagged command', () => {
    const m = parseManifest(
      {
        commands: [
          { name: 'slap', description: 'AMX slap', rcon: 'amx_slap {p}', mod: 'amxmodx' },
        ],
      },
      'cs16',
    );
    expect(m.commands[0]!.mod).toBe('amxmodx');
  });

  it('accepts maps: "live" and an explicit list', () => {
    expect(parseManifest({ maps: 'live' }, 'x').maps).toBe('live');
    expect(parseManifest({ maps: ['de_dust2'] }, 'x').maps).toEqual(['de_dust2']);
  });

  it('rejects a command missing its rcon template', () => {
    expect(() =>
      parseManifest({ commands: [{ name: 'x', description: 'y' }] }, 'x'),
    ).toThrow();
  });

  it('rejects an unknown engine', () => {
    expect(() => parseManifest({ engine: 'quakeworld' }, 'x')).toThrow();
  });

  it('keeps an arg\'s allowed `values`', () => {
    const m = parseManifest(
      {
        commands: [
          {
            name: 'add_bot',
            description: 'd',
            rcon: 'addbot {skill}',
            args: { skill: { values: ['1', '2'] } },
          },
        ],
      },
      'x',
    );
    expect(m.commands[0]!.args!.skill!.values).toEqual(['1', '2']);
  });

  it('rejects a misspelled arg key rather than dropping it', () => {
    // `enum` was the old spelling; a non-strict schema silently discarded it and
    // the LLM lost the constraint with nothing in the build to say so.
    expect(() =>
      parseManifest(
        {
          commands: [
            {
              name: 'add_bot',
              description: 'd',
              rcon: 'addbot {skill}',
              args: { skill: { enum: ['1', '2'] } },
            },
          ],
        },
        'x',
      ),
    ).toThrow();
  });

  it('rejects an unknown key on a cvar and on the manifest root', () => {
    expect(() => parseManifest({ cvars: [{ name: 'g', vals: ['1'] }] }, 'x')).toThrow();
    expect(() => parseManifest({ notez: 'typo' }, 'x')).toThrow();
  });
});

describe('parseManifest modData (generic)', () => {
  it('passes arbitrary modData through when no schema is supplied', () => {
    const m = parseManifest({ modData: { anything: [1, 'two'] } }, 'x');
    expect(m.modData).toEqual({ anything: [1, 'two'] });
  });

  it('validates manifest-level modData against a supplied schema', () => {
    const schema = z.array(z.object({ name: z.string() }).strict());
    expect(parseManifest({ modData: [{ name: 'ok' }] }, 'x', schema).modData).toEqual([
      { name: 'ok' },
    ]);
    expect(() => parseManifest({ modData: [{ name: 1 }] }, 'x', schema)).toThrow();
    expect(() => parseManifest({ modData: [{ name: 'ok', extra: true }] }, 'x', schema)).toThrow();
  });

  it('validates per-command and per-query modData against the same schema', () => {
    const schema = z.object({ tier: z.number() }).strict();
    expect(() =>
      parseManifest(
        { commands: [{ name: 'c', description: 'd', rcon: 'r', modData: { tier: 'high' } }] },
        'x',
        schema,
      ),
    ).toThrow();
    expect(() =>
      parseManifest(
        { queries: [{ name: 'q', description: 'd', rcon: 'r', modData: { tier: 2 } }] },
        'x',
        schema,
      ),
    ).not.toThrow();
  });

  it('validates the ut99 shipped-mod catalogue with its registered schema', () => {
    const schema = MOD_DATA_SCHEMAS['ut99'];
    const good = [{ name: 'MonsterHunt', package: 'MonsterHunt', kind: 'gametype', control: 'admin' }];
    expect(parseManifest({ modData: good }, 'ut99', schema).modData).toEqual(good);
    // A control style outside the enum is a build-time failure, not a silent drop.
    expect(() =>
      parseManifest(
        { modData: [{ name: 'X', package: 'P', kind: 'mutator', control: 'sometimes' }] },
        'ut99',
        schema,
      ),
    ).toThrow();
  });
});

describe('parseMapList', () => {
  it('extracts bare map names from a GoldSrc "maps *" reply', () => {
    const raw = [
      'PUBLIC maps directory contents:',
      'de_dust2.bsp',
      'cs_office.bsp',
      'de_nuke.bsp',
      '',
      '75 maps in directory',
    ].join('\n');
    expect(parseMapList(raw)).toEqual(['cs_office', 'de_dust2', 'de_nuke']);
  });

  it('deduplicates and ignores non-map lines', () => {
    const raw = 'de_dust2.bsp\nsome noise\nde_dust2.bsp\n';
    expect(parseMapList(raw)).toEqual(['de_dust2']);
  });

  it('returns empty for an empty reply', () => {
    expect(parseMapList('')).toEqual([]);
  });
});

describe('resolveWireCommand', () => {
  const manifest = parseManifest(
    {
      queries: [
        { name: 'server_info', description: 'info', rcon: 'info', singles: { map: '^mapname=(.*)$' } },
        { name: 'players', description: 'players', rcon: 'players', singles: {} },
        { name: 'rules', description: 'rules', rcon: 'rules', singles: {} },
      ],
    },
    'ut99',
  );

  it('resolves a declared query name to its transport token', () => {
    // The regression: capture_raw server_info used to go on the wire as "server_info"
    // and be rejected, because its raw gamespy token is "info".
    expect(resolveWireCommand(manifest, 'server_info')).toBe('info');
  });

  it('is a no-op when a query name equals its token', () => {
    expect(resolveWireCommand(manifest, 'players')).toBe('players');
    expect(resolveWireCommand(manifest, 'rules')).toBe('rules');
  });

  it('passes an undeclared raw token through verbatim', () => {
    // Keeps capture_raw usable for authoring against an unfamiliar server.
    expect(resolveWireCommand(manifest, 'info')).toBe('info');
    expect(resolveWireCommand(manifest, 'basic')).toBe('basic');
    expect(resolveWireCommand(manifest, 'status')).toBe('status');
  });

  it('passes everything through when the service has no manifest', () => {
    expect(resolveWireCommand(undefined, 'status')).toBe('status');
    expect(resolveWireCommand(undefined, 'server_info')).toBe('server_info');
  });
});

describe('resolveCvarCommand', () => {
  const quake = parseManifest(
    { cvars: [{ name: 'sv_gravity', description: 'g' }] },
    'doom2',
  );
  const ue1 = parseManifest(
    {
      cvars: [
        {
          name: 'time_limit',
          description: 't',
          rcon: 'set Botpack.CTFGame TimeLimit {value}',
          read: 'get Botpack.CTFGame TimeLimit',
        },
        { name: 'broken', description: 'b', rcon: 'set Botpack.CTFGame TimeLimit' },
      ],
    },
    'ut99',
  );

  it('defaults to the Quake console form', () => {
    expect(resolveCvarCommand(quake, 'sv_gravity', '900')).toBe('sv_gravity "900"');
  });

  it('uses a declared template for a non-Quake console (UE1 has no cvars)', () => {
    // Shipping the Quake form here would silently do nothing on UT99.
    expect(resolveCvarCommand(ue1, 'time_limit', '20')).toBe(
      'set Botpack.CTFGame TimeLimit 20',
    );
  });

  it('falls back to the Quake form for an undeclared cvar', () => {
    expect(resolveCvarCommand(ue1, 'whatever', '1')).toBe('whatever "1"');
    expect(resolveCvarCommand(undefined, 'sv_gravity', '800')).toBe('sv_gravity "800"');
  });

  it('rejects a template with no {value} — it would "succeed" while changing nothing', () => {
    expect(() => resolveCvarCommand(ue1, 'broken', '5')).toThrow(/\{value\}/);
  });
});
