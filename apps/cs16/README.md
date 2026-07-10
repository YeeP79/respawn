# Counter-Strike 1.6 (`cs16`)

A GoldSrc/HLDS Counter-Strike 1.6 server. Light (256 CPU / 512 MB), UDP 27015,
scales to zero when empty.

## Image: local build + shim

`IMAGE_URI` is intentionally **unset**, so Respawn builds `Dockerfile` (from
`jives/hlds:cstrike`) and pushes it to ECR. The upstream entrypoint forwards
`hlds_run` arguments **without `eval`**, so a secret referenced in
`CONTAINER_COMMAND` would reach hlds as that literal string. Instead,
`respawn-init.sh` writes `cstrike/server.cfg` from injected env vars/secrets, then
`exec`s the upstream entrypoint. This keeps credentials out of the task definition
and out of `ps` inside the container.

The shim runs as the image's `steam` user (uid 999), which owns the game dir, and
rewrites `server.cfg` on **every** start — config stays declarative.

## Secrets

| Secret ref | Required? | Purpose |
|------------|-----------|---------|
| `RCON_PASSWORD=sm:respawn/cs16/rcon` | yes | Admin rcon; shim writes `rcon_password` |
| `SERVER_PASSWORD=sm:respawn/cs16/serverpw` | optional | Join password; shim writes `sv_password`. Omit for an open server |

Store values before the first deploy (a referenced-but-absent secret fails the
task with `ResourceInitializationError`):

```bash
pnpm respawn      # -> Secrets -> cs16 -> RCON_PASSWORD  (and SERVER_PASSWORD if used)
```

GoldSrc has **no GSLT**, so there is nothing else to store.

## RCON: the `rcon-control` sidecar (no inbound port)

`ENABLE_RCON_CONTROL=true` adds an `rcon-control` sidecar and flips
`enableExecuteCommand`. The sidecar runs rcon over loopback and is reachable
**only via `aws ecs execute-command` (SSM)** — there is no inbound rcon port. This
matters for GoldSrc because rcon otherwise rides the game's UDP port, brute-forceable
from the internet; the sidecar keeps the password off the public wire.

Run commands the easy way with the **[`@respawn/mcp`](../respawn-mcp/README.md)**
server (`list_servers`, `run_command`, `query`, `set_cvar`, raw `rcon`), or directly:

```bash
aws ecs execute-command --cluster respawn-dev-cs16 \
  --task "$(aws ecs list-tasks --cluster respawn-dev-cs16 --query 'taskArns[0]' --output text --profile respawn)" \
  --container rcon-control --interactive \
  --command "python3 /usr/local/bin/rcon.py --command 'status'" --profile respawn
```

The MCP's manifest for this server lives in `rcon-manifest.json` (commands, the
`players` query, tunable cvars).

## Networking defaults (the "click twice to fire" fix)

GoldSrc/HLDS ships with **`sv_maxupdaterate 30`**, which caps every client to 30
snapshots/sec no matter what rates they set — felt as poor hit registration and
having to click twice to fire. The shim bakes sane defaults into `server.cfg`
(`sv_maxupdaterate 101`, `sv_minupdaterate 20`, `sv_maxrate 100000`,
`sv_minrate 5000`, `sv_unlag 1`). Override per-server via `GAME_ENV_SV_MAXUPDATERATE`
etc. Clients should set matching `rate 100000; cl_updaterate 101; cl_cmdrate 101`.

## ⚠️ Live rcon changes are ephemeral

This server **scales to zero** after `IDLE_TIMEOUT_MINUTES` (a2s probe) and gets a
**fresh container on the next wake** — with a new public IP and a freshly-generated
`server.cfg`. Anything you set live over rcon (a cvar, a map rotation, `mp_startmoney`)
is **lost on that cold start**.

For anything that must persist, put it in config, not a live command:

- Passwords, hostname, net rates → already handled by the shim / `SECRET_REFS`.
- Other cvars → add them to `CONTAINER_COMMAND` (non-secret only) or extend the
  shim's `server.cfg` block.
- Map rotation → the image's `mapcycle.txt` (a build/image change).

There is **no EFS** on cs16 (no SteamCMD install, game files are baked into the
image), so `server.cfg` and `mapcycle.txt` reset to the image's contents every start.

## Reference

- Waking a scaled-to-zero server: `aws ecs update-service --cluster respawn-dev-cs16 --service respawn-dev-cs16 --desired-count 1 --profile respawn`
- Config keys and shared gotchas: [`../../README.md`](../../README.md), [`../../CLAUDE.md`](../../CLAUDE.md)
