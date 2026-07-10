# @respawn/mcp

An MCP server for changing Respawn game-server settings mid-game, by voice or chat
through an MCP client (Claude Desktop, etc.).

## How it works

The MCP never speaks rcon and never holds the rcon password. It discovers running
servers from AWS, then reaches each one's `rcon-control` sidecar via
`aws ecs execute-command` (SSM) and runs `rcon.py` there. The password lives in
the sidecar as an ECS secret and never leaves the task; the MCP only ships the
command in and reads the reply out.

```
MCP client → this server → aws ecs execute-command → rcon-control sidecar → game (loopback)
```

Because discovery reads AWS rather than the repo, the server works installed
anywhere and only lists servers that are actually up — a scaled-to-zero server has
no task to control and correctly does not appear.

## Setup (for a new developer)

### 1. Install the AWS CLI and the Session Manager plugin

`aws ecs execute-command` tunnels through AWS Systems Manager, which needs a
separate plugin. Without it every command fails with a clear message.

```bash
# macOS
brew install awscli session-manager-plugin

# Debian / Ubuntu
curl -o /tmp/smp.deb "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb"
sudo dpkg -i /tmp/smp.deb

# Arch
yay -S aws-session-manager-plugin

# Verify
session-manager-plugin --version
```

Other platforms: <https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html>

### 2. Get AWS credentials for the game account

```bash
aws sso login --profile respawn      # or whatever profile name you use
```

The IAM identity needs, at minimum:

```json
{
  "Effect": "Allow",
  "Action": [
    "ecs:ListClusters",
    "ecs:ListTasks",
    "ecs:DescribeTasks",
    "ecs:ExecuteCommand"
  ],
  "Resource": "*"
}
```

`ecs:ExecuteCommand` is the one that lets you run rcon; the other three are for
server discovery. (An admin/power-user SSO role already covers these.)

### 3. Build the MCP

```bash
pnpm install
npx nx build respawn-mcp            # -> apps/respawn-mcp/dist/index.js
```

### 4. Point your MCP client at it

```json
{
  "mcpServers": {
    "respawn-rcon": {
      "command": "node",
      "args": ["/absolute/path/to/repo/apps/respawn-mcp/dist/index.js"],
      "env": {
        "RESPAWN_PROFILE": "respawn",
        "RESPAWN_REGION": "us-east-1"
      }
    }
  }
}
```

`RESPAWN_PROFILE` / `RESPAWN_REGION` fall back to `AWS_PROFILE` / `AWS_REGION`,
then to `us-east-1`.

> **`RESPAWN_REGION` must match the region your servers are actually deployed in.**
> Discovery is region-scoped, so a mismatch (e.g. the default `us-east-1` while the
> fleet runs in `us-east-2`) makes `list_servers` return nothing — it looks like an
> auth problem but isn't. Check with `aws ecs list-clusters --region <region> --profile respawn`.

### 5. The server must be deployed with the sidecar

The MCP can only reach a server whose task carries the `rcon-control` sidecar,
which means the service was deployed with **`ENABLE_RCON_CONTROL=true`** (this
flips `enableExecuteCommand` and adds the container). A server without it — or one
scaled to zero — will not appear in `list_servers`. Deploy or wake it first:

```bash
pnpm respawn:deploy   # or: aws ecs update-service … --desired-count 1
```

### Quick check

```bash
# Confirm you can reach a running, rcon-enabled server directly:
aws ecs execute-command --cluster respawn-dev-cs16 \
  --task "$(aws ecs list-tasks --cluster respawn-dev-cs16 --query 'taskArns[0]' --output text --profile respawn)" \
  --container rcon-control --interactive --command "python3 /usr/local/bin/rcon.py --info" \
  --profile respawn
```

If that prints the sidecar's `--info`, the MCP will work.

## Tools

The MCP holds no game knowledge. Everything game- or mod-specific — which commands
exist, how to parse a query — comes from each server's manifest.

| Tool | Arguments | Effect |
|------|-----------|--------|
| `list_servers` | — | Running, controllable servers |
| `get_server_options` | service | The server's manifest: commands, queries, cvars, maps |
| `run_command` | service, command, args | Run a declared command (change_map, kick_player, mod commands, …) |
| `query` | service, query | Run a declared query (e.g. `players`) → structured JSON |
| `set_cvar` | service, cvar, value | Set any console variable live |
| `rcon` | service, command | Raw rcon escape hatch |

The LLM's normal flow: call `get_server_options` to see what a server offers, then
`run_command` / `query` with valid names and values.

## Per-server manifests

Each game declares its controllable surface in `apps/<name>/rcon-manifest.json`,
bundled into the MCP at build (`generate-manifests.mjs`). Editing one — adding a
mod's commands, a new query — needs only an MCP rebuild, never a game redeploy.

```jsonc
{
  "engine": "goldsrc",
  "commands": [
    { "name": "change_map", "description": "Switch map now",
      "rcon": "changelevel {map}", "args": { "map": { "type": "string" } } },
    { "name": "slap", "description": "AMX Mod X slap", "mod": "amxmodx",
      "rcon": "amx_slap {player} {dmg}" }          // mod command — MCP needs no code
  ],
  "queries": [
    { "name": "players", "description": "Who is connected", "rcon": "status",
      "singles": { "map": "^map\\s*:\\s*(\\S+)" },
      "row": { "match": "^#\\s*(\\d+)\\s+\"([^\"]*)\"\\s+(STEAM_\\S+|BOT)?",
               "fields": ["userid", "name", "steamid"],
               "skipIf": "^#\\s*userid" } }
  ],
  "cvars": [ { "name": "mp_friendlyfire", "default": "0", "values": ["0", "1"] } ],
  "maps": "live"        // pulled from the running server, or a static list
}
```

- **commands** — an rcon template with `{arg}` placeholders. Mod commands are
  first-class; the MCP runs them with no game-specific code.
- **queries** — data-driven parsing. `singles` pull one value each from the whole
  reply; `row` builds a record per matching line. This is why player parsing lives
  here, not in the MCP.
- **cvars** — documented tunables with ranges, so the LLM uses valid values.
- **maps** — `"live"` queries the server (`maps *`); or an explicit array.

## Gotchas

- **`set_cvar` only accepts cvars declared in the manifest.** It validates against
  the `cvars` list (names, ranges) so the LLM can't set a garbage value. For any
  console variable *not* in the manifest — server tunables like `sv_maxupdaterate`,
  `mp_maxrounds`, `mp_timelimit` — use the raw **`rcon`** tool instead, or add the
  cvar to `rcon-manifest.json`.
- **Changes made through the MCP are ephemeral on scale-to-zero servers.** Respawn
  servers idle down to zero tasks and come back as a fresh container. A cvar or map
  you set live is gone on the next cold start. Persist anything that must survive in
  the game's config (for cs16, the shim's `server.cfg`), not a live command.
- **`maps: "live"` degrades, and can miss maps on a large pool.** The live query
  runs `maps *` through one exec session; on a very long map list the session can be
  truncated before the closing sentinel, and `get_server_options` returns a
  `mapsNote` explaining it fell back to the manifest maps. If a server has a big map
  pool, prefer an explicit `maps` array in the manifest.
- **Temporary/SSO credentials expire mid-session.** A lapsed session token surfaces
  as `ExpiredTokenException` from the `aws` calls, not an MCP error. Re-run
  `aws sso login --profile respawn` (or refresh the profile) and retry.
- **A dropped/rate-limited probe reads as *unknown*, never *empty*** — the same
  safety property the idle watchdog relies on. If a query returns nothing, the server
  may simply be mid-wake; retry rather than assume it's down.

## Is the connection to the sidecar secure?

Yes. The MCP reaches the sidecar over **AWS Systems Manager Session Manager** —
the same channel `aws ecs execute-command` uses — not a port we open.

- **Encrypted in transit.** Session Manager runs over a TLS 1.2 WebSocket. No
  inbound port is exposed on the task; the connection is established outward from
  the SSM agent in the container. There is no listening rcon socket to reach from
  the internet.
- **IAM-authenticated.** Only a caller with `ecs:ExecuteCommand` on the account
  can open a session. The task role is granted the four `ssmmessages:*` actions
  and nothing more.
- **The rcon password never crosses this channel.** It lives in the sidecar as an
  ECS secret; only the command text and the reply travel over the session. The
  MCP process and the MCP client never see it.
- **No shell injection.** The command is base64-encoded before it enters the
  remote shell, so metacharacters in it cannot break out — it only ever becomes an
  argument to `rcon.py`.

**Additional hardening (configured when `ENABLE_RCON_CONTROL` is on):**

- **Customer-managed KMS key.** The exec data channel is encrypted with a
  per-service KMS key (rotation enabled), on top of the SSM default TLS.
- **Session audit logging.** Every exec session is logged to CloudWatch at
  `/respawn/<env>/<service>/exec-audit` (retained a year) — a record of who ran
  what, when. The task role is granted only encrypt/decrypt on the key and write
  on that log group.

These are provisioned only for services that enable the sidecar, so a server
without rcon-control creates neither.

**The game port itself is a separate matter.** For GoldSrc games (cs16, tfc) rcon
rides the game's UDP port, so the sidecar removes the password from the public
wire but the port stays reachable and brute-forceable. For Source games the
sidecar lets you drop `27015/tcp` from `ADDITIONAL_PORTS`, taking rcon off the
internet entirely.
