# Respawn — Session Handoff

Where to pick up after a context reset. Repo is `@respawn/source` (AWS Fargate game
servers, config-driven via `apps/<name>/.env`).

AWS account **847378615943**, region **us-east-1**, profile **respawn**.
Log in with `aws sso login --profile respawn --use-device-code` — the plain form opens
your default browser, which is signed into the *work* Identity Center; `--use-device-code`
prints a URL + code you paste into the browser signed into the personal `d-9066000aae`
portal. The token is short-lived and expires mid-session; re-run when a call reports
`Token has expired`.

**`main` is at `cfe3591`. Clean tree, pushed. All servers scaled to 0 — nothing billing.**

---

## What the MCP can and cannot do

It **controls and observes** servers. It **cannot create, deploy, scale, or wake** them —
there is no such tool. Deploying is the CLI's job (`pnpm respawn`, or `nx run respawn:cdk`).
This matters: the game-facing tools need a *running task*, and the MCP cannot produce one.

Thirteen tools. Which need a live task:

| Tool | Live task? | Purpose |
|------|:---:|---------|
| `list_servers` | shows only running | discover controllable servers |
| `get_server_options` | no (live maps if up) | manifest: commands, cvars, maps |
| `describe_transport` | manifest half no, live half yes | what the sidecar speaks + declared surface |
| `server_health` | **no** | task/container state, exit codes, "why is nothing running" |
| `server_metrics` | no (CloudWatch) | CPU/mem timeline + sparkline, `resolution=1m\|5m` |
| `server_logs` | no (CloudWatch) | log tail, relative `minutes` or absolute `since`/`until` |
| `query` | yes | run a declared query → structured JSON |
| `rcon`, `run_command`, `set_cvar` | yes | send commands (no-op on query-only games) |
| `capture_raw` | yes | unparsed transport reply, for authoring a manifest |
| `sample` | yes | run a query N times, report how a field moves |
| `container_stats` | yes (1 exec/call) | live per-container cpu/rss/cache/usage |

---

## Proven end-to-end (all live)

The full chain **MCP → ECS Exec → rcon-control sidecar → game** is verified against real
servers, not just tests:

- **doom2** (zandronum): `rcon`, `run_command say`, `set_cvar sv_gravity 800→900→800`.
- **cs16** (goldsrc): `rcon stats` returned a live server table — first goldsrc rcon
  through the MCP.
- **tfc** (goldsrc): `query players` → structured rows after fixing its map (see below).
- **ut99** (gamespy): `query server_info` and `query players` → parsed player rows, with a
  real human connected. GameSpy is read-only, so no `run_command`/`set_cvar`.
- All four monitoring tools driven live; three also against a scaled-to-zero service.

---

## Deployed inventory (4 game stacks, all desiredCount 0)

| Stack | Protocol | Exec | Manifest | Notes |
|-------|----------|:---:|----------|-------|
| `respawn-dev-shared` | — | — | — | VPC (no NAT — public subnets), ECR repos |
| `respawn-dev-doom2` | zandronum | ✅ | no queries | freedoom baked in |
| `respawn-dev-cs16` | goldsrc | ✅ | `players` | 607 MB image |
| `respawn-dev-tfc` | goldsrc | ✅ | `players` | map is `2fort`, not `ctf_2fort` |
| `respawn-dev-ut99` | gamespy | ✅ | `server_info`, `players` | read-only; webadmin on 5580 for writes |

All four sidecars are `rcon-control` at **128 MiB** (sized from measured rss; see traps).

**Every deployed sidecar predates commit `cfe3591`**, so the new `capture_raw` / `sample` /
`describe_transport --info` and the `--raw` flag are **not live anywhere yet** — they need a
redeploy of any service to exercise their exec paths. Their pure logic is unit-tested; the
live exec paths are the one unproven thing in the MCP right now.

Manifests exist for 10 games: cs16, cs2, css, doom2, gmod, l4d2, quake3, tf2, tfc, ut99.
`ENABLE_RCON_CONTROL=true` on 4: cs16, doom2, tfc, ut99. Every game app has a `.env`.

Secrets in Secrets Manager (all present): rcon for cs16, cs2, css, doom2, gmod, l4d2, tf2,
tfc; `respawn/rust/rcon-password`, `respawn/ut99/admin-pwd`, `respawn/valheim/server-pass`.

---

## To test the MCP in a fresh session

```bash
aws sso login --profile respawn --use-device-code
npx nx build respawn-mcp          # dist/ is gitignored — a fresh clone has none

# The MCP cannot wake a server. Wake one yourself, then scale it back to 0 when done:
aws ecs update-service --cluster respawn-dev-<svc> --service respawn-dev-<svc> \
  --desired-count 1 --profile respawn
# wait for lastStatus=RUNNING and the rcon-control managed agent RUNNING before exec tools
```

The game gets a fresh **public IP on every task start** (no stable DNS — see backlog). Pull
it from the task's ENI: `attachments[0].details[networkInterfaceId]` →
`ec2 describe-network-interfaces … Association.PublicIp`.

Local prerequisites, all present here: `aws`, `script(1)`, `session-manager-plugin`
(`~/.local/bin`). `script` supplies the pty; without it every exec tool fails (see traps).
A stdio driver for the MCP lives at the session scratchpad `drive.mjs`. Client config is in
`apps/respawn-mcp/README.md`.

---

## Backlog

1. **Redeploy a service to confirm `capture_raw`/`sample`/`describe_transport` live.** They
   ship unproven on the exec path. ut99 is the cheapest (no image build). This also proves
   the `--raw` split end-to-end.
2. **A scale/wake tool** would close the chicken-and-egg (MCP can't start what it controls).
   The single most obvious gap; also unblocks self-contained testing.
3. **Stable address.** Task public IP changes on every start — the worst property for a game
   server. Proportionate fix: EventBridge on ECS task-state-change → Lambda → Route53 A
   record. Nearly free. An NLB would cost more than the whole fleet; don't.
4. **Games still needing a transport** (no manifest, protocol not in `rcon.py`): rust
   (WebSocket rcon), 7dtd (telnet), quakelive (idTech3 but rcon differs from classic q3 —
   unconfirmed), valheim (no rcon). Author these with `capture_raw` now that it exists.
   7dtd telnet is the easiest.
5. **ut99 writes** (kick/say/map) live behind the UWeb admin on 5580, a separate HTTP
   transport from the read-only gamespy query port. Would need a `webadmin` protocol in
   `rcon.py`.
6. **doom2 has no queries** — `query` can't report who's on it. A `players` query needs its
   zandronum status parse authored.
7. **Mod commands** — manifests declare none yet (ULX, SourceMod, AMX Mod X). First-class in
   the schema via the `"mod"` field.
8. **Quote-aware `CONTAINER_COMMAND` parse.** `loader.ts parseCommand` splits on whitespace
   ignoring quotes, so `+sv_hostname "Respawn Doom 2"` fractures. Cosmetic.
9. **Graceful shutdown.** The GoldSrc/zandronum engines ignore SIGTERM, so every clean stop
   exits 137 via SIGKILL. Harmless (`explainExit` knows), but a shim would be tidier.
10. **Oversized ut99.** `CPU=512 / MEMORY=1024`; measured ~55 MiB rss / low single-digit CPU
    with a real player. A resize looks safe but the sample is small — re-measure under load.

---

## Traps that cost real time (do not re-introduce)

- **ECS Exec needs a TTY.** `aws ecs execute-command --interactive` tears the session down
  when stdin is not a terminal — the command still runs, but its output never returns and
  the plugin prints `Cannot perform start session: EOF`. Fast commands appear to work; slow
  ones vanish. `exec.ts` wraps its argv in `script(1)` to manufacture a pty. This — not KMS,
  not memory — was the real cause of the EOF two theories chased.
- **Judge container memory by `rss`, never `memory.usage_in_bytes`.** `usage` counts page
  cache, which expands to fill whatever cgroup limit exists, so it reads ~100% at *every*
  limit and justifies nothing. `memory.failcnt` in the millions is cache reclaim, not OOM.
  `container_stats` reports rss/cache/usage separately for exactly this reason.
- **Exit 137 is not OOM here.** The engines ignore SIGTERM, so ECS escalates to SIGKILL and
  every normal scale-to-zero exits 137. Suspect OOM only when `stopCode` shows ECS did not
  initiate the stop.
- **`CPUUtilization` measures the observer too.** It is a *task* metric, so an ECS Exec
  session's own CPU — `container_stats`, every `rcon` call — counts as the game's. Read at
  `resolution=1m` and check whether peaks line up with your own probes before concluding the
  server is CPU-starved. (An earlier "doom2 peaked at 100% CPU" claim was this artifact; the
  game alone tops out near 39% of 0.25 vCPU.)
- **Rapid back-to-back exec sessions drop the SSM control channel** (`TargetNotConnected`),
  and it does not recover on its own — stop the task and let the service replace it. The
  `sample` tool spaces its sessions (3s floor) for exactly this reason.
- **GameSpy `\players\` lists humans only** (verified on ut99): bots never appear, and a
  player drops from the list while dead/respawning. It is a live snapshot, not a roster.
- **UT99 has two passwords.** `UT_ADMINPWD` → in-game admin; `UT_WEBADMINPWD` → the UWeb
  console on 5580. Set only the first and the webadmin keeps the image default `admin/admin`.
  Both now point at the same secret; keep it that way for any new UE1 game.
- **Wrong map name boots but never loads.** hlds logs `map change failed` and idles with no
  map; every `status` then answers `Can't "status", not connected`. Verify map names against
  the game's actual `.bsp` set (`rcon "maps *"`), not the sibling game's.
- **Shared stack must synthesize ALL service stacks every run** — CDK only emits a repo's
  cross-stack export when a stack references it.
- **Sidecar Dockerfiles use paths relative to the sidecar dir** (`COPY rcon.py`); CDK builds
  them via `fromAsset(sidecarDir)`. Game-image Dockerfiles are the opposite: repo-root.
- **pnpm non-TTY**: `.npmrc` has `confirm-modules-purge=false`. Never `CI=true` (wipes
  `node_modules`). Run nx targets directly if `pnpm <script>` aborts.
- **Don't `2>/dev/null` an existence check.** An expired SSO token then reads as "the thing
  doesn't exist" — it falsely reported secrets missing this session.

Full standards in `CLAUDE.md`; architecture in `README.md`; MCP setup + security model in
`apps/respawn-mcp/README.md`.
