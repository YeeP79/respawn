# Respawn — where we are (2026-08-31)

Read `CLAUDE.md` first for the fleet-wide gotchas. This file is **current state and
next step**, and the active thread is still **L4D2**.

---

## State right now

**Branch `main`, 22 commits ahead of `origin/main` — NOT pushed.** Full check suite green.
Nothing is deployed; the fleet is still scaled to zero.

**The agent loop works with a real player** (S16). Four order types — `wait`, `goto`,
`follow`, `heal` — driven from F-keys through chat into L4B, live, repeatedly. The v3
premise is proven: `move up` sent bots to the player's crosshair 880 units from where he
was standing.

```
b982031 fix(l4d2): repair a hold the bot cannot reach — and four silent failures on the way
df66b23 fix(l4d2): refuse an ambiguous bot name, and stop counting the other team
c6077ff fix(l4d2): an order that lands behind another is QUEUED, not OK
a91eae8 feat(l4d2): split into vanilla + modded variants, and ship the modded build
0ed78c7 spike(S15): our platform pins load — 49 plugins, 13/13 extensions, no error log
```

---

## ▶ NEXT

**Local testing is the default for anything about the mods.** `apps/l4d2/scripts/run-local.sh
modded` runs the same image the deploy builds with the variant's own env, in seconds. Use it.

Deploying `l4d2-modded` to AWS is now unblocked — the `respawn/l4d2-modded/rcon` secret
exists — but it answers a *different* question (does it run on Fargate), and two things
still cannot be measured locally:

1. **Ephemeral storage.** 20 GiB default against a ~16 GB image.
2. **Whether the swapped C++ runtime survives real load.** S13 verified a clean boot and a
   running round, not a soak. `bin/*.valve` are in the image for the rollback.

**Arm the inbox watcher before any live session.** The agent cannot listen and measure at
the same time — both spend the same serial resource, and player presses were dropped all
through S16 until it was wired up:

```
Monitor: bash apps/l4d2/scripts/watch-inbox.sh <ip> 27015 <pw> 2   (persistent)
```

**Still open:** S6, the fifth-player ritual — the only unclosed spike, and it needs two
humans. And the duplicate-survivor problem: `CreateSurvivorBot()` clones an existing
survivor rather than filling the empty slot, and the duplicate **survives a chapter
transition** (measured — the next level started with two Rochelles).

---

## What changed this session

### 1. `respawn_director` v3 — VScript orders (S12)

The inferred link is measured. `L4D2_GetVScriptOutput` reaches
`Left4Bots.BotOrderAdd`, and a bot obeyed an order carrying **literal coordinates** with
**no human connected and no `admins.txt`** — it moved to the vector and held.

`sm_rd_order <target> <type> [at=x,y,z] [look=x,y,z] [ent=N] [hold=S] [pause=0|1]`,
plus `sm_rd_cancel` and `sm_rd_orders`. The FakeClientCommand path is **gone**, not kept
as a fallback: it is the one that fails silently without `admins.txt`.

### 2. Accelerator loads (S13)

Chased with `readelf`, not guessed. Two measured dead ends first — libstdc++ alone kills
the engine, and **Rocky 9's own i686 libgcc does not work on Rocky 9** (it wants
`_dl_find_object@GLIBC_2.35`; RHEL 9 is pinned at 2.34). The pair that works is Rocky's
libstdc++ 11.5.0 with Debian **bullseye**'s libgcc-s1 10.2.1, hash-pinned.

### 3. The slot machinery was never broken (S14)

S11's finding 2 is **withdrawn**. L4DToolZ v2.4.3 loads through
`addons/l4dtoolz.vdf` — the *engine's* plugin loader, the layer Metamod itself sits on —
so `meta list` correctly never shows it and `plugin_print` does. The cap moves 4 → 31
live. `sv_removehumanlimit` exists on no build this project has ever run.

### 4. The unpinnables are pinned

Three Workshop VPKs vendored to the private state bucket with sha256s in
`apps/l4d2/vendor/workshop.txt`; the S3 key **carries the hash**, so a re-snapshot never
overwrites the bytes an older commit fetches. All4Dead2 pinned to a commit — and its
locator was wrong as well as moving.

### 5. Our platform pins load (S15)

MetaMod 1410, SourceMod 7251, Left4DHooks 1.168: 49 plugins, 13/13 extensions, **no
SourceMod error log at all** where the pack's platform had one.

---

## Facts worth not re-deriving

**Distrust "success" in this codebase.** Every defect S16 found returned OK and none threw:
an order queued behind another, a name matching two bots, a count including the other team,
a hold that had stopped holding. A reply that cannot distinguish those from "done" is not a
report.

**Testing traps that produce a CONFIDENTLY WRONG answer, not an error:**

- **`sv_hibernate_when_empty` is invisible to `find` and to direct rcon, and settable via
  `sm_cvar`.** Until it is set, a headless server hibernates, `ModeStarted` stays false,
  `Bots` stays empty, and every order fails in a way that looks like a broken VScript link.
- **`L4D2_ExecVScriptCode` has an undocumented size ceiling and rejects SILENTLY.** A
  126-byte block defined while 350 and 425-byte blocks did not; the ~1006 figure in the
  include is not it (835 failed too). Put VScript in a `.nut` and `DoIncludeScript` it.
- **`scripts/vscripts/` is indexed at MAP LOAD.** A `.nut` dropped in mid-map is invisible
  to `DoIncludeScript` with the file plainly present on disk.
- **`TIMER_FLAG_NO_MAPCHANGE` kills a repeating timer at the first map change**, and
  `OnPluginStart` does not run again. A background sweep created that way runs until the
  first map load and then never again, silently.
- **`L4D2_GetVScriptOutput` cannot express the integer 0** — it returns as an empty string,
  indistinguishable from failure, and `BotOrderAdd` returns 0 on its most common SUCCESS
  path. `.tostring()` everything crossing that boundary.
- **`meta list` is not the list of loaded plugins.** Three loaders, three lists:
  `plugin_print` (engine), `meta list` (Metamod), `sm plugins list` (SourceMod).
- **`m_hMyWeapons` is not in HUD-slot order.** Reading index 3 as "the medkit slot" produced
  a false failure and nearly a filed bug against code that works.
- **Never test whether a command exists by running it.** Probing All4Dead2's twelve commands
  meant executing `a4d_panic_forever` and `a4d_continuous_bosses` on a live game.
- **All4Dead2's director commands need A CLIENT PRESENT** (any client, a bot counts) — they
  route through FakeClientCommand and throw `Client index 0 is invalid` on an empty server.
  Different from `a4d_spawn_item`/`_weapon`, which need a player **caller** and are
  permanently unreachable over rcon.
- **`docker build` failing leaves the previous image on the tag.** Two wrong conclusions in
  S13 came from inspecting a tag whose build had failed below the log tail. Check the exit
  status, not the last 20 lines.
- **Steam restores "unsubscribed" Workshop files by itself**, with the game closed.
  `steamcmd +login anonymous +workshop_download_item 550 <id>`; `<id>_legacy.bin` is the VPK.
- **`docker-proxy` breaks the Source connect handshake while passing A2S.** Address the
  container's bridge IP and its own port. `--network host` is not the fix.
- **A2S is not a joinability check.** It measures population.
- **`sv_allow_lobby_connect_only` defaults to 1** and refuses direct `connect`.
- **`sed` block-buffers into a pipe** — a log shipper needs `sed -u`.
- **There is no `ps` in the game image.** Use `/proc`.
- **Verify the observation channel before each reading.** `docker logs` went stale for
  minutes during S12; rcon, which carries console output, proved itself on every call.

**Running a local test server** (S12/S13/S15 recipe — note the hibernation line):

```bash
docker run -d --name t \
  -v "$PWD/apps/_shared/source-logship.sh:/logship.sh:ro" \
  --entrypoint /bin/sh l4d2-full:s15 -c \
  'cd /home/louis/l4d2 && exec /bin/sh /logship.sh /home/louis/l4d2/left4dead2 \
     ./srcds_run -game left4dead2 -console -norestart -ip 0.0.0.0 -port 27015 \
     +sv_lan 1 +rcon_password spikepw +maxplayers 4 +sv_allow_lobby_connect_only 0 \
     +map c1m1_hotel coop'
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' t)
python3 lab/srcds-rcon.py $IP 27015 spikepw "sm_cvar sv_hibernate_when_empty 0"
# lab/s12-vscript-orders/rd_probe.smx gives sm_probe_bot and sm_probe_vs
```

Images built locally, each adding exactly one variable — keep it that way, it is why
every failure this session was attributable in one step:

```
left4devops/l4d2  ->  l4d2-full:s11   the curated pack
                  ->  l4d2-acc:s13    + the C++ runtime swap
                  ->  l4d2-full:s15   + our platform pins
                      l4d2-modded:local   the actual variant build, from the Dockerfile
```

`lab/s11-full-stack/payload/` is gitignored; the variant Dockerfile fetches the same
tree pinned to `cc640c67`.

---

## Valheim — done, unchanged

The six-variant lattice, world-save round trip, mod manifests with `include`/`mods.lock`,
and the rcon config shim all landed in earlier sessions and are on `main`. Nothing this
session touched Valheim.
