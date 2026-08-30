# Respawn — where we are (2026-08-29)

Read `CLAUDE.md` first for the gotchas. This file is **current state and next step**.

---

## State right now

**Branch `feat/valheim-mod-variants`, off `main` `af8fa34`.** Four commits: the variant
lattice, the world-sync guards, the MCP command gating, and this doc. `main` itself is
unchanged and pushed.

**Every server is scaled to zero. Nothing is billing** beyond S3/EFS storage.

Stacks that exist: `respawn-dev-valheim-loot` and `respawn-dev-valheim-overhaul` (both at
desiredCount 0). `valheim` (vanilla), `valheim-admin`, `valheim-qol` and `valheim-build`
have **never been deployed**. `respawn-dev-valheim-modded` was **destroyed** this session.

---

## What Valheim now is

Six variants, deliberately separate services. A variant is a **ruleset** (which mods load,
what can drive the server) and NOT a world — which world runs on one is a deploy-time
choice, and a save can sit in several libraries at once.

| Variant | Mods | Client install | Worlds stamped | Deployed? |
|---|---|---|---|---|
| `valheim` | none, crossplay **on** (Xbox can join) | none | `vanilla` | never |
| `valheim-admin` | rcon only | none | `vanilla` | **not yet** |
| `valheim-qol` | + convenience (5 pkgs) | small | `vanilla` | not yet |
| `valheim-loot` | + EpicLoot, CLLC, Drop/Spawn That | ~40 MB | **`modded`** | not yet |
| `valheim-build` | + OdinArchitect, OdinsKingdom, PlantEverything | ~50 MB | **`modded`** | not yet |
| `valheim-overhaul` | union of both + Therzie suite | ~500 MB | **`modded`** | not yet |

Every modded variant: BepInEx, plugins from S3, crossplay **off** (required for mods —
PC/Steam only), local image build (one shared rcon config shim).

They are a lattice: `qol → loot → overhaul` and `qol → build → overhaul`. `loot` and
`build` are siblings a world cannot move between. `variants/overhaul/mods.txt` *includes*
both rather than restating them, so the shape cannot drift.

`valheim-modded` **was renamed to `valheim-admin`** — its only mod was the admin console,
so the old name described how it was built rather than what it is for. The repo no longer
describes the old service; the deployed stack still exists (see the migration below).

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

## ▶ NEXT: deploy the remaining three variants

**The migration is DONE. `valheim-loot` and `valheim-overhaul` are both proven end to end
in AWS** (2026-08-30), then scaled back to 0. Nothing is billing beyond storage.

What was verified, not assumed:

- `respawn-dev-valheim-modded` **destroyed**. Its volume held only the 325 KB fabricated
  world CLAUDE.md documents; both real saves were confirmed intact locally at 29.8 MB /
  211.5 days and 5.7 MB / 19.2 days before anything was deleted.
- All 5 variants **synth clean**. Verified in the templates: rcon 2458/**tcp** has no
  public ingress anywhere (only 2456-2458/udp), five **disjoint** S3 prefixes, and each
  task role's object access scoped to its own prefix so no variant can reach another's.
- **10 secrets created** (join password copied from the old service so players need no new
  one; rcon generated fresh per service). **5 plugin sets published**, S3 counts matched
  against local: 1 / 6 / 14 / 10 / 21 DLLs plus `.world-safe`.
- `valheim-loot` **booted**: 14 plugins synced, BepInEx chainloader complete, the rcon
  shim wrote the password (no "Password is empty"), `Start listening rcon commands`.
- `valheim-overhaul` **booted** after the OOM fix below: all 21 plugins synced, all four
  Therzie mods loaded (ConfigSync RPCs registered, recipes rewritten).
- Both scaled to 0 with **nothing junk in S3**: the disposable `smoketest` world never got
  a `.db` (no player ever connected) and the sidecar's guard declined to mirror a
  half-world. A ~55-byte `smoketest.fwl` stub sits on each of those two volumes.

### Still to do

1. **Deploy `valheim-admin`, `valheim-qol`, `valheim-build`.** Same image and mechanism as
   the two that are proven, different plugin sets. **`valheim-admin` matters most: it
   replaced `valheim-modded`, so right now there is NO administrable Valheim server at
   all.** Each needs a world published into its library first — a headless deploy refuses
   otherwise, because `DEPLOY_PROMPTS` only runs interactively.
2. **Decide which world goes where.** A variant is a ruleset, not a world, so this is a
   separate decision — and the one-way rule makes it consequential: publishing `IJT World`
   into `loot`, `build` or `overhaul` stamps it `modded` for ever. `admin` and `qol` are
   world-safe and keep it portable.
3. **Redeploy `valheim-loot`** to pick up the world-sync OOM fix. It still runs the old
   sidecar image. Nothing is broken today — its 45 MB payload syncs fine — but the fix is
   what makes an arbitrary future mod set safe. `fromAsset` rebuilds the sidecar on any
   deploy, so a plain redeploy is enough.
4. **`/mcp` reconnect.** The MCP was reconnected once, and two bugs were fixed AFTER that
   (the bogus "servers that do carry it" list, and the summary count disagreeing with the
   body), so the running process is stale again.

---

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
- **The MCP is a separate process from the built bundle.** After changing
  `apps/respawn-mcp`, rebuild *and* `/mcp` to reconnect, or you are driving stale code.
