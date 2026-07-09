# Respawn

Deploy and manage retro game servers on AWS Fargate. Config-driven via `.env` files — add a new server by dropping a `Dockerfile`, `.env`, and `project.json` into `apps/`.

Servers scale to zero when nobody is playing, so an idle fleet costs almost nothing.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [AI Quick Start: Respawn](#ai-quick-start-respawn)
- [Core Features](#core-features)
- [Game Servers](#game-servers)
- [Configuration Reference](#configuration-reference)
- [Secrets](#secrets)
- [Per-Server Setup](#per-server-setup)
- [Usage Examples](#usage-examples)
- [Best Practices](#best-practices)
- [Contributing](#contributing)

## Overview

**The problem.** A dedicated game server for a handful of friends is 95% idle, but a VPS bills
around the clock and hand-rolled CDK per game is unmaintainable.

**The approach.** One CDK stack, parameterised entirely by a `.env` file per game. An idle-shutdown
sidecar watches the game port and scales the ECS service to zero after 30 quiet minutes. Adding a
game means adding a directory, not writing infrastructure code.

**Key decisions:**

- **Discovery over registration.** `apps/*/` with a `.env` is a deployable server. No central list to update.
- **Fargate, not EC2.** No hosts to patch. Spot by default in dev/staging.
- **Secrets never in config.** Passwords and tokens live in Secrets Manager / SSM and arrive as ECS secrets.
- **Two image strategies.** Use an upstream image when it reads env vars; build a thin wrapper when it doesn't.

**Who should use this:** anyone running a few game servers for friends who wants them cheap and
reproducible, and is comfortable with AWS CDK.

## Installation

```bash
asdf install                       # node 24.13.0, python 3.14.2 (.tool-versions)
pnpm install
aws sso login --profile respawn    # your AWS profile; region us-east-1
```

You also need **Docker** running, but only for services that build their own image.

Bootstrap CDK once per account/region:

```bash
npx cdk bootstrap --profile respawn
```

---

## AI Quick Start: Respawn

### When to Use This Package

- Deploying a containerised, single-instance game server to AWS Fargate
- The server is reachable on one primary UDP/TCP port and tolerates scale-to-zero
- You want per-game config in a file, not in CDK code

### Don't Use This Package When

- You need multi-region, multi-instance, or matchmaking-aware fleets
- The game requires a persistent public IP across restarts (Fargate tasks get a new IP on every start)
- The server cannot tolerate a cold start — the idle sidecar stops the task, and waking it takes
  30–90s (much longer if a SteamCMD install must re-run)

### Most Common Pattern (80% Case)

Add a server whose upstream image is configured by environment variables:

```bash
mkdir -p apps/minetest
```

```dockerfile
# apps/minetest/Dockerfile  — required even when IMAGE_URI is set
FROM lscr.io/linuxserver/minetest:latest
```

```bash
# apps/minetest/.env
SERVICE_NAME=minetest
SERVICE_DISPLAY_NAME="Minetest Server"
IMAGE_URI=lscr.io/linuxserver/minetest:latest

CPU=512
MEMORY=1024

CONTAINER_PORT=30000
HOST_PORT=30000
PROTOCOL=UDP

ENABLE_IDLE_SHUTDOWN=true
IDLE_CHECK_METHOD=netstat
IDLE_TIMEOUT_MINUTES=30

GAME_ENV_SERVERNAME="Respawn Minetest"

AWS_ACCOUNT_ID=123456789012
AWS_REGION=us-east-1
AWS_PROFILE=respawn
```

```json
// apps/minetest/project.json
{
  "name": "minetest",
  "projectType": "application",
  "tags": ["type:app", "lang:dockerfile"]
}
```

```bash
pnpm respawn        # interactive menu -> Deploy -> minetest
```

### Integration with Other Packages

- **Always used with:** AWS CDK v2, Nx (targets + affected graph), pnpm workspaces
- **Usually used with:** Docker (only for services that build an image), AWS SSO
- **Replaces:** hand-written per-game CDK stacks, `docker-compose` on a permanently-billing VPS

### Critical Requirements

1. **A service without `.env` does not exist.** Discovery skips it silently — no warning.
2. **Never put a secret in `CONTAINER_COMMAND` or `GAME_ENV_*`.** Both land in the ECS task
   definition in plaintext. Use `SECRET_REFS`.
3. **Every `SECRET_REFS` entry must exist before the first deploy**, or the task dies with
   `ResourceInitializationError`.
4. **`CPU` and `MEMORY` must be a valid Fargate pair** — validated at load, fails fast.
5. **Docker build context is the repo root**, so `COPY` paths are `apps/<name>/...`.

### Common Mistakes to Avoid

```bash
# Wrong — plaintext secret, readable by anyone with ECS read access
CONTAINER_COMMAND=+rcon_password hunter2
GAME_ENV_RCON_PASSWORD=hunter2

# Correct — injected as an ECS secret
SECRET_REFS=RCON_PASSWORD=sm:respawn/cs16/rcon
```

```bash
# Wrong — dotenv strips `#...` as an inline comment, silently truncating the ref
SECRET_REFS=DB=sm:respawn/app/db#password

# Correct — the jsonKey delimiter is `|`
SECRET_REFS=DB=sm:respawn/app/db|password
```

```bash
# Silently ignored — environment overrides are applied AFTER .env is parsed
USE_FARGATE_SPOT=false     # dev/staging always force spot ON; prod forces it OFF
LOG_RETENTION_DAYS=99      # always 7 (dev) / 14 (staging) / 30 (prod)
```

```bash
# Breaks after a redeploy — a service with no EFS re-downloads its game files
# on every cold start, including every wake from idle shutdown.
ENABLE_PERSISTENT_STORAGE=false   # wrong for any SteamCMD-installed game
```

---

## Core Features

- **Scale to zero:** an idle sidecar polls the game port and stops the task after `IDLE_TIMEOUT_MINUTES`
- **Zero-code onboarding:** three files in `apps/<name>/` and the CLI finds it
- **First-class secrets:** `SECRET_REFS` → Secrets Manager / SSM → ECS `secrets:`, never `environment:`
- **Persistent worlds:** optional EFS volume, transit-encrypted, IAM-authorised
- **Deploy-time prompts:** pick a gamemode at deploy without editing config (`DEPLOY_PROMPTS`)
- **Interactive or scripted:** Clack menu by default, `--non-interactive` for CI

---

## Game Servers

| Server | Image | CPU | Memory | Port | EFS | Secrets |
|--------|-------|-----|--------|------|-----|---------|
| Valheim | `ghcr.io/lloesche/valheim-server` | 1024 | 4096 MB | UDP 2456 | yes | yes |
| Unreal Tournament 99 | `roemer/ut99-server` | 512 | 1024 MB | UDP 7777 | no | yes |
| Team Fortress Classic | `jives/hlds:tfc` | 256 | 512 MB | UDP 27015 | no | no |
| Team Fortress 2 | `cm2network/tf2` | 1024 | 2048 MB | UDP 27015 | no | no |
| Counter-Strike 1.6 | *local build* (`jives/hlds:cstrike`) | 256 | 512 MB | UDP 27015 | no | yes |
| Counter-Strike: Source | *local build* (LinuxGSM) | 1024 | 2048 MB | UDP 27015 | yes | yes |
| Counter-Strike 2 | `cm2network/cs2` | 2048 | 4096 MB | UDP 27015 | yes | yes |
| Garry's Mod | *local build* (LinuxGSM) | 2048 | 4096 MB | UDP 27015 | yes | yes |
| Left 4 Dead 2 | `left4devops/l4d2` | 512 | 2048 MB | UDP 27015 | no | no |
| Doom 2 (Zandronum) | `rcdailey/zandronum-server` | 256 | 512 MB | UDP 10666 | yes | no |
| Quake 3 Arena | `inanimate/quake3` | 256 | 512 MB | UDP 27960 | yes | no |
| Quake Live | `dpadgett/ql-docker` | 256 | 512 MB | UDP 27960 | no | no |
| 7 Days to Die | `vinanrra/7dtd-server` | 2048 | 8192 MB | UDP 26900 | yes | no |
| Rust | `didstopia/rust-server` | 4096 | 16384 MB | UDP 28015 | yes | yes |

*Local build* means `IMAGE_URI` is unset: the `Dockerfile` layers a `respawn-init.sh` shim over the
upstream image and is pushed to ECR. See [Contributing](#contributing).

> **Security note.** `tfc`, `l4d2`, `rust`, and `tf2` still carry `changeme` placeholder credentials
> in their config. Change them — ideally by migrating them to `SECRET_REFS` — before deploying.

---

## Configuration Reference

Every key below is read from `apps/<name>/.env` by `apps/respawn/src/config/loader.ts`.
Unknown keys are ignored; malformed ones fail fast at load.

### Identity & image

| Key | Default | Description |
|-----|---------|-------------|
| `SERVICE_NAME` | directory name | Stack and cluster name component |
| `SERVICE_DISPLAY_NAME` | `SERVICE_NAME` | Human label in the CLI |
| `IMAGE_URI` | — | Upstream image. **If unset**, `Dockerfile` is built and pushed to ECR |
| `DOCKERFILE_PATH` | `./Dockerfile` | Relative to the service directory |

### Container & networking

| Key | Default | Description |
|-----|---------|-------------|
| `CPU` | `1024` | Fargate CPU units. One of 256, 512, 1024, 2048, 4096 |
| `MEMORY` | `2048` | MiB. Must be legal for the chosen `CPU` |
| `CONTAINER_COMMAND` | image default | Split on whitespace. **Never put secrets here** |
| `CONTAINER_PORT` / `HOST_PORT` | `7777` | Primary game port |
| `PROTOCOL` | `UDP` | `UDP` or `TCP` |
| `ADDITIONAL_PORTS` | — | `port/proto` or `host:container/proto`, comma-separated |
| `ENABLE_PUBLIC_ACCESS` | `true` | Public subnet + security group ingress |

### Cost & lifecycle

| Key | Default | Description |
|-----|---------|-------------|
| `ENABLE_IDLE_SHUTDOWN` | `true` | Scale to zero when idle |
| `IDLE_TIMEOUT_MINUTES` | `30` | Quiet minutes before stopping |
| `IDLE_CHECK_METHOD` | `netstat` | `netstat` (UDP games) or `http` (needs `IDLE_STATUS_ENDPOINT`) |
| `IDLE_CHECK_INTERVAL_SECONDS` | `60` | Poll interval |
| `USE_FARGATE_SPOT` | `true` | **Overridden by environment** — see below |
| `DESIRED_COUNT` | `1` | Task count |
| `ENABLE_AUTOSCALING` | `false` | With `MIN_CAPACITY`, `MAX_CAPACITY`, `AUTOSCALE_CPU_TARGET` |

### Storage, secrets & extras

| Key | Default | Description |
|-----|---------|-------------|
| `ENABLE_PERSISTENT_STORAGE` | `false` | EFS volume. Required for any SteamCMD-installed game |
| `PERSISTENT_MOUNT_PATH` | `/data` | Where the volume mounts |
| `SECRET_REFS` | — | `ENV_VAR=<sm\|ssm>:<sourceId>[\|jsonKey]`, comma-separated |
| `GAME_ENV_*` | — | Prefix stripped, passed as container env. **Not for secrets** |
| `DEPLOY_PROMPTS` | — | `ENV_VAR:select:a\|b\|c` — asked at deploy, overrides `GAME_ENV_*` |
| `ENABLE_REDIS_SIDECAR` | `false` | Redis sidecar (Quake Live's minqlx uses this) |
| `LOG_RETENTION_DAYS` | `14` | **Overridden by environment** — see below |
| `AWS_ACCOUNT_ID` / `AWS_REGION` / `AWS_PROFILE` | — / `us-east-1` / — | Deploy target |

### Environments

`dev` (default), `staging`, `prod`. Overrides are applied **after** `.env` is parsed, so these two
keys in `.env` are silently ignored:

| Environment | `LOG_RETENTION_DAYS` | `USE_FARGATE_SPOT` |
|-------------|----------------------|--------------------|
| `dev` | 7 | `true` |
| `staging` | 14 | `true` |
| `prod` | 30 | `false` (plus `MIN_CAPACITY=1`) |

---

## Secrets

Passwords and tokens must never sit in `.env`, the task definition, or CloudWatch logs. Reference
them instead; ECS injects them as `secrets:` at container start.

```bash
# apps/cs16/.env
SECRET_REFS=RCON_PASSWORD=sm:respawn/cs16/rcon
```

Naming convention: `respawn/<service>/<name>` for Secrets Manager, `/respawn/<service>/<name>` for SSM.

Set or rotate the value — masked input, written straight to AWS, never echoed or persisted:

```bash
pnpm respawn        # -> Secrets -> cs16 -> RCON_PASSWORD
```

Read one back when you need it:

```bash
aws secretsmanager get-secret-value --secret-id respawn/cs16/rcon \
  --profile respawn --query SecretString --output text
```

**Three things that bite:**

1. **A referenced secret must exist before the first deploy.** ECS resolves secrets *before* starting
   the container, and CDK only synthesises an ARN — it never checks existence. A missing one fails the
   task with `ResourceInitializationError`.
2. **Making a secret optional means deleting its entry**, not leaving the store empty. An SSM
   SecureString cannot hold an empty value.
3. **The `jsonKey` delimiter is `|`, not `#`** — `dotenv` treats `#` as an inline comment and
   truncates the value silently.

Full specification: [`artifacts/AGENT_PROMPT.md`](artifacts/AGENT_PROMPT.md) §7.

---

## Per-Server Setup

### Counter-Strike 2

A **Game Server Login Token (GSLT)** is **mandatory** — CS2 will not start without one. Generate at
https://steamcommunity.com/dev/managegameservers using **AppID 730**, then store both secrets:

```bash
pnpm respawn   # -> Secrets -> cs2 -> SRCDS_TOKEN, CS2_RCONPW
```

EFS is required: the SteamCMD install is ~60 GB and would otherwise re-download on every cold start.
Gamemode is chosen at deploy time (`competitive`, `casual`, `deathmatch`, `wingman`).

### Counter-Strike: Source / Garry's Mod

Both use LinuxGSM images, which are configured by *files* rather than env vars, so each layers a
`respawn-init.sh` shim that writes `<game>server.cfg` from the injected environment before handing
off to the upstream entrypoint. Both need EFS at `/data`.

GSLT is **optional** — it only controls public listing. To run unlisted, delete the `GSLT=` entry
from `SECRET_REFS`; leaving it referenced but unset will fail the task.

Garry's Mod asks for a gamemode at deploy time (`ttt`, `prop_hunt`, `darkrp`), and its task is sized
for the heaviest one.

### Counter-Strike 1.6

No GSLT and no game files to supply. HLDS takes its settings as command-line arguments, but its
entrypoint forwards them without `eval`, so a secret can never be referenced there. The shim writes
`cstrike/server.cfg` (which GoldSrc execs at map start) from `RCON_PASSWORD` instead.

### Team Fortress 2

A **GSLT** is required for TF2 to appear in the public server browser. Generate one at
https://steamcommunity.com/dev/managegameservers using **AppID 440**.

The server still accepts direct connections without a token, but won't be listed publicly.

> `apps/tf2/.env` currently holds the token as `GAME_ENV_SRCDS_TOKEN`, which puts it in the task
> definition in plaintext. Prefer `SECRET_REFS=SRCDS_TOKEN=ssm:/respawn/tf2/gslt`, as `cs2` does.

### Doom 2

Zandronum requires a **WAD file**. Provide one of:

- `doom2.wad` — from your Doom 2 purchase (Steam, GOG, etc.). Typically found at:
  - **Steam (Linux):** `~/.local/share/Steam/steamapps/common/Doom 2/base/doom2.wad`
  - **Steam (Windows):** `C:\Program Files (x86)\Steam\steamapps\common\Doom 2\base\doom2.wad`
  - **GOG:** check the install directory under `base/`
- `freedoom2.wad` — a free, open-source alternative from https://freedoom.github.io/

Upload the WAD to the EFS volume mounted at `/data/` before starting the server. If using Freedoom,
update `CONTAINER_COMMAND` in `apps/doom2/.env` to reference `freedoom2.wad` instead.

To load mods (Brutal Doom, etc.), place the `.pk3`/`.wad` files on the same EFS volume and append to
the container command:

```
CONTAINER_COMMAND=-iwad /data/doom2.wad -file /data/brutalv21.pk3 -port 10666 ...
```

Zandronum also supports **Heretic**, **Hexen**, and **Strife** — just swap the WAD file.

### Quake 3 Arena

Requires **`pak0.pk3`** from your retail install:

- **Steam (Linux):** `~/.local/share/Steam/steamapps/common/Quake 3 Arena/baseq3/pak0.pk3`
- **Steam (Windows):** `C:\Program Files (x86)\Steam\steamapps\common\Quake 3 Arena\baseq3\pak0.pk3`
- **GOG:** check the install directory under `baseq3/`

Upload it to the EFS volume mounted at `/usr/share/games/quake3/baseq3/` before starting the server.

Optionally place a `server.cfg` alongside it to customise map rotation, fraglimit, timelimit, bot
config, and RCON password. See the [docker-quake3 repo](https://github.com/InAnimaTe/docker-quake3).

### Quake Live

Free-to-play — the server downloads game files via SteamCMD automatically on first start.

1. Set `GAME_ENV_admin` in `apps/quakelive/.env` to your **Steam64 ID** (find yours at
   https://steamid.io/). This grants you automatic RCON access in-game.
2. The image includes **minqlx** (plugin framework), which uses Redis for persistent data (map votes,
   ELO tracking). `ENABLE_REDIS_SIDECAR=true` provides it. Without Redis the base server still runs.

### 7 Days to Die

**SteamCMD downloads everything automatically** on first boot (~15 GB). First startup takes 10–15
minutes depending on network speed.

- **EFS is critical.** Without it the 15 GB download repeats on every container restart. World saves
  and backups also live on EFS.
- **Resource-heavy.** The default (2 vCPU / 8 GB) suits 4–8 players. For larger or heavily modded
  servers, scale to `CPU=4096` / `MEMORY=16384`.
- **Server config** lives at `/home/sdtdserver/serverfiles/sdtdserver.xml` on EFS. Edit after first
  boot to set server name, password, max players, and world settings.
- **Web control panel** (8080) and **telnet** (8081) are exposed but require passwords set in
  `sdtdserver.xml` before use.
- **Mods** are supported via env vars — see `apps/7dtd/.env.example` for Alloc Fixes, CPM, Undead
  Legacy, and Darkness Falls options.

### Left 4 Dead 2

No game files or tokens needed. Game modes are configured in `apps/l4d2/.env`:

```
GAME_ENV_DEFAULT_MODE=coop       # coop, versus, realism, survival, scavenge
GAME_ENV_DEFAULT_MAP=c1m1_hotel  # Dead Center campaign start
```

> The RCON password ships as `GAME_ENV_RCON_PASSWORD=changeme` and lands in the task definition in
> plaintext. Change it, and prefer moving it to `SECRET_REFS`.

### Rust

SteamCMD installs the game on first boot; no purchase or token needed to *run* the server. Sized at
4 vCPU / 16 GB by default. See [`apps/rust/README.md`](apps/rust/README.md) for wipe handling,
scaling, and Rust+ companion-app setup.

### Valheim / Unreal Tournament 99

Both take a password via `SECRET_REFS` (`SERVER_PASS` and `UT_ADMINPWD`). Set them before the first
deploy.

---

## Usage Examples

### Basic: deploy one server

```bash
pnpm respawn              # interactive: pick action, environment, service
```

### Advanced: non-interactive deploy to prod

```bash
npx nx run respawn:cdk --nonInteractive --action=deploy \
  --profile=respawn --environment=prod --service=cs16,css
```

Prod forces `USE_FARGATE_SPOT=false` and `MIN_CAPACITY=1`, so tasks stop being interrupted — and
stop being cheap.

### Integration: inspect before you apply

```bash
pnpm respawn:synth        # render CloudFormation
pnpm respawn:diff         # diff against deployed state
pnpm respawn:status       # running tasks, public IPs
```

> `respawn:synth`, `:diff`, `:deploy`, `:destroy`, and `:status` pass a **hardcoded `--service`
> list** in `package.json`. It has drifted — `cs16`, `cs2`, `css`, and `gmod` are missing, so those
> four are silently skipped. Add new services to those lists, or use the interactive `pnpm respawn`
> menu, which discovers everything.

### Error handling: when a server won't come up

| Symptom | Cause |
|---------|-------|
| Service missing from the CLI menu | No `.env` in `apps/<name>/` — discovery skips it silently |
| Task stops with `ResourceInitializationError` | A `SECRET_REFS` entry names a secret that doesn't exist |
| Config rejected at load with `Invalid memory …` | `CPU`/`MEMORY` are not a legal Fargate pair |
| Long cold start on every wake | `ENABLE_PERSISTENT_STORAGE=false` on a SteamCMD game |
| `docker build` cannot find a `COPY` source | Build context is the repo root; use `apps/<name>/…` |
| `.env` change to spot or log retention has no effect | Overridden by the environment (`dev`/`staging`/`prod`) |

```bash
# Read why a task died
aws ecs describe-tasks --cluster respawn-dev-cs16 --tasks <task-arn> \
  --profile respawn --query 'tasks[0].stoppedReason'
```

---

## Best Practices

**Configuration.** Keep `.env.example` in sync with `.env` — the example is the only tracked copy,
and `.env` is gitignored. Set `AWS_ACCOUNT_ID` explicitly rather than relying on ambient credentials.

**Cost.** Leave `ENABLE_IDLE_SHUTDOWN=true`. An idle fleet with scale-to-zero costs only EFS storage
and log retention. Spot is on by default outside prod.

**Persistence.** Any game whose image runs SteamCMD needs `ENABLE_PERSISTENT_STORAGE=true`, or the
full install repeats on every wake from idle. Confirm the image's install path before setting
`PERSISTENT_MOUNT_PATH` — LinuxGSM uses `/data`, `cm2network/cs2` uses `/home/steam/cs2-dedicated`.

**Security.** Secrets go through `SECRET_REFS`, never `GAME_ENV_*` or `CONTAINER_COMMAND`. Rotate by
re-running the Secrets action and redeploying. Fargate tasks get a new public IP on every start, so
don't hand out a bare IP for anything long-lived.

**Testing.** Config parsing and validation are the bug-prone parts and are unit-tested. Add specs to
`apps/respawn/src/config/loader.spec.ts` for any new key, including its rejection cases.

---

## Contributing

### Adding a new server

Create `apps/<name>/` with four files:

1. **`Dockerfile`** — usually a single `FROM <upstream-image>`
2. **`.env`** — deployment config. **Gitignored**; nothing deploys without it
3. **`.env.example`** — the tracked template. Keep it in sync
4. **`project.json`** — the Nx descriptor:
   ```json
   {
     "name": "<name>",
     "projectType": "application",
     "tags": ["type:app", "lang:dockerfile"]
   }
   ```

Discovery picks up any `apps/` directory that has a **`.env`**, plus either a `Dockerfile` or an
`IMAGE_URI`. No CDK or CLI changes required.

Then add the service to the `--service` lists in `package.json` for the convenience scripts.

Optionally (recommended) add a **`README.md`** documenting anything server-specific — resource
sizing, world/save persistence, idle-shutdown quirks, wipe/update handling, and admin access. See
[`apps/rust/README.md`](apps/rust/README.md) for the template.

### When the upstream image can't take env vars

Some images are configured by files, or forward arguments without `eval` so a secret can never be
referenced on the command line. For these, leave `IMAGE_URI` unset and layer a shim:

```dockerfile
# apps/<name>/Dockerfile  — build context is the repo root
FROM upstream/image:tag
COPY apps/<name>/respawn-init.sh /respawn-init.sh
ENTRYPOINT ["/bin/sh", "/respawn-init.sh"]
```

The shim writes the game's config file from injected env vars, then `exec`s the upstream entrypoint.
Check the base image's `USER` first: a `RUN chmod +x` fails on images that drop to a non-root user,
which is why the entrypoint above invokes `/bin/sh` explicitly.

Working examples: `apps/gmod` and `apps/css` (LinuxGSM), `apps/cs16` (HLDS).

### Before you commit

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Development standards, patterns, and gotchas live in [`CLAUDE.md`](CLAUDE.md).
