import { z } from 'zod';

/**
 * Per-service schemas for a manifest's custom `modData`. A service that carries
 * mod-specific data registers its shape here; `parseManifest` looks it up by service
 * name and validates against it. Absent, `modData` falls back to an unchecked
 * passthrough (`z.unknown()`), so a service without an entry behaves exactly as before.
 *
 * The same schema is reusable if mod data is later read live from a running server:
 * validate the server's reply with the service's schema before processing it.
 */

/**
 * A shipped mod catalogued in a manifest. `kind` separates game types (selected via
 * a servertravel `?game=` class) from mutators (loaded into a game). `control` says
 * how — if at all — it can be driven remotely: `admin` mods answer to console
 * commands, `player` mods take an in-game client command, `passive` mods only run.
 */
const ModEntrySchema = z
  .object({
    name: z.string(),
    /** ServerPackage / class the image loads it under (e.g. "MonsterHunt"). */
    package: z.string(),
    kind: z.enum(['gametype', 'mutator']),
    control: z.enum(['admin', 'player', 'passive']),
    /** The .ini it reads its config from, when it has one. */
    configFile: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

/** UT99 (roemer/ut99-server) ships a fixed set of mods; the manifest catalogues them. */
export const Ut99ModData = z.array(ModEntrySchema);
export type Ut99ModData = z.infer<typeof Ut99ModData>;

export const MOD_DATA_SCHEMAS: Record<string, z.ZodTypeAny> = {
  ut99: Ut99ModData,
};
