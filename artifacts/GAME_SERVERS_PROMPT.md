# Game Server Setup — Agent Prompt

## Context

This prompt covers the actual game server configurations that Respawn (see `AGENT_PROMPT.md`) deploys. Each game server lives in `/apps/` as an Nx app with a `Dockerfile`, `.env`, and any supporting config.

Before beginning, read the upstream Docker repos for each game server to understand their configuration, volume mounts, ports, and environment variables. These repos are well-documented and should be the source of truth for how each server runs.

---

## Game Servers

### 1. Valheim — `valheim`

**Upstream Docker Repo:** https://github.com/lloesche/valheim-server-docker

Research this repo thoroughly. It is a mature, well-maintained Valheim server image with support for automatic updates, backups, and mod management (BepInEx).

**Key details to extract from the upstream repo:**
- Required environment variables (server name, world name, password, etc.)
- Volume mounts for persistent data (`/config` for worlds, characters, backups)
- Port requirements: UDP 2456-2457 (game + query), TCP 2456 (optional)
- Memory/CPU recommendations
- Backup and auto-update configuration options
- Any health check or status endpoints

**Dockerfile approach:**
- Evaluate whether to use the upstream image directly (`lloesche/valheim-server:latest` as `IMAGE_URI` in `.env`) or build a thin wrapper Dockerfile that extends it with custom configuration
- If the upstream image is sufficient as-is, set `IMAGE_URI` in the `.env` and skip the local build. The Respawn executor supports this — it pulls instead of building when `IMAGE_URI` is set.
- If customization is needed (custom mods, config files baked in, etc.), create a Dockerfile that `FROM`s the upstream image and layers on changes

**`.env` configuration:**
Create `/apps/valheim/.env` using the template from `/artifacts/templates/env.example.txt` with Valheim-specific values:
- `SERVICE_NAME=valheim`
- `SERVICE_DISPLAY_NAME="Valheim Server"`
- `CONTAINER_PORT=2456`
- `HOST_PORT=2456`
- `PROTOCOL=UDP`
- `CPU=1024` (1 vCPU — evaluate if upstream repo recommends more)
- `MEMORY=4096` (4 GB — Valheim is memory-hungry, especially with larger worlds)
- `GAME_ENV_SERVER_NAME` — passthrough to container
- `GAME_ENV_WORLD_NAME` — passthrough to container
- `GAME_ENV_SERVER_PASS` — this is a secret; provide it via `SECRET_REFS` (sm/ssm), not as a plaintext `GAME_ENV_` value (see Secrets)
- Additional `GAME_ENV_` vars as needed based on upstream documentation

**Networking considerations:**
- Valheim uses UDP 2456 for game traffic and UDP 2457 for query/status
- Both ports need to be exposed — update the networking construct if needed to support port ranges or multiple port mappings
- The `.env` may need a `ADDITIONAL_PORTS` field or similar if the current schema only supports a single port pair

**Persistent data:**
- Valheim worlds, characters, and backups need to survive container restarts and redeployments
- Research how to handle persistent volumes on Fargate (EFS is the typical approach)
- If EFS is needed, document what changes are required to the Respawn CDK constructs (this may feed back into `AGENT_PROMPT.md`)

**Idle shutdown considerations:**
- Valheim server may report active players via status query on UDP 2457
- Research whether the `http` idle check method can query this, or if `netstat` on port 2456 is sufficient
- The upstream image may have a status endpoint or log pattern that indicates player count

---

### 2. UT99 — `ut99`

**Upstream Docker Repo:** https://github.com/roemer/docker-ut99-server

Research this repo thoroughly. It provides a containerized Unreal Tournament 99 server.

**Key details to extract from the upstream repo:**
- Required environment variables (server name, admin password, game type, etc.)
- Volume mounts for persistent data (maps, mods, configs)
- Port requirements: UDP 7777-7779 (game ports), TCP 7780 (web admin, optional)
- Memory/CPU recommendations
- Map rotation and mutator configuration
- Web admin panel setup

**Dockerfile approach:**
- Same evaluation as Valheim — use upstream image directly or build a thin wrapper
- UT99 is lightweight; the upstream image likely works as-is
- Custom maps or mods may require a wrapper Dockerfile to `COPY` them in

**`.env` configuration:**
Create `/apps/ut99/.env` with UT99-specific values:
- `SERVICE_NAME=ut99`
- `SERVICE_DISPLAY_NAME="Unreal Tournament 99 Server"`
- `CONTAINER_PORT=7777`
- `HOST_PORT=7777`
- `PROTOCOL=UDP`
- `CPU=512` (0.5 vCPU — UT99 is very lightweight)
- `MEMORY=1024` (1 GB — should be more than enough)
- `GAME_ENV_SERVER_NAME` — passthrough to container
- `GAME_ENV_ADMIN_PASSWORD` — this is a secret; provide it via `SECRET_REFS` (sm/ssm), not as a plaintext `GAME_ENV_` value (see Secrets)
- Additional `GAME_ENV_` vars for game type, map rotation, mutators, etc.

**Networking considerations:**
- UT99 uses UDP 7777-7779 (game, port+1 for query, port+2 for upstream query)
- TCP 7780 for web admin (optional — may not want this exposed publicly)
- Same multi-port consideration as Valheim

**Persistent data:**
- Less critical than Valheim — UT99 doesn't have persistent world state
- Custom maps and mods should be baked into the image
- Server stats/logs are nice-to-have but not essential to persist

**Idle shutdown considerations:**
- UT99's query port (UDP 7778) responds to Unreal query protocol
- `netstat` on port 7777 is likely the simplest approach for idle detection
- Web admin (TCP 7780) may expose player count if enabled

---

### 3. Team Fortress Classic (TFC) — `tfc`

**Upstream Docker Repo:** https://github.com/JamesIves/hlds-docker

Research this repo thoroughly. It provides a Half-Life Dedicated Server (HLDS) Docker image that supports multiple GoldSrc games and mods, including Team Fortress Classic. The TFC-specific image tag is `jives/hlds:tfc`.

**Key details to extract from the upstream repo:**
- Required environment variables (server name, RCON password, max players, map, etc.)
- Volume mounts for custom configs and mods (`/temp/config`, `/temp/mods`)
- Port requirements: UDP 27015 (game), TCP 27015 (RCON), UDP 26900 (client)
- Memory/CPU recommendations (HLDS is very lightweight)
- Map rotation and mod configuration
- Any startup command arguments (`+map`, `+maxplayers`, etc.)

**Dockerfile approach:**
- The upstream image is designed to be used directly or extended
- Use `jives/hlds:tfc` as `IMAGE_URI` in `.env` if no customization is needed
- If custom maps, configs, or mods are required, create a thin Dockerfile:
  ```dockerfile
  FROM jives/hlds:tfc
  COPY maps/ /temp/mods/tfc/maps/
  COPY config/ /temp/config/
  ```

**`.env` configuration:**
Create `/apps/tfc/.env` using the template from `/artifacts/templates/env.example.txt` with TFC-specific values:
- `SERVICE_NAME=tfc`
- `SERVICE_DISPLAY_NAME="Team Fortress Classic Server"`
- `CONTAINER_PORT=27015`
- `HOST_PORT=27015`
- `PROTOCOL=UDP`
- `CPU=256` (0.25 vCPU — HLDS is extremely lightweight)
- `MEMORY=512` (512 MB — more than enough for TFC)
- `GAME_ENV_RCON_PASSWORD` — this is a secret; provide it via `SECRET_REFS` (sm/ssm), not as a plaintext `GAME_ENV_` value (see Secrets)
- `GAME_ENV_MAXPLAYERS` — passthrough
- `GAME_ENV_MAP` — starting map (e.g., `2fort`)
- Additional `GAME_ENV_` vars for server name, LAN mode, etc.

**Networking considerations:**
- TFC uses UDP 27015 for game traffic, TCP 27015 for RCON, UDP 26900 for client connections
- Multiple ports with mixed protocols (UDP + TCP) — same multi-port schema update needed

**Persistent data:**
- Minimal persistence needs — no world state like Valheim
- Custom maps and mods should be baked into the image
- Server logs and ban lists are nice-to-have but not critical

**Idle shutdown considerations:**
- HLDS query protocol on UDP 27015 can report active players
- `netstat` on port 27015 is the simplest idle detection approach
- RCON can also query player count if needed

---

### 4. Garry's Mod — `gmod`

**Upstream Docker Repo:** LinuxGSM — https://github.com/GameServerManagers/docker-gameserver (image `gameservermanagers/gameserver:gmod`)

The `gmod` tag is **verified published** on Docker Hub (no dedicated `gmodserver` repo exists). It runs LinuxGSM, which does the SteamCMD install (app ID **4020**), updates, and start.

**Verified image behavior (inspected `gameservermanagers/gameserver:gmod`):**
- **Config is FILE-driven, not env-var driven.** The only env vars are LinuxGSM infrastructure (`GAMESERVER=gmodserver`, `LGSM_SERVERFILES=/data/serverfiles`, `LGSM_CONFIG=/data/config-lgsm`, `VALIDATE_ON_START`, `UPDATE_CHECK`, `UID`/`GID`). There are **no** env vars for server name, gamemode, map, maxplayers, GSLT, or rcon.
- Game settings live in LinuxGSM's `config-lgsm/gmodserver/gmodserver.cfg` (start parameters: `gamemode`, `defaultmap`, `maxplayers`, `tickrate`, `gslt`, `wscollectionid`, `port`/`clientport`/`sourcetvport`). `hostname` and `rcon_password` are srcds cvars (server.cfg or start params), not LinuxGSM vars.
- Everything persists under **`/data`** (serverfiles, config-lgsm, logs). First run does a multi-GB SteamCMD install, so EFS is required.
- Idle detection: A2S query is UDP, so use `netstat` on 27015 (no usable HTTP/status endpoint).

**Dockerfile approach — a wrapper IS required (not `IMAGE_URI`):**
Because the image ignores env vars but Respawn supplies config + secrets *as* env vars, a thin wrapper bridges the two. `apps/gmod/Dockerfile` does `FROM gameservermanagers/gameserver:gmod` and adds `respawn-init.sh`, which writes `gmodserver.cfg` (game settings + GSLT) and a custom `server.cfg` (hostname + rcon_password, so the secret stays off the command line) from the env vars/secrets, then `exec`s the upstream entrypoint. The `server.cfg` is written by a background watcher once SteamCMD's install creates the cfg dir, so first install is never blocked. Leave `IMAGE_URI` unset so Respawn builds and pushes this image. Keep gamemode-specific addons on EFS so one image serves any gamemode.

**`.env` configuration:**
Create `/apps/gmod/.env` from `/artifacts/templates/env.example.txt` with:
- `SERVICE_NAME=gmod`
- `SERVICE_DISPLAY_NAME="Garry's Mod Server"`
- `CONTAINER_PORT=27015`
- `HOST_PORT=27015`
- `PROTOCOL=UDP`
- `ADDITIONAL_PORTS=27015/tcp,27005/udp` (add `27020/udp` if SourceTV is enabled)
- `CPU=2048`
- `MEMORY=4096` — sized for the heaviest selectable gamemode (DarkRP); sandbox/TTT simply use less
- `ENABLE_PERSISTENT_STORAGE=true`
- `PERSISTENT_MOUNT_PATH=/data` (confirmed — LinuxGSM keeps serverfiles + config + logs under `/data`)
- `ENABLE_IDLE_SHUTDOWN=true`
- `IDLE_CHECK_METHOD=netstat` — A2S is UDP, so the sidecar `http` mode does not apply
- `IDLE_TIMEOUT_MINUTES=30`
- `GAME_ENV_*` passthroughs read by `respawn-init.sh`: `GAMEMODE`→gamemode, `SERVERNAME`→hostname, `MAP`→defaultmap, `MAXPLAYERS`→maxplayers, `WORKSHOP_COLLECTION`→wscollectionid
- `SECRET_REFS=RCON_PASSWORD=sm:respawn/gmod/rcon,GSLT=ssm:/respawn/gmod/gslt` — `respawn-init.sh` writes `RCON_PASSWORD` into a custom `server.cfg` (`+servercfgfile`, kept off the command line) and maps `GSLT`→LinuxGSM `gslt`→`+sv_setsteamaccount` (leave GSLT unset for a private/unlisted server)
- `IMAGE_URI` **unset** — built from the wrapper Dockerfile (see Dockerfile approach above)

**Gamemode — deploy-time prompt:**
GMod's gamemode is chosen at deploy time, not baked into `.env`. Declare it as a per-service deploy prompt (see `AGENT_PROMPT.md` §2, "Per-service deploy prompts"):

```
DEPLOY_PROMPTS=GAMEMODE:select:ttt|prop_hunt|darkrp
```

The CLI prompts for the gamemode after service selection and injects the answer as `GAME_ENV_GAMEMODE` (→ `GAMEMODE` in the container). In non-interactive/CI mode, set `GAME_ENV_GAMEMODE` in `.env` instead. Gamemode-specific addons should live on EFS so switching does not require rebuilding the image.

**Networking considerations:**
- UDP 27015 (game + A2S query), TCP 27015 (RCON), UDP 27005 (client), optional UDP 27020 (SourceTV)
- Same multi-port handling as TF2/TFC — covered by `ADDITIONAL_PORTS`
- 27015 collides with TFC's port, but the two run as separate Fargate tasks with separate ENIs, so there is no conflict

**Persistent data (EFS):**
- Addons, maps, gamemodes, `garrysmod/data`, and server config should survive restarts/redeploys — use the EFS construct (same as Valheim/Rust)
- Keeping addons on EFS lets one image serve any gamemode (see deploy-time prompt above)

**Idle shutdown considerations:**
- A2S query on 27015 reports player count but is UDP, so use `netstat` on 27015 (consistent with TF2/TFC/Rust)
- As with the other UDP servers, verify after first deploy that established sockets register live players before trusting auto scale-to-zero

---

## Cross-Cutting Concerns

### Multi-Port Support

All three game servers require multiple ports. The current Respawn config schema (`cdk-config.ts`) only supports a single `containerPort` / `hostPort` pair. This needs to be extended:

**Option A — Port range:**
Add to `.env`:
```
CONTAINER_PORT_RANGE_START=2456
CONTAINER_PORT_RANGE_END=2457
```

**Option B — Additional ports list:**
Add to `.env`:
```
ADDITIONAL_PORTS=2457/udp,7780/tcp
```

**Option C — Full port mapping:**
Add to `.env`:
```
PORT_MAPPINGS=2456:2456/udp,2457:2457/udp
```

Evaluate which approach is cleanest and update both the Respawn config types and the Fargate construct to support it. Option B is likely the best balance — keeps the primary port simple and allows extras.

### Persistent Volumes (EFS)

Valheim requires persistent storage for world data. On Fargate, this means EFS (Elastic File System). If persistent volumes are needed:

1. Add to `.env`:
```
ENABLE_PERSISTENT_STORAGE=true
PERSISTENT_MOUNT_PATH=/config
```

2. Add an EFS construct to Respawn that:
   - Creates an EFS file system per service per environment
   - Creates an access point
   - Mounts it to the Fargate task at the configured path
   - Handles security group rules for EFS (TCP 2049)

3. Feed this back as an update to `AGENT_PROMPT.md` and the CDK constructs

### Secrets

Every server has secrets that must not sit in plaintext `.env` files:
- Valheim: server password
- UT99: admin password
- TFC: RCON password
- Garry's Mod: RCON password + Steam GSLT

Use the repo's standard secrets mechanism (see `AGENT_PROMPT.md` §7): reference them in `.env` via `SECRET_REFS` backed by AWS Secrets Manager (`sm:`) or SSM Parameter Store SecureString (`ssm:`), resolved at deploy time and injected as ECS secrets. Set/rotate the values with the `Secrets` CLI action — never commit them. Do **not** use `nw-secrets-manager`; it is not present in this repo.

---

## Getting Started Sequence

1. Read this prompt and `AGENT_PROMPT.md` to understand the full system
2. Research the upstream Docker repos:
   - Clone or fetch https://github.com/lloesche/valheim-server-docker — read the README, Dockerfile, and docker-compose examples
   - Clone or fetch https://github.com/roemer/docker-ut99-server — read the README, Dockerfile, and configuration docs
   - Clone or fetch https://github.com/JamesIves/hlds-docker — read the README, Dockerfile, and TFC-specific configuration
   - Clone or fetch https://github.com/GameServerManagers/docker-gameserver — read the README and confirm the `gmod` image tag (app ID 4020); note its addon/gamemode and GSLT config
3. Determine Dockerfile strategy for each (use upstream directly vs. wrapper)
4. Create `.env` files for `valheim`, `ut99`, `tfc`, and `gmod` with game-specific values
5. Identify any gaps in Respawn's config schema (multi-port, EFS) and update accordingly
6. If schema changes are needed, update `/artifacts/templates/cdk-config.ts` and `/artifacts/templates/cdk-defaults.ts` first, then the Respawn constructs
