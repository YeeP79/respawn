# Respawn

Deploy and manage retro game servers on AWS Fargate. Config-driven via `.env` files — add a new server by dropping a `Dockerfile`, `.env`, and `project.json` into `apps/`.

## Game Servers

| Server | Image | CPU | Memory | Port |
|--------|-------|-----|--------|------|
| Valheim | `ghcr.io/lloesche/valheim-server` | 1024 | 4096 MB | UDP 2456 |
| Unreal Tournament 99 | `roemer/ut99-server` | 512 | 1024 MB | UDP 7777 |
| Team Fortress Classic | `jives/hlds:tfc` | 256 | 512 MB | UDP 27015 |
| Team Fortress 2 | `cm2network/tf2` | 1024 | 2048 MB | UDP 27015 |
| Doom 2 (Zandronum) | `rcdailey/zandronum-server` | 256 | 512 MB | UDP 10666 |
| Quake 3 Arena | `inanimate/quake3` | 256 | 512 MB | UDP 27960 |
| Quake Live | `dpadgett/ql-docker` | 256 | 512 MB | UDP 27960 |
| 7 Days to Die | `vinanrra/7dtd-server` | 2048 | 8192 MB | UDP 26900 |
| Left 4 Dead 2 | `left4devops/l4d2` | 512 | 2048 MB | UDP 27015 |

## Prerequisites

### Team Fortress 2

A **Game Server Login Token (GSLT)** is required for TF2 to appear in the public server browser. Generate one at:

https://steamcommunity.com/dev/managegameservers

Use **AppID 440** when creating the token. Set it in `apps/tf2/.env`:

```
GAME_ENV_SRCDS_TOKEN=your_token_here
```

The server will still accept direct connections without a token, but won't be listed publicly.

### Doom 2

Zandronum requires a **WAD file** to run. You must provide one of:

- `doom2.wad` — from your Doom 2 purchase (Steam, GOG, etc.). Typically found at:
  - **Steam (Linux):** `~/.local/share/Steam/steamapps/common/Doom 2/base/doom2.wad`
  - **Steam (Windows):** `C:\Program Files (x86)\Steam\steamapps\common\Doom 2\base\doom2.wad`
  - **GOG:** check the install directory under `base/`
- `freedoom2.wad` — a free, open-source alternative available at https://freedoom.github.io/

Upload the WAD to the EFS volume mounted at `/data/` before starting the server. If using Freedoom, update `CONTAINER_COMMAND` in `apps/doom2/.env` to reference `freedoom2.wad` instead.

To load mods (Brutal Doom, etc.), place the `.pk3`/`.wad` files on the same EFS volume and append to the container command:

```
CONTAINER_COMMAND=-iwad /data/doom2.wad -file /data/brutalv21.pk3 -port 10666 ...
```

Zandronum also supports **Heretic**, **Hexen**, and **Strife** — just swap the WAD file.

### Quake 3 Arena

Requires **`pak0.pk3`** from your Quake 3 Arena retail install. Typical locations:

- **Steam (Linux):** `~/.local/share/Steam/steamapps/common/Quake 3 Arena/baseq3/pak0.pk3`
- **Steam (Windows):** `C:\Program Files (x86)\Steam\steamapps\common\Quake 3 Arena\baseq3\pak0.pk3`
- **GOG:** check the install directory under `baseq3/`

Upload `pak0.pk3` to the EFS volume mounted at `/usr/share/games/quake3/baseq3/` before starting the server.

Optionally place a `server.cfg` alongside it to customize map rotation, fraglimit, timelimit, bot config, and RCON password. See the [docker-quake3 repo](https://github.com/InAnimaTe/docker-quake3) for configuration examples.

### Quake Live

Quake Live is **free-to-play** — the server downloads game files via SteamCMD automatically on first start. No game purchase or file upload needed.

**Required setup:**

1. Set `GAME_ENV_admin` in `apps/quakelive/.env` to your **Steam64 ID** (find yours at https://steamid.io/). This grants you automatic RCON access in-game.

2. The image includes **minqlx** (plugin framework) which uses Redis for persistent data (map votes, ELO tracking, etc.). Without a Redis instance, minqlx plugins won't function, but the base server runs fine.

### 7 Days to Die

No game files needed upfront — **SteamCMD downloads everything automatically** on first boot (~15 GB). First startup takes 10-15 minutes depending on network speed.

**Important notes:**

- **EFS is critical.** Without persistent storage, the 15 GB download repeats on every container restart. World saves and backups also live on EFS.
- **Resource-heavy.** The default config (2 vCPU / 8 GB) is appropriate for 4-8 players. For larger servers or heavily modded games, scale up to 4096 CPU / 16384 MB.
- **Server config** is at `/home/sdtdserver/serverfiles/sdtdserver.xml` on the EFS volume. Edit this after first boot to set server name, password, max players, world settings, etc.
- **Web control panel** (port 8080) and **telnet** (port 8081) are exposed but require passwords configured in `sdtdserver.xml` before use.
- **Mods** are supported via env vars — see `apps/7dtd/.env.example` for Alloc Fixes, CPM, Undead Legacy, and Darkness Falls options.

### Left 4 Dead 2

No game files or tokens needed — the image downloads everything via SteamCMD automatically.

Game modes are configured via env vars in `apps/l4d2/.env`:

```
GAME_ENV_DEFAULT_MODE=coop       # coop, versus, realism, survival, scavenge
GAME_ENV_DEFAULT_MAP=c1m1_hotel  # Dead Center campaign start
GAME_ENV_RCON_PASSWORD=changeme  # change this before deploying
```

Custom addons can be added by extending the Dockerfile — see `apps/l4d2/.env.example` for details.

## Usage

```bash
# Interactive CLI
pnpm respawn

# Deploy all servers
pnpm respawn:deploy

# Check status
pnpm respawn:status

# Synth / diff CloudFormation
pnpm respawn:synth
pnpm respawn:diff

# Tear down
pnpm respawn:destroy
```

## Adding a New Server

Create a directory under `apps/<name>/` with three files:

1. **`Dockerfile`** — typically a single `FROM <upstream-image>:latest`
2. **`.env`** — all deployment config (see any existing server for the full set of options)
3. **`project.json`** — NX project descriptor:
   ```json
   {
     "name": "<name>",
     "projectType": "application",
     "tags": ["type:app", "lang:dockerfile"]
   }
   ```

The stack discovery mechanism automatically picks up any `apps/` directory containing both a `Dockerfile` and `.env`. No CDK or CLI changes required.

Add the service name to the `--service` lists in `package.json` for the convenience scripts.

Optionally (recommended) add a **`README.md`** documenting anything server-specific — resource sizing, world/save persistence, idle-shutdown quirks, wipe/update handling, and admin access. See [`apps/rust/README.md`](apps/rust/README.md) for the template to follow.
