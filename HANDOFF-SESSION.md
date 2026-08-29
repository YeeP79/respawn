# Respawn — where we are (2026-08-28)

Read `CLAUDE.md` first for the gotchas. This file is just **current state and next
step**.

---

## State right now

**Branch `feat/goldsrc-mod-variants`, 21 commits ahead of `main`, nothing pushed.**
Working tree clean apart from this file and the untracked `valheim-files.zip` you
parked in the repo root — leave both out of commits.

**Every server is scaled to zero. Nothing is billing.**

```
respawn-dev-tfc  ut99  cs16-dm  cs16  cs16-kz  doom2   → all desired=0
```

SSO expires often: `aws sso login --profile respawn`.

---

## Two things finished this session

### 1. cs16-kz is deployed and actually works

It was built but never deployed. Getting it live surfaced four real defects, all
fixed and verified on the running server:

| Defect | Was |
|---|---|
| MySQL health check `retries: 12` | ECS caps at 10 → the whole deploy rolled back |
| `MARIADB_ROOT_HOST: localhost` | No TCP-capable root account existed; every client got "Access denied" |
| Game server never waited for the database | The KZ timer's SQL plugins died at boot, silently — server looked healthy |
| `sv_airaccelerate` stuck at 10 | `uq_jumpstats` owns the cvar; setting the engine one is overwritten within a second |

Verified live: 67 plugins loaded with none failed, 19 tables in `kreedz`, and the
S3 backup round-trip proven end to end — one task dumped, the next restored it.

**Also fixed a security hole across all five GoldSrc services.** HLDS was writing
the rcon password into CloudWatch on every command. `apps/_shared/hlds-log-redact.sh`
now filters it; proven with a real rcon call against a real build.

### 2. L4D2 research, then six spikes

Full research is in the dossier artifact (`/artifacts` in the terminal, or the
gallery). The short version of the plan:

> **One shared base of server-side mods. A change only becomes its own server when
> a player has to do something differently to join.**

Then `docs/spikes/` — one file per open question, blueline's format. **Six of eight
are answered.**

---

## The spike board

| | Question | Answer |
|---|---|---|
| S1 | Does the mod stack build and load? | ✅ Yes — MetaMod + SourceMod + Left4DHooks 1.168 + All4Dead2 + Stripper, zero errors, +221 MB |
| S2 | Can the MCP drive it? | ✅ Yes — no `admins.cfg` needed, rcon runs as `Console<0>`. **12 commands, not 13** |
| S3 | Does srcds leak the rcon password? | ⚠️ Not to logs. **But the entrypoint puts it in argv** — fix is one line in the shim |
| S5 | Is the slot plugin safe when off? | ✅ Yes — identical to base at 4 players, and resizes a live server with no restart |
| S7 | Image size / storage | ✅ **10.4 GB, not 15.6.** Storage is *not* a blocker — I was wrong about this |
| S8 | Do ECR variants cost real money? | ✅ Duplication is real but the whole registry is ~19¢/month. Cost is not a factor |
| **S4** | **Do players need the campaign installed?** | **⬜ NEEDS YOU** |
| **S6** | **What must the 5th player do?** | **⬜ NEEDS YOU** |

---

## ▶ NEXT: S4 and S6 — both need you in the game

Everything answerable without a game client is done. These two are the last, and
they are the only reason the plan still has an open shape.

### S4 — the important one

**Question:** can someone join a server running a custom campaign they have *not*
subscribed to?

**Why it matters:** it decides whether custom campaigns are a setting on the main
server, or a whole separate server. Sources genuinely contradict each other — one
walkthrough never mentions the client at all, others describe a conflict that only
makes sense if the client has its own copy. Not resolvable by reading more.

**Roughly:** I add one custom campaign to a local server, you connect from a client
with nothing subscribed, and we see whether you spawn in or get an error.

### S6 — the smaller one

**Question:** past 4 players, what does the 5th person actually have to do?

S5 already proved the server side works from one cvar, so this is purely about the
client experience. Needs two players. It may also dissolve itself — Left4DHooks
ships `sm_l4dd_unreserve`, and if lobby reservation is the real obstacle, the extra
step may vanish and big-coop stops needing its own server.

---

## Ready when you are

The spike images are built locally, so S4 can start immediately:

```
l4d2-base-spike:s1     the base stack
l4d2-slots-spike:s5    base + L4DToolz
```

Reproducible recipes live in `lab/s1-modded-image/` and `lab/s5-slot-machinery/`.
`lab/srcds-rcon.py` is the Source rcon client the spikes use.

---

## Open decisions for you (none blocking)

1. **Enable ECR `BLOB_MOUNTING`?** Account-wide switch, stops layer duplication.
   Saves ~13¢/month and speeds up image pushes. I didn't touch it — your call.
2. **Push this branch?** 21 commits sitting local.
3. **`HANDOFF.md` is stale** — it's from 2026-07-10 and still describes branch
   `feat/ut99-uweb-variants`. Worth updating or retiring; I left it alone rather
   than guess which.
4. **Build `l4d2-modded` now, or wait for S4/S6?** We know enough to start the base
   service; S4 only changes whether campaigns are a separate server later.

---

## Facts worth not re-deriving

- **The `oldlinux` L4DToolz build is mandatory.** The plain `linux` one fails on
  glibc and leaves a server that boots perfectly with no slot support.
- **Two files must be deleted from any L4D2 image**: `metamod_x64.vdf` (wrong
  architecture, logs a scary error) and `nextmap.smx` (refuses this game).
- **Don't size infrastructure from `docker images`** — it reported 50% high here.
- **All4Dead2's commands split in two.** Seven only move a cvar and work always;
  five (`force_panic` + the four spawns) need at least one client present, bots
  count. A scale-to-zero server is empty most of the time, so that matters.
- **The l4d2 base image runs `steamcmd` on every boot** — a network-dependent game
  update before the server exists. Untested on Fargate, not solved.
- **Versus is natively 8 players.** Only coop is capped at 4.
