import { z } from 'zod';

/**
 * A single controllable action the LLM may invoke on a server. `rcon` is a
 * template; each `{name}` is filled from `args`. Mod-added commands are declared
 * here too — they cannot be discovered by any live query, only by the operator.
 */
export const CommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** rcon template, e.g. `mp_friendlyfire {value}` or `amx_slap {player} {dmg}`. */
  rcon: z.string(),
  args: z
    .record(
      z.object({
        description: z.string().optional(),
        /** Allowed values; presented to the LLM as an enum. */
        enum: z.array(z.string()).optional(),
        type: z.enum(['string', 'int', 'float', 'bool']).optional(),
      }),
    )
    .optional(),
  /** Name of the mod that adds this command, if any (e.g. "amxmodx"). */
  mod: z.string().optional(),
  /** Flag destructive actions so the LLM (and the operator) treat them carefully. */
  danger: z.boolean().optional(),
});

export const CvarSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  default: z.string().optional(),
  values: z.array(z.string()).optional(),
  range: z.tuple([z.number(), z.number()]).optional(),
  mod: z.string().optional(),
});

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
export const QuerySchema = z.object({
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
    .optional(),
});

export const ManifestSchema = z.object({
  /** Service name; defaults to the app directory name if omitted. */
  service: z.string().optional(),
  displayName: z.string().optional(),
  engine: z.enum(['goldsrc', 'source', 'source2', 'idtech3', 'other']).optional(),
  commands: z.array(CommandSchema).default([]),
  cvars: z.array(CvarSchema).default([]),
  queries: z.array(QuerySchema).default([]),
  maps: MapsSchema.optional(),
  notes: z.string().optional(),
});

export type Command = z.infer<typeof CommandSchema>;
export type Cvar = z.infer<typeof CvarSchema>;
export type Query = z.infer<typeof QuerySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Parses and validates raw manifest JSON.
 *
 * @param serviceName - Directory name, used as the default `service`.
 * @throws With a readable message when the manifest is malformed — the generator
 *   fails the build rather than shipping a broken manifest.
 */
export function parseManifest(raw: unknown, serviceName: string): Manifest {
  const parsed = ManifestSchema.parse(raw);
  return { ...parsed, service: parsed.service ?? serviceName };
}
