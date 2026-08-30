# Respawn — where we are (2026-08-29)

Read `CLAUDE.md` first for the gotchas. This file is **current state and next step**.

---

## State right now

**`main` is at `0531be7` and pushed.** `feat/goldsrc-mod-variants` was fast-forwarded
into it — 25 commits, including all the tfc/cs16-kz/mysql/goldsrc work that had been
sitting unmerged, plus the Valheim work below. Working tree clean.

**Every server is scaled to zero. Nothing is billing** beyond S3/EFS storage.

`valheim` (vanilla) has **never been deployed** — its stack does not exist yet.

---

## What Valheim now is

Two variants, deliberately separate services:

| | `valheim` (vanilla) | `valheim-modded` |
|---|---|---|
| Mods | none | BepInEx, plugins from S3 |
| Mid-game admin | **impossible** — Valheim has no remote console | rcon via ValheimRcon |
| Image | upstream `IMAGE_URI` | local build (rcon config shim) |
| Crossplay | on | **off** — required for mods; PC/Steam only |

Separate stacks mean separate EFS volumes and disjoint S3 prefixes, so neither can reach
the other's world.

**World saves round-trip.** The `world-sync` sidecar seeds from a one-shot `inbox/` and
mirrors the volume back to `live/` on an interval and on SIGTERM. Drive it with
`list_worlds`, `world_status`, `publish_world`, `pull_world`, `clear_world`,
`switch_world` — or `pnpm valheim:world:*`.

**Saves carry provenance.** `<world>.respawn.json` records flavor, which plugins ran, and
each run. A save that has run a **world-altering** mod is refused by the vanilla server
for ever. A mod declared `world-safe` in `mods.txt` (an rcon listener writes no prefabs)
leaves the save `vanilla` and returnable.

**There is no default world**, on purpose. Valheim generates an empty world under an
unknown name rather than failing, so every deploy must name one.

### The worlds

| World | Version | State |
|---|---|---|
| `IJT World` | v37 | **canonical.** 211.5 in-game days. Upgraded from v35 on 2026-08-29 |
| `IJT World 2024` | v33 | 19.2 days. May-2024 snapshot of the same seed — **the designated experiment world** |

Two byte-identical v35 backups of `IJT World` exist under `worlds/.previous/`
(`77ed7c64…`, matching the original archive extraction). The source archive is deleted;
`apps/*/worlds/` is gitignored and is the **only** copy — it needs a backup that is not
this repo.

---

## ▶ NEXT: real (world-altering) game mods

Everything so far used exactly one mod, and a world-safe one. Bringing in EpicLoot,
PlantEverything, Warfare etc. crosses a line the current setup guards but has never
exercised.

**The one-way door.** A prefab-adding mod writes ZDOs into the save. Remove the mod and
Valheim deletes those objects on load, rewriting a continuous object stream — usually
unrepairable. The clock guard cannot catch this: a damaged save has *more* play on it,
not less. So:

- Experiment on **`IJT World 2024`**, never `IJT World`.
- Snapshot to a new name in `worlds/` before enabling anything prefab-adding. Nothing
  automatic can overwrite a differently-named world.

**Open questions nobody has answered:**

1. **Which mods.** Not chosen. `mods.txt` holds only `Tristan/ValheimRcon 1.5.1
   world-safe`. Pin exact versions — "latest" on server and client are not the same thing.
2. **Client parity.** Every player needs the identical set at identical versions or they
   cannot connect. Export an r2modman modpack code and hand it out. Untested with more
   than zero players.
3. **Mod config files are NOT solved in general.** ValheimRcon's password needed a shim
   (`respawn-rcon-config.sh` on `PRE_SERVER_RUN_HOOK`) because BepInEx reads config from
   `/opt/valheim/bepinex/BepInEx/config/`, which no sidecar mounts — a file written to
   `/config/bepinex/config/` is silently never read. **Any config-driven mod hits this.**
   The shim is currently hard-coded to one plugin's file; a second configured mod needs it
   generalised.
4. **`world-safe` is an operator assertion**, not derivable from a `.dll`. Default is
   unsafe. Only mark a mod world-safe if you are confident it writes no prefabs — it is
   recorded in every world's stamp so the claim is auditable, but nothing checks it.
5. **30 manifest commands are `unverified`.** Reconciled against the server's own `list`
   for name and signature, but only `list`, `server_stats`, `time` and `save` have been
   run. Clear flags as they are exercised.

**To get a modded session going:** add to `mods.txt` → `pnpm valheim:mods:fetch modded` →
`pnpm valheim:mods:publish modded respawn` → `publish_world` → `switch_world` → play →
`pull_world`.

---

## L4D2 spikes — unchanged

`docs/spikes/` — six of eight pass. **S4 and S6 remain, both need a human with L4D2
open.** S4 decides whether custom campaigns are a setting or their own server; S6 defines
the fifth-player ritual. Neither moved this session.

---

## Fleet health worth knowing

`list_services` reports which tool families apply per service. It surfaced six services
shipping an `rcon-manifest.json` with `ENABLE_RCON_CONTROL` **off** — declared commands
that cannot be reached: `cs2`, `css`, `gmod`, `l4d2`, `quake3`, `tf2`. Left alone
deliberately; you said those were never really set up.

---

## Facts worth not re-deriving

- **AWS**: account `847378615943`, `us-east-1`, profile `respawn`. Log in with
  `aws sso login --profile respawn` (add `--use-device-code` if the browser is signed into
  the work portal).
- **Secrets exist** for `valheim` (`SERVER_PASS`) and `valheim-modded` (`SERVER_PASS`,
  `RCON_PASSWORD`). Read one back with `reveal_secret` — the join password is not in any
  transcript.
- **State bucket** `respawn-state-847378615943` is private and versioned; the FastDL
  bucket is public-read by necessity. Never put a world in the latter.
- **Valheim world data version is 37** as of 2026-08-29. Upgrades are one-way.
- **The MCP is a separate process from the built bundle.** After changing
  `apps/respawn-mcp`, rebuild *and* `/mcp` to reconnect, or you are driving stale code.
