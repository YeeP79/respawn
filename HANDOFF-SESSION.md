# Respawn — where we are (2026-08-30, late)

Read `CLAUDE.md` first for the fleet-wide gotchas. This file is **current state and
next step**, and right now the active thread is **L4D2**.

---

## State right now

**Branch `main`, 9 commits ahead of `origin/main` — NOT pushed.** All of today's L4D2
work is committed locally and the full check suite is green (`typecheck test lint
build`). Nothing is deployed; every server in the fleet is still scaled to zero.

```
2a39113 docs: agent ambitions, MCP tooling gaps, and the spike ledger
07be887 feat(l4d2): respawn_director — the agent's bridge into Left 4 Bots
becbae8 feat(_shared): ship Source server logs to stdout
e986d7a feat(l4d2): mod manifests — 43 entries across seven tiers
6c3012d fix(l4d2): remove two non-functional cvars, correct S2
2c0544f spike(S11): full stack loads; Accelerator broken; A4D2 fork rejected
a4120c0 spike(S10): VScript addons run server-side; silent permission gate
fbab3f1 spike(S4, S9): clients need the campaign; server cannot push it
```

---

## What L4D2 now is

**Ten of eleven spikes closed.** Only **S6** (the fifth-player ritual) remains, and it
needs two humans on a server at once.

**The service is still `apps/l4d2` — stock upstream image, no mods, no rcon
transport.** `ENABLE_RCON_CONTROL` is unset and there is no `variants/` dir. Everything
below was proven on **local `docker run`**, not on anything deployed.

### The design, settled by measurement

- **Custom campaigns are a branch, not a knob** (S4, S9). A client without the campaign
  connects, is admitted as player 1, then dies on `Host_Error: CMapLoadHelper::Init`.
  The server cannot push it — zero HTTP requests to a live FastDL host, and no
  `host_workshop_*` / `ugc` / `sv_allowdownload` on this build. **There is no FastDL
  bucket in the design**; it would be infrastructure nothing reads.
- **VScript addons run server-side** (S10), so Left 4 Bots is base-eligible. What
  blocked it for hours was `Left4Lib` auto-promoting to Admin **only** when
  `Director.IsSinglePlayerGame()` — on a dedicated server everyone is level 0 and
  every order is dropped **silently**.
- **The full stack loads** (S11): 49/50 plugins, 12/13 extensions.
- **Bots are a base tier.** These servers are empty most of their life, so the normal
  session is one or two humans plus three bots.

### What was built

| Path | What it is |
|---|---|
| `apps/l4d2/mods/` | 43 mods, 7 tiers, Valheim-shaped (`include`, tracked manifests) |
| `apps/l4d2/plugins/respawn_director.sp` | the agent's bridge — inbox, orders, scene, give |
| `apps/l4d2/scripts/build-plugins.sh` | compile against the **server's own** spcomp64 |
| `apps/l4d2/scripts/watch-inbox.sh` | push trigger for the Monitor tool (no polling) |
| `apps/l4d2/client/respawn.cfg` | F-key macros; installed at `left4dead2/cfg/respawn.cfg` |
| `apps/_shared/source-logship.sh` | ships SourceMod + game logs to stdout |
| `docs/l4d2-agent-ambitions.md` | six ideas, each tagged measured / source / inferred |
| `docs/mcp-tooling-gaps.md` | six gaps, each tied to an incident |

**Proven end to end, live:** player presses a key → plugin captures intent with position
and aim frozen at that instant → agent notified without polling → agent picks an order
from L4B's vocabulary → bots obey.

---

## ▶ NEXT: five open items, then deploy and test

The user asked for all five, then a live test. In dependency order:

### 1. `respawn_director` v3 — VScript order injection

**Biggest win, unblocks the rest.** Today's bridge impersonates a player with
`FakeClientCommand`, which means (a) L4B checks *that player's* level, so
`ems/left4lib/cfg/admins.txt` must be provisioned per server, and (b) position orders
inherit the impersonated player's **live crosshair**, so `wait there` lands wherever
they happen to be looking seconds later.

Both go away by calling L4B's order API directly. Everything needed is **verified
present**:

```c
native bool L4D2_ExecVScriptCode(char[] code);   // left4dhooks.inc, now in the S1 image
```
```squirrel
Left4Bots.BotOrderAdd(bot, orderType, from, destEnt, destPos, destLookAtPos, ...)
```

`destPos`/`destLookAtPos` take literal vectors. The permission check lives in
`HandleCommand`, **not** in `BotOrderAdd` — so this path needs no admin file at all.

A probe plugin using `L4D2_ExecVScriptCode` + `GetClientEyePosition` **compiles clean**
already. The one inferred link is whether the VScript call reaches `BotOrderAdd`
successfully; test that first before building on it.

### 2. Accelerator — fix or drop

Fails on `left4devops/l4d2` with `GLIBCXX_3.4.21 not found`. Currently commented out in
`mods-stability.txt`. A crash reporter that silently fails to load is a **false
assurance** about the one thing nobody is watching — so either find a build matching
this base image's libstdc++, or remove it and say why.

### 3. Slot machinery — half-loaded, unexplained

`sv_maxplayers` present (max 31), `sv_removehumanlimit` **absent**, and `L4DToolZ` does
not appear in `meta list`. Something provides half the surface. **S5's `oldlinux`
finding is the first suspect** — S5 measured L4DToolZ inert at four players, it did not
measure whether this particular build loads at all. Nobody should build a big-coop
variant on this state.

### 4. Pin the unpinnables

Four entries cannot be version-pinned, and **three are what everything was built on**:

```
ws:3022416274  latest   Left 4 Bots 2      Workshop has NO version concept
ws:2634208272  latest   Left 4 Lib
ws:3226661388  latest   NavFixes
sp:AtomicStryker/all4dead2  master         a moving branch
```

Image tags are content hashes over COPYed files, so an upstream change silently moves
the tag — or worse, doesn't while the content does. Fix: **vendor the VPKs to the state
bucket** with recorded hashes, and pin all4dead2 to a SHA the way Left4DHooks already is.

### 5. Build with OUR pins, not the pack's

S11 proved **the curated pack's** versions co-exist. Ours are newer everywhere they
overlap (Left4DHooks 1.168 vs 1.161, SourceMod git7251 vs git7221, MetaMod git1410 vs
git1380) and have never been loaded together.

### Then: deploy and test

Create `apps/l4d2/variants/modded/`, deploy, join, exercise the agent loop against a
real Fargate task rather than a local container.

---

## Facts worth not re-deriving

**The command surface (S2, corrected).** All4Dead2 registers 12 usable commands.
`a4d_spawn_item` and `a4d_spawn_weapon` can **never** be driven by rcon — they route
through `give`, which hard-refuses a console caller. They need a player *caller*, not a
player present, so no amount of population fixes it. `respawn_director`'s `sm_rd_give`
exists because of this.

**Keep AtomicStryker's All4Dead2.** The better-maintained fork (fbef0102, 303 stars)
registers **7 commands to our 12**, dropping `force_tank`, `force_witch`, `add_zombies`,
`continuous_bosses` and `reset_to_defaults` — the safety valve. Diffed and confirmed
live in S11. Popularity is not a command surface.

**`spawn_*` is instant and local; `force_*` is director-placed and slow.** Different UX;
a manifest presenting both as "spawn a witch" will feel arbitrary.

**Testing traps that produce a CONFIDENTLY WRONG answer, not an error:**

- **Steam restores "unsubscribed" Workshop files by itself**, with the game closed.
  Moving a VPK aside is not a valid way to make a client lack content. Use
  `steamcmd +login anonymous +workshop_download_item 550 <id>` — no account needed, and
  `<id>_legacy.bin` **is** the VPK.
- **`docker-proxy` breaks the Source connect handshake while passing A2S.** Publish a
  port and every health check succeeds while no client can connect. Address the
  container's **bridge IP and its own port** (`172.17.0.2:27015`). `--network host` is
  not the fix — the container's Steam collides with the host's and breaks A2S too.
- **A2S is not a joinability check.** It measures population. It stayed green through an
  hour of an unjoinable server.
- **`sv_allow_lobby_connect_only` defaults to 1** and refuses direct `connect` outright.
- **`sed` block-buffers into a pipe.** A log shipper without `sed -u` reads correctly and
  delivers nothing until ~4KB accumulates.
- **There is no `ps` in the game image.** Use `/proc`. A `ps`-based check returns 0 and
  looks like a real measurement.
- **Verify the observation channel before each reading, not after.** Four consecutive
  "nothing happened" readings during S10 were taken against a log that had already died.

**Running a local test server** (the S4/S10/S11 recipe):

```bash
docker run -d --name s11srv \
  -v "$PWD/apps/_shared/source-logship.sh:/logship.sh:ro" \
  --entrypoint /bin/sh l4d2-full:s11 -c \
  'cd /home/louis/l4d2 && exec /bin/sh /logship.sh /home/louis/l4d2/left4dead2 \
     ./srcds_run -game left4dead2 -console -norestart -ip 0.0.0.0 -port 27015 \
     +sv_lan 1 +rcon_password spikepw +maxplayers 4 +sv_allow_lobby_connect_only 0 \
     +map c1m1_hotel coop'
# then:  python3 lab/srcds-rcon.py 172.17.0.2 27015 spikepw "status"
# client: connect 172.17.0.2:27015     (NOT a published port)
```

Images `l4d2-full:s11`, `l4d2-base-spike:s1`, `l4d2-slots-spike:s5` are built locally.
`lab/s11-full-stack/payload/` is gitignored and rebuilt with
`git clone --depth 1 https://github.com/SNWCreations/l4d2-modded-server`.

---

## Valheim — done, unchanged

The six-variant lattice, world-save round trip, mod manifests with `include`/`mods.lock`,
and the rcon config shim all landed in earlier sessions and are on `main`. Nothing this
session touched Valheim.
