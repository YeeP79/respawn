# Respawn — where we are (2026-08-30, later)

Read `CLAUDE.md` first for the fleet-wide gotchas. This file is **current state and
next step**, and the active thread is still **L4D2**.

---

## State right now

**Branch `main`, 15 commits ahead of `origin/main` — NOT pushed.** The full check suite
is green (`npx nx run-many -t typecheck test lint build`). Nothing is deployed; every
server in the fleet is still scaled to zero.

```
a91eae8 feat(l4d2): split into vanilla + modded variants, and ship the modded build
0ed78c7 spike(S15): our platform pins load — 49 plugins, 13/13 extensions, no error log
fb269e5 feat(l4d2): pin the unpinnables — vendor the Workshop VPKs, pin all4dead2
2bb68d4 spike(S14): the slot machinery was never half-loaded — meta list is the wrong list
01db176 fix(l4d2): make Accelerator load — the C++ runtime swap, measured (S13)
1aef1d5 feat(l4d2): respawn_director v3 — order bots through VScript, not impersonation
```

**All five open items from the previous handoff are closed.** Twelve of thirteen spikes
are closed; only **S6** (the fifth-player ritual) remains, and it needs two humans.

---

## ▶ NEXT: deploy `l4d2-modded` and test live

Everything is built and measured locally. The remaining work is a deploy, and it is
**blocked on one thing**:

```
respawn/l4d2-modded/rcon   does not exist
```

`SECRET_REFS` names it and ECS resolves secrets *before* starting the container, so the
task would fail with `ResourceInitializationError`. `deploy()` preflights this and will
refuse, which is the intended behaviour, not a bug. Create it first:

```bash
pnpm respawn            # -> Secrets -> l4d2-modded -> RCON_PASSWORD
# or headless (never on argv):
echo -n "$VALUE" | pnpm respawn -- --non-interactive --action secrets \
    --service l4d2-modded --secret RCON_PASSWORD
```

Then:

```bash
pnpm respawn            # -> Deploy -> l4d2-modded
```

The image is ~16 GB and builds from scratch on the first deploy (SteamCMD content is in
the base image; the build itself is the runtime swap, the pack, our platform and two
compiles). Expect a long first push.

**When it is up**, the loop to exercise is: join → type `@bots wait there` in chat →
`sm_rd_inbox` → pick an order → `sm_rd_order`. The client macros are in
`apps/l4d2/client/respawn.cfg`; install at `left4dead2/cfg/respawn.cfg`.

### Two things to check on the live task, because neither was measurable locally

1. **Ephemeral storage.** A Fargate task gets 20 GiB by default and this image is ~16 GB.
   The vanilla service has always used a base image of the same order, so this is
   probably fine — but it has never been deployed either, and "probably fine" is how the
   fleet loses an afternoon.
2. **Whether the swapped C++ runtime survives real load.** S13's swap was verified as a
   clean boot, a full stack and a running round — **not** a soak test. An ABI problem
   surfaces as a crash, and the component the swap exists to install is the crash
   reporter. If a task dies unexplained, `bin/libstdc++.so.6.valve` and
   `bin/libgcc_s.so.1.valve` are in the image and the rollback is one `mv`.

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

**Testing traps that produce a CONFIDENTLY WRONG answer, not an error:**

- **`sv_hibernate_when_empty` is invisible to `find` and to direct rcon, and settable via
  `sm_cvar`.** Until it is set, a headless server hibernates, `Left4Bots.ModeStarted`
  stays false, `Bots` stays empty, and every order fails in a way that looks exactly like
  a broken VScript link. This is the single most useful line for local testing.
- **`L4D2_GetVScriptOutput` cannot express the integer 0** — it comes back as an empty
  string, indistinguishable from failure, and `BotOrderAdd` returns 0 on its most common
  SUCCESS path. `.tostring()` everything crossing that boundary.
- **`meta list` is not the list of loaded plugins.** Three loaders, three lists:
  `plugin_print` (engine), `meta list` (Metamod), `sm plugins list` (SourceMod). Reading
  one and concluding about another cost S11 a wrong "do not build on this".
- **All4Dead2's director commands need A CLIENT PRESENT** (any client, a bot counts) —
  they route through FakeClientCommand and throw `Client index 0 is invalid` on an empty
  server. Different from `a4d_spawn_item`/`_weapon`, which need a player **caller** and
  are permanently unreachable over rcon.
- **`docker build` failing leaves the previous image on the tag.** Two wrong conclusions
  this session came from inspecting a tag whose build had failed further down than the
  log tail showed. Check the exit status, not the last 20 lines.
- **Steam restores "unsubscribed" Workshop files by itself**, with the game closed.
  `steamcmd +login anonymous +workshop_download_item 550 <id>`; `<id>_legacy.bin` **is**
  the VPK.
- **`docker-proxy` breaks the Source connect handshake while passing A2S.** Address the
  container's bridge IP and its own port. `--network host` is not the fix.
- **A2S is not a joinability check.** It measures population.
- **`sv_allow_lobby_connect_only` defaults to 1** and refuses direct `connect`.
- **`sed` block-buffers into a pipe** — a log shipper needs `sed -u`.
- **There is no `ps` in the game image.** Use `/proc`.
- **Verify the observation channel before each reading.** `docker logs` went stale for
  minutes at a time during S12; rcon, which carries console output, proved itself on
  every call.

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
