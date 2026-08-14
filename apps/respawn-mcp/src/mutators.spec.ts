import { describe, it, expect } from 'vitest';
import {
  parseMutatorLine,
  parseTravelContext,
  applyMutatorChanges,
  buildTravelCommand,
  unknownMutators,
} from './mutators.js';

describe('parseTravelContext', () => {
  const LOADMAP =
    'LoadMap: DM-Turbine.unr?Name=Player?Class=Botpack.TMale2?team=255' +
    '?skin=SoldierSkins.blkt?Face=SoldierSkins.Othello?game=Botpack.DeathMatchPlus' +
    '?timelimit=15?mutator=MVES.MapVote,Relics.RelicRegen';

  it('recovers map, game class, mutators and match settings', () => {
    expect(parseTravelContext([LOADMAP])).toEqual({
      map: 'DM-Turbine',
      gametype: 'Botpack.DeathMatchPlus',
      mutators: ['MVES.MapVote', 'Relics.RelicRegen'],
      extras: { timelimit: '15' },
    });
  });

  // Player identity params must never be echoed back into a server travel.
  it('excludes per-player params from extras', () => {
    const extras = parseTravelContext([LOADMAP])!.extras;
    for (const key of ['name', 'class', 'team', 'skin', 'face', 'password']) {
      expect(extras).not.toHaveProperty(key);
    }
  });

  it('handles a map whose name contains brackets', () => {
    expect(parseTravelContext(['LoadMap: DM-Deck16][.unr?game=Botpack.DeathMatchPlus'])?.map).toBe(
      'DM-Deck16][',
    );
  });

  it('reports no mutators as an empty list, not a phantom entry', () => {
    expect(
      parseTravelContext(['LoadMap: DM-Peak.unr?game=Botpack.DeathMatchPlus'])?.mutators,
    ).toEqual([]);
  });

  it('takes the most recent LoadMap', () => {
    expect(
      parseTravelContext([
        'LoadMap: DM-Peak.unr?game=Botpack.DeathMatchPlus',
        'LoadMap: CTF-Face.unr?game=Botpack.CTFGame',
      ])?.map,
    ).toBe('CTF-Face');
  });

  it('returns undefined rather than guess when no LoadMap is present', () => {
    expect(parseTravelContext(['Mutators A.One'])).toBeUndefined();
  });

  it('skips a LoadMap with no game class rather than travel without one', () => {
    expect(parseTravelContext(['LoadMap: DM-Peak.unr?Name=Player'])).toBeUndefined();
  });
});

describe('parseMutatorLine', () => {
  it('reads the class list the engine echoed', () => {
    expect(
      parseMutatorLine([
        'InitGame: ?Name=Player?game=Botpack.DeathMatchPlus',
        'Mutators MVES.MapVote,FlagAnnouncementsV2.FlagAnnouncements,Relics.RelicRegen',
        'Add mutator MVES.MapVote',
      ]),
    ).toEqual([
      'MVES.MapVote',
      'FlagAnnouncementsV2.FlagAnnouncements',
      'Relics.RelicRegen',
    ]);
  });

  it('takes the most recent line when the level changed more than once', () => {
    expect(
      parseMutatorLine(['Mutators A.One,B.Two', 'Mutators C.Three']),
    ).toEqual(['C.Three']);
  });

  // "cannot tell" and "there are none" must not collapse: treating the first as the
  // second drops every running mutator on the next travel.
  it('returns undefined when no Mutators line is present', () => {
    expect(parseMutatorLine(['Server switch level: DM-Deck16][.unr'])).toBeUndefined();
  });

  it('does not mistake other log text for the list', () => {
    expect(parseMutatorLine(['[MVE] Mutators are configured elsewhere'])).toBeUndefined();
  });
});

describe('applyMutatorChanges', () => {
  it('adds without disturbing what is already running', () => {
    expect(
      applyMutatorChanges(['MVES.MapVote'], { add: ['Relics.RelicSpeed'] }),
    ).toEqual(['MVES.MapVote', 'Relics.RelicSpeed']);
  });

  it('removes case-insensitively, as UnrealScript resolves classes', () => {
    expect(
      applyMutatorChanges(['MVES.MapVote', 'Relics.RelicSpeed'], {
        remove: ['relics.relicspeed'],
      }),
    ).toEqual(['MVES.MapVote']);
  });

  it('will not add a duplicate', () => {
    expect(
      applyMutatorChanges(['MVES.MapVote'], { add: ['mves.mapvote'] }),
    ).toEqual(['MVES.MapVote']);
  });

  it('applies removals before additions so a re-add wins', () => {
    expect(
      applyMutatorChanges(['A.One'], { remove: ['A.One'], add: ['A.One'] }),
    ).toEqual(['A.One']);
  });
});

describe('buildTravelCommand', () => {
  it('carries map, game type, extras and mutators', () => {
    expect(
      buildTravelCommand({
        map: 'DM-Turbine',
        gametype: 'Botpack.DeathMatchPlus',
        mutators: ['MVES.MapVote', 'Relics.RelicRegen'],
        extras: { timelimit: '15' },
      }),
    ).toBe(
      'servertravel DM-Turbine.unr?game=Botpack.DeathMatchPlus?timelimit=15' +
        '?mutator=MVES.MapVote,Relics.RelicRegen',
    );
  });

  // An empty list must emit no ?mutator= at all — `?mutator=` with nothing after it is
  // not the same as omitting it, and is a plausible way to confuse the parser.
  it('omits the mutator param entirely when the list is empty', () => {
    expect(
      buildTravelCommand({ map: 'DM-Deck16][', gametype: 'Botpack.DeathMatchPlus', mutators: [] }),
    ).toBe('servertravel DM-Deck16][.unr?game=Botpack.DeathMatchPlus');
  });
});

describe('unknownMutators', () => {
  it('flags a class the manifest does not know', () => {
    expect(unknownMutators(['MVE2h.MapVote'], ['MVES.MapVote'])).toEqual(['MVE2h.MapVote']);
  });

  it('accepts a known class regardless of case', () => {
    expect(unknownMutators(['mves.mapvote'], ['MVES.MapVote'])).toEqual([]);
  });
});
