# Rust Server

[Rust](https://rust.facepunch.com/) — Facepunch's survival game — deployed on AWS Fargate via the
[didstopia/rust-server](https://github.com/Didstopia/rust-server) image. SteamCMD downloads the
game on first boot; no game purchase or token is required to run the server (players still need to
own Rust to connect).

| | |
|---|---|
| **Image** | `didstopia/rust-server:latest` |
| **CPU / Memory** | 4096 / 16384 MB (default — see [Muscle & scaling](#muscle--scaling)) |
| **Game port** | UDP 28015 |
| **Extra ports** | TCP 28016 (RCON), UDP 28017 (Steam query), TCP 28082 (Rust+ companion app) |
| **Persistent storage** | EFS, mounted at `/steamcmd/rust` |

All configuration lives in [`.env`](./.env). Copy [`.env.example`](./.env.example) and edit before
deploying. Change the RCON password (`GAME_ENV_RUST_RCON_PASSWORD`) before going public.

## Deploy

The service is auto-discovered and included in the root convenience scripts:

```bash
pnpm respawn:synth     # synth CloudFormation (good first check)
pnpm respawn:deploy    # deploy
pnpm respawn:status    # check status
```

To act on Rust alone, target the service directly:

```bash
nx run respawn:cdk --action=deploy --profile=respawn --environment=dev --service=rust
```

First boot downloads ~8 GB via SteamCMD and generates the map — expect several minutes before the
server is joinable. Subsequent starts are fast because everything is on EFS.

## Muscle & scaling

Rust is the heaviest server in the fleet; RAM is the bottleneck and scales with map size and
population:

| Map size / players | Suggested `MEMORY` |
|---|---|
| ~3500 / 50 | 16384 (16 GB) — default |
| ~4500 / 100+ | 30720 (30 GB) — the Fargate ceiling at 4 vCPU |

**Task size is fixed per deploy.** Fargate cannot live-resize a running task — that's an AWS
platform constraint. To give the server more muscle, edit `CPU`/`MEMORY` in `.env` and redeploy.
The container restarts, but **the world is safe on EFS** (see below), so this is a few minutes of
downtime, not data loss.

The repo caps task size at **4 vCPU / 30 GB** (`apps/respawn/src/config/loader.ts`,
`CPU_MEMORY_RANGES`). Going higher would require extending those allowed values; 30 GB is ample for
Rust, so this is rarely needed.

**Horizontal scaling does not apply.** A Rust world is a single stateful process and cannot be
sharded across tasks, so `desiredCount` stays `1` with autoscaling off. The only horizontal motion
is the idle-shutdown sidecar scaling the service `0 ↔ 1` as an on/off switch.

## World data & persistence

World data lives on **EFS**, not inside the container — that's what lets a game continue across
restarts, idle-shutdowns, resizes, and redeploys.

- The Rust image writes everything (the game install **and** saves) under `/steamcmd/rust`.
- Save files for a given world live in `/steamcmd/rust/server/<RUST_SERVER_IDENTITY>/` — with the
  default config, `.../server/respawn/`. This holds the map (`.map`), the world save (`.sav`), and
  player data/blueprints.
- `PERSISTENT_MOUNT_PATH=/steamcmd/rust` mounts an encrypted, per-service EFS file system at that
  path (`apps/respawn/src/constructs/efs-storage.ts`). EFS is durable and independent of the
  container lifecycle, so when the container stops the volume survives and re-mounts on next start.

A game **continues the same world** as long as the EFS file system, `RUST_SERVER_IDENTITY`,
`RUST_SERVER_SEED`, and `RUST_SERVER_WORLDSIZE` are unchanged. Changing the identity, seed, or
world size starts a new world (see [Wipes](#wipes-manual)).

### ⚠️ EFS removal policy depends on environment

The EFS file system's removal policy is environment-dependent
(`apps/respawn/src/constructs/efs-storage.ts`):

| Environment | Removal policy | Effect |
|---|---|---|
| `dev` | **DESTROY** | Running `pnpm respawn:destroy` (or otherwise tearing down the stack) **permanently deletes the EFS file system and the world.** |
| `prod` | **RETAIN** | The file system is kept even if the stack is removed. |

Idle-shutdown and ordinary redeploys are **safe in every environment** — only a stack `destroy` in
`dev` deletes data. For a long-running game you care about, deploy in `prod` (which also disables
Fargate Spot, avoiding mid-game interruptions) or simply avoid `destroy`.

## Idle shutdown

The service scales to 0 after `IDLE_TIMEOUT_MINUTES` (default 30) of no players, to save cost. The
watchdog detects activity via `netstat` on the game port.

- **Wake-up is manual** — nothing auto-restarts the service. Bring it back with
  `nx run respawn:cdk --action=deploy ... --service=rust` or by setting the ECS service desired
  count back to 1.
- **Verify UDP detection after first deploy.** netstat counts established sockets, and Rust is
  UDP-based. If the server scales down while players are connected, raise `IDLE_TIMEOUT_MINUTES` or
  set `ENABLE_IDLE_SHUTDOWN=false`.

## Wipes (manual)

Rust only force-wipes when you pull Facepunch's monthly map update (first Thursday) — it is **not**
automatic. The defaults in `.env` keep wipes under your control:

- `GAME_ENV_RUST_UPDATE_CHECKING=0` — no background auto-updater.
- `GAME_ENV_RUST_START_MODE=0` — update only on container start; normal restarts/idle wake-ups just
  validate files and do **not** wipe.

`RUST_START_MODE`: `0` = update + start, `1` = update only, `2` = start only (no update).

**Lock an extended game across a forced-wipe week:** set `GAME_ENV_RUST_START_MODE=2` and redeploy
before the first Thursday of the month. The build is frozen, so no update — and therefore no forced
wipe — and the world persists indefinitely across restarts. Switch back to `0` and redeploy when you
choose to update and wipe on your own schedule.

**Perform a manual wipe on demand**, either:

1. Bump `GAME_ENV_RUST_SERVER_SEED` (and/or `GAME_ENV_RUST_SERVER_WORLDSIZE`) and redeploy → fresh
   map, or
2. Clear the save directory on EFS under `/steamcmd/rust/server/<identity>/` and redeploy.

## Admin (RCON)

Web RCON is enabled (`GAME_ENV_RUST_RCON_WEB=1`) on TCP 28016. Use the password from
`GAME_ENV_RUST_RCON_PASSWORD` with any Rust RCON client (e.g.
[rustadmin](https://www.rustadmin.com/) or the web console) to run admin commands, kick/ban
players, and trigger in-game actions.
