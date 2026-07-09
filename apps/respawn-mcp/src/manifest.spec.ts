import { describe, it, expect } from 'vitest';
import { parseManifest } from './manifest.js';
import { parseMapList } from './capabilities.js';

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
