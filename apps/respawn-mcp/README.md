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

## Requirements

- **AWS credentials** for the account the servers run in (`aws sso login`).
- **session-manager-plugin** installed locally — `aws ecs execute-command` needs
  it. Without it, calls fail with a clear message.
- A server deployed with **`ENABLE_RCON_CONTROL=true`** (which flips
  `enableExecuteCommand` and adds the sidecar).

## Build

```bash
npx nx build respawn-mcp        # -> apps/respawn-mcp/dist/index.js
```

## Configure an MCP client

```json
{
  "mcpServers": {
    "respawn-rcon": {
      "command": "node",
      "args": ["/absolute/path/to/apps/respawn-mcp/dist/index.js"],
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

## Tools

| Tool | Arguments | Effect |
|------|-----------|--------|
| `list_servers` | — | Running, controllable servers |
| `server_status` | service | `status` — players and current map |
| `change_map` | service, map | `changelevel <map>` |
| `set_cvar` | service, cvar, value | Set any console variable live |
| `set_server_password` | service, password | `sv_password` (empty clears it) — the join password, not rcon |
| `say` | service, message | Broadcast to everyone |
| `rcon` | service, command | Raw rcon escape hatch |

Example: *"change cs16 to de_nuke"* → `change_map(service="cs16", map="de_nuke")`.

## Security notes

- The rcon password never reaches this process or the MCP client — only the
  command text and the reply cross the wire, over SSM's encrypted channel.
- The command is base64-encoded before it enters the remote shell, so shell
  metacharacters in it cannot break out or inject.
- For GoldSrc games (cs16, tfc) rcon rides the game's UDP port, so the sidecar
  removes the password from the public wire but the port stays reachable. For
  Source games the sidecar lets you drop `27015/tcp` from `ADDITIONAL_PORTS`,
  taking rcon off the internet entirely.
