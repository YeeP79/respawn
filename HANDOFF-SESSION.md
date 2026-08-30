# Respawn — where we are (2026-08-30)

Read `CLAUDE.md` first for the gotchas. This file is **current state and next step**.

---

## State right now

**Branch `feat/valheim-mod-variants`, off `main` `af8fa34`.** The variant lattice, the
world-sync guards, the MCP command gating, the world placement, and this doc. `main`
itself is unchanged and pushed.

**Every server is scaled to zero. Nothing is billing** beyond S3/EFS storage.

Stacks that exist: `respawn-dev-valheim-{admin,qol,loot,build,overhaul}` — all five modded
variants, all at desiredCount 0. Only `valheim` (the crossplay vanilla one) has **never
been deployed**. `respawn-dev-valheim-modded` was destroyed on 2026-08-29 and is gone.

---

## What Valheim now is

Six variants, deliberately separate services. A variant is a **ruleset** (which mods load,
what can drive the server) and NOT a world — which world runs on one is a deploy-time
choice, and a save can sit in several libraries at once.

| Variant | Mods | Client install | Worlds stamped | Deployed? |
|---|---|---|---|---|
| `valheim` | none, crossplay **on** (Xbox can join) | none | `vanilla` | never |
| `valheim-admin` | rcon only | none | `vanilla` | **yes — `IJT World`** |
| `valheim-qol` | + convenience (5 pkgs) | small | `vanilla` | **yes — `IJT World`** |
| `valheim-loot` | + EpicLoot, CLLC, Drop/Spawn That | ~40 MB | **`modded`** | **yes — `IJT World` (branched)** |
| `valheim-build` | + OdinArchitect, OdinsKingdom, PlantEverything | ~50 MB | **`modded`** | yes, no world yet |
| `valheim-overhaul` | union of both + Therzie suite | ~500 MB | **`modded`** | yes, no world yet |

Every modded variant: BepInEx, plugins from S3, crossplay **off** (required for mods —
PC/Steam only), local image build (one shared rcon config shim).

They are a lattice: `qol → loot → overhaul` and `qol → build → overhaul`. `loot` and
`build` are siblings a world cannot move between. `variants/overhaul/mods.txt` *includes*
both rather than restating them, so the shape cannot drift.

`valheim-modded` **was renamed to `valheim-admin`** — its only mod was the admin console,
so the old name described how it was built rather than what it is for. That migration is
complete: the old stack is destroyed and `valheim-admin` is deployed in its place.

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

**A world put on a modded rung BRANCHES.** Each variant's library is its own files, so
`IJT World` is now four copies: `vanilla` in `valheim`/`admin`/`qol`, `modded` in `loot`.
They started byte-identical apart from the stamp — same version, same clock — which is
why `list_worlds` now compares provenance and renders a diverged group per copy. See
CLAUDE.md.

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

## ▶ NEXT: valheim-build and valheim-overhaul have no world

**All five modded variants are now deployed and proven end to end** (2026-08-30), every
one scaled back to 0. Nothing is billing beyond storage.

| Variant | World it ran | Stamp it produced | Plugins loaded |
|---|---|---|---|
| `valheim-admin` | `IJT World` | **vanilla** (all world-safe) | 1 |
| `valheim-qol` | `IJT World` | **vanilla** (all world-safe) | 6 |
| `valheim-loot` | `IJT World` | **modded** (Jotunn, EpicLoot) | 13 |
| `valheim-build` | `smoketest` (throwaway) | modded | 10 |
| `valheim-overhaul` | `smoketest` (throwaway, prev. session) | modded | 21 |

Each was verified by rcon on the running task, not inferred: `admin`, `qol` and `loot`
all answered `server_stats` with **Day 211, 651963 objects** — the real world, loaded.
`build` answered Day 1 / 0 objects, which is the throwaway behaving correctly.

### The world decision, made

`IJT World` was **branched onto `valheim-loot`** — a deliberate one-way choice. The rule
that matters: a variant's `worlds/` library is its own set of files, so this did NOT move
the world. The copies in `valheim`, `valheim-admin` and `valheim-qol` are untouched and
still `vanilla`; the loot copy alone is stamped `modded` and can never go back.

`loot` was chosen over `build` because a save there can still **climb** to
`valheim-overhaul` (a superset of its plugin set). It can never move sideways to
`valheim-build`, which has no EpicLoot or CLLC.

The loot library copy was `pull_world`ed after the run, so it now carries the modded
stamp rather than the pre-branch one.

### Still to do

1. **Decide a world for `valheim-build` and `valheim-overhaul`.** Both are proven but
   worldless — they ran throwaways. `build` is a sibling of `loot`, so a save cannot be
   carried between them; the candidates are `IJT World 2024` (the 19.2-day snapshot of
   the same seed, `hTL4AabAVHUo`) or another branch of `IJT World`. Each needs the save
   copied into `apps/valheim/variants/<v>/worlds/` and a `DEPLOY_PROMPTS` line, exactly
   as `loot` and `qol` now have.
2. **`valheim` (crossplay/vanilla) has never been deployed.** It has both worlds in its
   library and a `DEPLOY_PROMPTS` already, so it is one `switch_world` away.
3. **`/mcp` reconnect.** `list_worlds` was fixed and the bundle rebuilt this session, so
   the running process is stale again.
4. **`IJT World` still has no backup outside this repo.** Unchanged, and still the
   single most valuable loose end. There are now three S3 `live/` copies (admin, qol,
   loot) but they are in the same account as everything else.

## Open questions, updated

1. ~~**Which mods.**~~ **Answered.** Classified by measurement, not lore: a mod is
   world-altering if it registers prefabs (`RegisterPrefab`/`PrefabManager`/`Custom*` plus
   an embedded `UnityFS` bundle in its DLL). Sets are pinned in the manifests and locked
   in each variant's tracked `mods.lock`.
2. **Client parity.** Still untested with more than zero players. `mods.lock` is now the
   authoritative list to build the r2modman modpack from.
3. **Mod config files are STILL not solved in general.** ValheimRcon's password needed a
   shim on `PRE_SERVER_RUN_HOOK` because BepInEx reads config from
   `/opt/valheim/bepinex/BepInEx/config/`, which no sidecar mounts. The shim is still
   hard-coded to one plugin's file; a second configured mod needs it generalised. **None
   of the mods added here is config-file driven**, so nothing forced the issue yet.
4. **`world-safe` is still an operator assertion.** But it is now a *checked-against*
   assertion: the mechanical screen is recorded per package in the manifests, and `Jotunn`
   is explicitly NOT flagged (four asset bundles, calls `AddPrefab`) which is why
   `mods-qol.txt` must stay Jotunn-free.
5. **Every manifest command is still `unverified`, deliberately.** `dropthat:reload` is
   ACCEPTED by the console (unlike EpicLoot's, which are rejected) but its effect was never
   observed — no config re-read was logged — and the manifest's own bar for clearing the
   flag is "executed AND seen to take effect". Clear it once a config change is seen to
   take hold. The manifest is shared at the project level, so clearing a flag fixes it for
   all five modded variants at once.
6. **Mod console commands are reachable but mostly useless, and now fully enumerated.**
   `consoleCommand` answers `Command 'X' executed.` regardless of outcome, so results are
   read from `server_logs` and a typo is indistinguishable from success. EpicLoot's 30
   commands answer "not valid in the current context" on a dedicated server — they need a
   player. The fleet's entire mod-provided surface is Drop That's three plus Spawn That's
   five; `valheim-overhaul`'s 82 console commands are byte-identical to `valheim-loot`'s,
   so the Therzie suite adds none despite all four DLLs containing the string
   `ConsoleCommand`. Declared with `requires`, so they appear on `loot`/`overhaul` and are
   refused elsewhere. See CLAUDE.md.
7. **Patcher delivery is a missing capability.** A BepInEx *patcher* cannot be installed by
   this pipeline (the upstream image syncs only `plugins/`), and `fetch-mods.sh` refuses
   one rather than building a payload that silently does nothing. This is why `PlanBuild`
   is absent from `valheim-build`. Adding it means a second published prefix, a second
   sidecar sync, and a copy into `/opt` from the shim.

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
- **Secrets exist for every service**: `valheim` (`SERVER_PASS`) and all five modded
  variants (`SERVER_PASS` + `RCON_PASSWORD`), created 2026-08-30. The join password was
  COPIED from the retired `valheim-modded` secret, so players need no new one; each rcon
  password is freshly generated per service. `respawn/valheim-modded/*` still exists and is
  now unreferenced — safe to delete once nobody wants the old join password back.
  Read one back with `reveal_secret` — the join password is not in any transcript.
- **State bucket** `respawn-state-847378615943` is private and versioned; the FastDL
  bucket is public-read by necessity. Never put a world in the latter.
- **Valheim world data version is 37** as of 2026-08-29. Upgrades are one-way.
- **Smoketest residue is cleaned.** `valheim-overhaul/live/` and `valheim-build/live/`
  both held a fabricated `smoketest` world; both were deleted 2026-08-30. The bucket is
  versioned, so the delete markers are reversible. Only `admin`, `qol` and `loot` have
  anything in `live/`, and all three hold `IJT World`.
- **The MCP is a separate process from the built bundle.** After changing
  `apps/respawn-mcp`, rebuild *and* `/mcp` to reconnect, or you are driving stale code.
