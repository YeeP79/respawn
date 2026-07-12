import { z } from 'zod';

/**
 * A single controllable action the LLM may invoke on a server. `rcon` is a
 * template; each `{name}` is filled from `args`. Mod-added commands are declared
 * here too — they cannot be discovered by any live query, only by the operator.
 *
 * `modData` carries optional server-defined, mod-specific data whose shape a service
 * pins with its own Zod schema (see MOD_DATA_SCHEMAS). It is the same schema whether
 * the data is authored here or, later, validated from a live server reply.
 */
const commandShape = {
  name: z.string(),
  description: z.string(),
  /** rcon template, e.g. `mp_friendlyfire {value}` or `amx_slap {player} {dmg}`. */
  rcon: z.string(),
  args: z
    .record(
      z
        .object({
          description: z.string().optional(),
          /** Allowed values; presented to the LLM as an enum. Spelled as in CvarSchema. */
          values: z.array(z.string()).optional(),
          type: z.enum(['string', 'int', 'float', 'bool']).optional(),
        })
        // An arg spec is pure data handed to the LLM — nothing here is read by code,
        // so a misspelled key would be silently dropped and the constraint lost.
        // `values` was once `enum` here while cvars said `values`; every manifest
        // wrote `values` and quake3's skill 1-5 enum vanished without a word.
        .strict(),
    )
    .optional(),
  /** Name of the mod that adds this command, if any (e.g. "amxmodx"). */
  mod: z.string().optional(),
  /** Flag destructive actions so the LLM (and the operator) treat them carefully. */
  danger: z.boolean().optional(),
  /**
   * The command is DECLARED but never confirmed to take effect on this transport. Tell the
   * user it may be a no-op and verify by effect (a follow-up query) — never trust the
   * transport's reply.
   *
   * This exists because UT99's UWeb console returns the identical "(command sent)" string for
   * a working command and for pure garbage, so "success" there is not evidence of anything.
   */
  unverified: z.boolean().optional(),
} as const;

export const CvarSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  default: z.string().optional(),
  values: z.array(z.string()).optional(),
  range: z.tuple([z.number(), z.number()]).optional(),
  mod: z.string().optional(),
  /**
   * How to SET this cvar on the wire, with `{value}` substituted. Optional: a Quake-style
   * console (goldsrc/source/q3/zandronum) takes `<name> "<value>"`, which is the default
   * and needs no template.
   *
   * It exists for consoles that are NOT Quake-style. UE1 (UT99) has no cvars at all — its
   * equivalent is `set <Package.Class> <Property> <Value>`, so ut99 declares e.g.
   * `"rcon": "set Botpack.CTFGame TimeLimit {value}"`. Verified against the real server:
   * `set` (and `get`) reach the engine exec chain through the UWeb console.
   */
  rcon: z.string().optional(),
  /** How to READ this cvar back, if the console supports it (UE1: `get <Class> <Prop>`). */
  read: z.string().optional(),
}).strict();

/**
 * Maps a server offers. `"live"` means query the running server (`maps *`);
 * an explicit array is used when the server is off or the list is curated.
 */
export const MapsSchema = z.union([z.literal('live'), z.array(z.string())]);

/**
 * A structured read of the server, defined entirely in data so no game- or
 * mod-specific parsing lives in the MCP. The MCP runs `rcon`, then applies these
 * patterns generically. `singles` pull one value each from the whole reply;
 * `row` is applied per line to build an array of records.
 */
const queryShape = {
  name: z.string(),
  description: z.string(),
  /** rcon command whose reply is parsed, e.g. "status". */
  rcon: z.string(),
  /** Whole-reply single values: field name → regex with one capture group. */
  singles: z.record(z.string()).optional(),
  /** Per-line record extraction. */
  row: z
    .object({
      /** Regex applied to each line; capture groups map positionally to `fields`. */
      match: z.string(),
      /** Field names for the capture groups, in order. */
      fields: z.array(z.string()),
      /** Optional: lines matching this regex are skipped (e.g. column headers). */
      skipIf: z.string().optional(),
    })
    .strict()
    .optional(),
} as const;

/**
 * Builds a manifest schema whose `modData` (on the manifest and on each command and
 * query) is validated by `modData`. The whole manifest is generic over one type so a
 * service can pin the shape of its custom mod data once and have it checked wherever
 * it appears. `z.unknown()` (the default) makes `modData` an unchecked passthrough —
 * the behaviour every un-typed service already had.
 */
export function makeManifestSchema<T extends z.ZodTypeAny>(modData: T) {
  const commandSchema = z.object({ ...commandShape, modData: modData.optional() }).strict();
  const querySchema = z.object({ ...queryShape, modData: modData.optional() }).strict();
  return z
    .object({
      /** Service name; defaults to the app directory name if omitted. */
      service: z.string().optional(),
      displayName: z.string().optional(),
      engine: z.enum(['goldsrc', 'source', 'source2', 'idtech3', 'other']).optional(),
      commands: z.array(commandSchema).default([]),
      cvars: z.array(CvarSchema).default([]),
      queries: z.array(querySchema).default([]),
      maps: MapsSchema.optional(),
      notes: z.string().optional(),
      /** Server-defined mod data, shape pinned per service (see MOD_DATA_SCHEMAS). */
      modData: modData.optional(),
    })
    .strict();
}

/** Default command/query schemas: `modData` is an unchecked passthrough. */
export const CommandSchema = z.object({ ...commandShape, modData: z.unknown().optional() }).strict();
export const QuerySchema = z.object({ ...queryShape, modData: z.unknown().optional() }).strict();

/** The default manifest schema: `modData` is an unchecked passthrough. */
export const ManifestSchema = makeManifestSchema(z.unknown());

export type Command = z.infer<typeof CommandSchema>;
export type Cvar = z.infer<typeof CvarSchema>;
export type Query = z.infer<typeof QuerySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Parses and validates raw manifest JSON. A caller that passes a `modDataSchema`
 * (the generator looks one up per service in MOD_DATA_SCHEMAS) has that manifest's
 * custom `modData` validated against it; otherwise `modData` is an unchecked
 * passthrough, so behaviour is unchanged for services without one.
 *
 * The schema is injected rather than imported here so this module stays dependency-
 * free — the build-time generator loads it with node's type-stripping, which does
 * not resolve nested relative imports.
 *
 * @param serviceName - Directory name, used as the default `service`.
 * @throws With a readable message when the manifest is malformed — the generator
 *   fails the build rather than shipping a broken manifest.
 */
export function parseManifest(
  raw: unknown,
  serviceName: string,
  modDataSchema: z.ZodTypeAny = z.unknown(),
): Manifest {
  const parsed = makeManifestSchema(modDataSchema).parse(raw);
  return { ...parsed, service: parsed.service ?? serviceName } as Manifest;
}

/**
 * The string to put on the wire for a raw capture.
 *
 * A declared query NAME resolves to its transport token (`server_info` -> `info`) — that
 * mapping already lives in the manifest's `rcon` field, and making the caller know it
 * defeats the point: `capture_raw server_info` used to fail while `capture_raw players`
 * worked, purely because the latter's name happens to equal its token.
 *
 * Anything that is not a declared query name passes through VERBATIM, which is what keeps
 * `capture_raw` usable against a server that has no manifest yet — its entire purpose. So
 * raw tokens (`info`, `basic`, `status`) still work untouched.
 *
 * A manifest name wins over a same-spelled raw token. That is the right precedence (the
 * manifest is the service's declared surface) and is a no-op in practice: a query named
 * `players`/`rules` maps to exactly that token anyway.
 */
export function resolveWireCommand(
  manifest: Manifest | undefined,
  command: string,
): string {
  return manifest?.queries.find((q) => q.name === command)?.rcon ?? command;
}

/**
 * The wire command that sets a cvar to `value`.
 *
 * Quake-family consoles take `<name> "<value>"` — that is the default and covers
 * goldsrc/source/q3/zandronum. A manifest may override it per-cvar with an `rcon` template
 * containing `{value}`, which is what makes non-Quake consoles work at all: UE1 (UT99) has
 * no cvars, only `set <Package.Class> <Property> <Value>`, so shipping the Quake form there
 * silently does nothing.
 *
 * @throws When a declared template has no `{value}` placeholder — that would send a command
 *   with the value dropped, which "succeeds" while changing nothing.
 */
export function resolveCvarCommand(
  manifest: Manifest | undefined,
  cvar: string,
  value: string,
): string {
  const template = manifest?.cvars.find((c) => c.name === cvar)?.rcon;
  if (template === undefined) return `${cvar} "${value}"`;
  if (!template.includes('{value}')) {
    throw new Error(
      `Cvar "${cvar}" declares an rcon template with no {value} placeholder: ${template}`,
    );
  }
  return template.replaceAll('{value}', value);
}
