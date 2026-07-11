import { describe, it, expect } from 'vitest';
import {
  parseTransportInfo,
  manifestSummary,
  clampSample,
  summariseSamples,
} from './introspection.js';
import type { Manifest } from './manifest.js';

describe('parseTransportInfo', () => {
  it('reads the sidecar --info key=value lines', () => {
    const raw = 'service=ut99\nprotocol=gamespy\ntarget=127.0.0.1:7778';
    expect(parseTransportInfo(raw)).toEqual({
      service: 'ut99',
      protocol: 'gamespy',
      target: '127.0.0.1:7778',
    });
  });

  it('ignores unknown keys and blank lines rather than failing', () => {
    const raw = '\nservice=cs16\nfuture_field=whatever\n';
    expect(parseTransportInfo(raw)).toEqual({ service: 'cs16' });
  });

  it('reads a second write transport when the sidecar reports one (UT99)', () => {
    const raw = [
      'service=ut99',
      'protocol=gamespy',
      'target=127.0.0.1:7778',
      'write_protocol=uweb',
      'write_target=127.0.0.1:5580',
    ].join('\n');
    expect(parseTransportInfo(raw)).toEqual({
      service: 'ut99',
      protocol: 'gamespy',
      target: '127.0.0.1:7778',
      writeProtocol: 'uweb',
      writeTarget: '127.0.0.1:5580',
    });
  });
});

describe('manifestSummary', () => {
  it('returns undefined when there is no manifest', () => {
    expect(manifestSummary(undefined)).toBeUndefined();
  });

  it('lists the declared query, command and cvar names', () => {
    const m: Manifest = {
      service: 'x',
      displayName: 'X',
      engine: 'goldsrc',
      commands: [{ name: 'change_map', description: 'd', rcon: 'map {m}' }],
      cvars: [{ name: 'sv_gravity' }],
      queries: [{ name: 'players', description: 'd', rcon: 'status' }],
    };
    expect(manifestSummary(m)).toEqual({
      displayName: 'X',
      engine: 'goldsrc',
      queries: ['players'],
      commands: ['change_map'],
      cvars: ['sv_gravity'],
    });
  });
});

describe('clampSample', () => {
  it('holds count and interval within safe bounds', () => {
    // The interval floor exists because rapid exec sessions drop the SSM channel.
    expect(clampSample(50, 0)).toEqual({ count: 10, intervalSeconds: 3 });
    expect(clampSample(0, 999)).toEqual({ count: 1, intervalSeconds: 60 });
    expect(clampSample(4, 12)).toEqual({ count: 4, intervalSeconds: 12 });
  });

  it('floors a fractional count', () => {
    expect(clampSample(3.9, 10).count).toBe(3);
  });
});

describe('summariseSamples', () => {
  it('collapses to distinct values in first-seen order and counts misses', () => {
    const { distinct, misses } = summariseSamples([
      { n: 1, value: '0' },
      { n: 2, value: null },
      { n: 3, value: '1' },
      { n: 4, value: '1' },
      { n: 5, value: '0' },
    ]);
    expect(distinct).toEqual(['0', '1']);
    expect(misses).toBe(1);
  });

  it('reports all-miss runs without inventing a value', () => {
    expect(summariseSamples([{ n: 1, value: null }, { n: 2, value: null }])).toEqual({
      distinct: [],
      misses: 2,
    });
  });
});
