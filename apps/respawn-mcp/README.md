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

## Security notes

- The rcon password never reaches this process or the MCP client — only the
  command text and the reply cross the wire, over SSM's encrypted channel.
- The command is base64-encoded before it enters the remote shell, so shell
  metacharacters in it cannot break out or inject.
- For GoldSrc games (cs16, tfc) rcon rides the game's UDP port, so the sidecar
  removes the password from the public wire but the port stays reachable. For
  Source games the sidecar lets you drop `27015/tcp` from `ADDITIONAL_PORTS`,
  taking rcon off the internet entirely.
