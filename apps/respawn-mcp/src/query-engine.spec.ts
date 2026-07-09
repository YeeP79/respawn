import { describe, it, expect } from 'vitest';
import { runQuery } from './query-engine.js';
import type { Query } from './manifest.js';

// The cs16 "players" query, mirrored from apps/cs16/rcon-manifest.json, proving
// the manifest's own parse spec works — no game-specific code in the MCP.
const PLAYERS: Query = {
  name: 'players',
  description: 'connected players',
  rcon: 'status',
  singles: {
    hostname: '^hostname\\s*:\\s*(.+)$',
    map: '^map\\s*:\\s*(\\S+)',
    playerCount: '^players\\s*:\\s*(.+)$',
  },
  row: {
    match: '^#\\s*(?:\\d+\\s+)?(\\d+)\\s+"([^"]*)"\\s+(STEAM_\\S+|BOT|VALVE_\\S+)?',
    fields: ['userid', 'name', 'steamid'],
    skipIf: '^#\\s*userid',
  },
};

const STATUS = [
  'hostname:  Respawn CS 1.6',
  'map     :  de_dust2 at: 0 x, 0 y, 0 z',
  'players :  2 active (16 max)',
  '#      userid name uniqueid frag time ping loss adr',
  '# 3 "Ryan" STEAM_0:1:12345 5 12:30 45 0 1.2.3.4:27005',
  '# 5 "Bot Easy" BOT 2 3:10',
].join('\n');

describe('runQuery — manifest-driven parsing', () => {
  it('pulls single values from the whole reply', () => {
    const r = runQuery(PLAYERS, STATUS);
    expect(r['hostname']).toBe('Respawn CS 1.6');
    expect(r['map']).toBe('de_dust2');
    expect(r['playerCount']).toBe('2 active (16 max)');
  });

  it('extracts the userid/name/steamid rows the LLM needs', () => {
    const r = runQuery(PLAYERS, STATUS);
    expect(r.rows).toEqual([
      { userid: '3', name: 'Ryan', steamid: 'STEAM_0:1:12345' },
      { userid: '5', name: 'Bot Easy', steamid: 'BOT' },
    ]);
  });

  it('skips the column-header row via skipIf', () => {
    const r = runQuery(PLAYERS, STATUS);
    expect(r.rows?.map((row) => row['name'])).not.toContain('name');
  });

  it('always keeps the raw reply', () => {
    expect(runQuery(PLAYERS, STATUS).raw).toBe(STATUS);
  });

  it('returns empty rows for an idle server', () => {
    const r = runQuery(PLAYERS, 'hostname: x\nmap: de_dust2\nplayers: 0 active');
    expect(r.rows).toEqual([]);
  });

  it('handles a query with no row spec (singles only)', () => {
    const q: Query = { name: 'ver', description: '', rcon: 'version', singles: { v: 'v(\\d+)' } };
    expect(runQuery(q, 'server v48 build')['v']).toBe('48');
  });

  it('throws a clear error on an invalid regex in the manifest', () => {
    const q: Query = { name: 'bad', description: '', rcon: 'x', singles: { a: '(' } };
    expect(() => runQuery(q, 'anything')).toThrow(/Invalid query regex/);
  });
});
