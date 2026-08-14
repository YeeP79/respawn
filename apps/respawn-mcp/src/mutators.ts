/**
 * Reading and composing a UE1 server's mutator list.
 *
 * Exists because the mutator list is ABSOLUTE: a `servertravel ...?mutator=` replaces
 * whatever is running, so "add one mutator" is really "resend every mutator, plus one".
 * Done by hand that silently drops whatever was forgotten — which is how map voting
 * turns itself off while looking like it is still on.
 *
 * The current set cannot be read from the `rules` query: that reports DISPLAY names
 * ("MapVote MVE2h"), not the classes a travel needs ("MVES.MapVote"), so it cannot be
 * round-tripped. The engine log can — it prints the exact class list it was given.
 */

/** `Mutators A.B,C.D` — the engine echoing the list it received at InitGame. */
const MUTATORS_LINE = /(?:^|\s)Mutators\s+([A-Za-z0-9_.]+(?:,[A-Za-z0-9_.]+)*)\s*$/;

/**
 * Extracts the mutator classes from the most recent `Mutators ...` line.
 *
 * Returns undefined when no such line is present — meaningfully different from an empty
 * list, which means the server genuinely loaded none. A caller must not treat "cannot
 * tell" as "there are none", or it will drop every running mutator on the next travel.
 */
export function parseMutatorLine(logLines: readonly string[]): string[] | undefined {
  for (let i = logLines.length - 1; i >= 0; i--) {
    const match = MUTATORS_LINE.exec(logLines[i]!);
    if (match?.[1]) {
      return match[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return undefined;
}

/** Player-supplied URL params on a LoadMap line — not match settings, never re-sent. */
const PLAYER_PARAMS = new Set([
  'name',
  'class',
  'team',
  'skin',
  'face',
  'voice',
  'checksum',
  'password',
  'game',
  'mutator',
]);

export interface TravelContext {
  map: string;
  gametype: string;
  mutators: string[];
  /** Match settings such as timelimit, which a travel also drops unless re-sent. */
  extras: Record<string, string>;
}

/**
 * Reconstructs what the running level was started with, from the engine's `LoadMap:`
 * line — the one place map, game class, mutators and match settings appear together.
 *
 * The `server_info` query cannot substitute: GameSpy reports the game type's SHORT name
 * ("DeathMatchPlus"), while a travel needs the fully qualified class
 * ("Botpack.DeathMatchPlus"), and the short name does not identify the class uniquely
 * once mods add their own variants.
 *
 * Returns undefined rather than a partial result — a caller must not travel on a guess.
 */
export function parseTravelContext(logLines: readonly string[]): TravelContext | undefined {
  for (let i = logLines.length - 1; i >= 0; i--) {
    const line = logLines[i]!;
    const at = line.indexOf('LoadMap: ');
    if (at < 0) continue;

    const url = line.slice(at + 'LoadMap: '.length).trim();
    const [rawMap, ...paramParts] = url.split('?');
    if (!rawMap) continue;

    const params = new Map<string, string>();
    for (const part of paramParts) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      params.set(part.slice(0, eq).toLowerCase(), part.slice(eq + 1));
    }

    const gametype = params.get('game');
    if (!gametype) continue;

    const extras: Record<string, string> = {};
    for (const [key, value] of params) {
      if (!PLAYER_PARAMS.has(key)) extras[key] = value;
    }

    return {
      map: rawMap.replace(/\.unr$/i, ''),
      gametype,
      mutators: (params.get('mutator') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      extras,
    };
  }
  return undefined;
}

/** Case-insensitive membership: UnrealScript class names are not case-sensitive. */
function includesClass(list: readonly string[], cls: string): boolean {
  return list.some((c) => c.toLowerCase() === cls.toLowerCase());
}

/**
 * Applies add/remove to a current set, preserving order and rejecting duplicates.
 * Removal is case-insensitive so `relics.relicregen` removes `Relics.RelicRegen`.
 */
export function applyMutatorChanges(
  current: readonly string[],
  changes: { add?: readonly string[]; remove?: readonly string[] },
): string[] {
  const removals = changes.remove ?? [];
  const kept = current.filter((c) => !includesClass(removals, c));
  const out = [...kept];
  for (const cls of changes.add ?? []) {
    if (!includesClass(out, cls)) out.push(cls);
  }
  return out;
}

/**
 * Composes the servertravel URL.
 *
 * Map and game type are carried explicitly because a travel that omits them does not
 * "keep" them — it falls back to defaults, so changing mutators would silently change
 * the map too. `extras` preserves URL-level match settings such as timelimit, which are
 * likewise lost if not re-sent.
 */
export function buildTravelCommand(params: {
  map: string;
  gametype: string;
  mutators: readonly string[];
  extras?: Readonly<Record<string, string>>;
}): string {
  const parts = [`${params.map}.unr`, `game=${params.gametype}`];
  for (const [key, value] of Object.entries(params.extras ?? {})) {
    parts.push(`${key}=${value}`);
  }
  if (params.mutators.length > 0) parts.push(`mutator=${params.mutators.join(',')}`);
  return `servertravel ${parts.join('?')}`;
}

/**
 * Flags classes that are not in the manifest's catalogue.
 *
 * Not an error — a server can run a mutator the manifest never listed — but it is worth
 * surfacing, because the failure mode for a misspelled class is nothing at all: the
 * console accepts it, the engine skips it, and no error appears anywhere.
 */
export function unknownMutators(
  requested: readonly string[],
  known: readonly string[],
): string[] {
  return requested.filter((cls) => !includesClass(known, cls));
}
