# Respawn — Session Handoff

Where to pick up after a context reset. Repo is `@respawn/source` (AWS Fargate game
servers, config-driven via `apps/<name>/.env`).

AWS account **847378615943**, region **us-east-1**, profile **respawn**.
Log in with `aws sso login --profile respawn --use-device-code` — the plain form opens
your default browser, which is signed into the *work* Identity Center; `--use-device-code`
prints a URL + code you paste into the browser signed into the personal `d-9066000aae`
portal. The token is short-lived and expires mid-session; re-run when a call reports
`Token has expired`.

**Branch `feat/ut99-uweb-variants` (off `main` `710a64a`), NOT pushed.** Six commits done
(`a1c2b9b` → the tsdown conversion). Working tree clean. All servers scaled to 0 — nothing
billing.

---

## ⚠️ RESUME HERE — this session's work (2026-07-10)

Four big pieces landed on `feat/ut99-uweb-variants`. The tsdown conversion (the fourth) is
now **done and committed** — the refactor arc is complete. Read this before touching anything.

### Committed (5 commits, verified green each time)

1. `a1c2b9b` **UT99 uweb write transport + typed modData + per-project variants.**
   - `rcon.py` gained a `uweb` HTTP transport (POST to the UWeb admin console on 5580) so
     UT99 admin commands (`servertravel`, `kick`, `AddBots`, `say`, …) run through the MCP.
     Reads stay on read-only `gamespy`; a `--write` flag routes writes to `uweb`. Verb is
     **`servertravel`, NOT `switchlevel`** (verified against the real image).
   - Manifest schema is now generic: `makeManifestSchema<T>` with typed `modData`, validated
     per-service via `apps/respawn-mcp/src/mod-data.ts`.
   - **Variants:** a project can hold `apps/<name>/variants/<variant>/` (own `.env`,
     `Dockerfile`, `rcon-manifest.json`) layered over a base `apps/<name>/.env`. Identity is
     author-controlled via `SERVICE_NAME`. `apps/ut99/` became `variants/modded` (keeps bare
     `ut99`, roemer image) + `variants/vanilla` (`ut99-vanilla`, bymatej stock image). Only
     `stack-discovery.ts` + `generate-manifests.mjs` decode the layout.

2. `e47c3c6` `bb89552` `716e747` **Extract `@respawn/core` (`libs/core`).** The shared engine:
   config loader, discovery, **one AWS-CLI runner** (`src/aws/exec.ts` — replaced 5 spawn
   wrappers), **one naming module** (`src/naming.ts` — cluster/log/stack/ECR names + a
   hyphen-safe parser), and the **action cores** (`src/actions/` — deploy/diff/synth/push/
   updates headless; `destroy`/`status` split from their UI). `apps/respawn` is now the
   CDK-synth app only.

3. `5a40764` **`apps/cli` — dedicated clack CLI over core.** One `ACTION_HANDLERS` table
   (`src/handlers.ts`) for both interactive (`src/menu.ts`) and batch (`src/batch.ts`);
   `src/args.ts` parses argv. **The nx executor + `apps/respawn/src/{cli,executors}` are
   deleted.** Root `respawn:*` scripts run `tsx apps/cli/src/index.ts`.

4. `474b765` `c2c0217` **MCP = superset.** MCP consumes core's AWS runner + naming (dedup),
   and gained lifecycle tools `synth`/`diff`/`check_updates` (read) + `deploy`/`push`/
   `destroy` (gated by `RESPAWN_ALLOW_DEPLOYS`; `destroy` also needs `confirm=<name>`).
   Services resolved via core's filesystem discovery (`RESPAWN_WORKSPACE_ROOT`, default cwd).

### DONE — whole workspace converted to tsdown build-to-dist (committed)

**Why it existed:** a `node`-run binary (the MCP, `node dist/index.mjs`) **cannot consume the
workspace's raw-TS package `exports`** (`"." → src/index.ts`); only tsx-run apps can. Phase 3
left a stopgap — `apps/respawn-mcp/build.mjs` (esbuild bundle + `createRequire` banner). That
hack is now **gone**.

**What shipped (spartan-toolkit pattern):**
- **tsdown** is a root devDep. `shared-types`, `docker-utils`, `core` each have a
  `tsdown.config.ts` (esm/node24/`outDir dist`/`dts:false`, deps externalized), a
  `package.json` `exports: { ".": { "development": "./src/index.ts", "types": "./src/index.ts", "import": "./dist/index.mjs" } }` + `main:./dist/index.mjs`,
  and a `project.json` `build` target (`npx tsdown`, `cwd:{projectRoot}`, outputs `dist`,
  `dependsOn ["^build"]`) overriding the `@nx/js/typescript` inferred one.
- **`respawn-mcp` + `cli`** each got a `tsdown.config.ts` with `deps.alwaysBundle:[/^@respawn\//]`
  — the whole `@respawn/*` graph (and its CJS transitive `dotenv`) is bundled inline; only each
  app's own registry deps stay external (mcp: `@modelcontextprotocol/sdk`,`zod`; cli:
  `@clack/prompts`,`chalk`). `bin`/`main → ./dist/index.mjs`. The entry files carry a single
  `#!/usr/bin/env node` shebang (rolldown preserves it — **no banner**). `build.mjs`, the
  `esbuild` devDep, and both apps' orphaned `tsconfig.build.json` are deleted.
- **Zero-build dev preserved:** `pnpm respawn*` scripts and `apps/respawn/cdk.json` run
  `tsx --conditions development …`, so the `development` export condition resolves libs to
  `src` (verified: deleting `libs/core/dist` doesn't break `pnpm respawn`). **tsx honors
  `--conditions development`** — confirmed empirically. Plain `node`/rolldown pick `import → dist`.

**Verified:** `nx run-many -t typecheck lint test build` green for all 6 projects; bundled
`node apps/respawn-mcp/dist/index.mjs` lists all 19 tools (incl. deploy/destroy/synth); `cdk
list` stack names byte-stable.

**Gotchas baked in (don't rediscover / don't undo):**
- One shebang only. Source `#!/usr/bin/env node` + a banner shebang collide → syntax error.
  tsdown/rolldown preserves the source shebang; there is no banner anymore.
- esbuild ESM-bundling a CJS dep (dotenv) threw “Dynamic require of fs”. **tsdown/rolldown
  handles the CJS interop** — that was the whole reason to switch.
- **eslint must ignore `dist/`** — `eslint.config.mjs` has `{ ignores: ['**/dist/**','**/node_modules/**'] }`. Keep it.
- The `development` exports condition MUST list `types:./src/index.ts` before `import`, else a
  plain `tsc`/consumer resolves types to `dist` and needs a dts build first (we emit no dts).
- `-e` one-liners can't resolve `@respawn/*` from the repo root (root package doesn't declare
  them) — test the real app entry, not `tsx -e`.
- `nx.json` has `sync.applyChanges: true` (auto-maintains tsconfig refs).
- Cross-package imports resolve via pnpm-workspace `exports` (NO tsconfig `paths`).

### Verify commands
```bash
npx nx run-many -t typecheck lint test build      # all 6 projects green
npx nx build respawn-mcp && node apps/respawn-mcp/dist/index.mjs  # must list tools incl. deploy/destroy/synth
# MCP stdio tools/list + a gated deploy(ut99) probe: scratchpad mcp-probe.mjs / mcp-call.mjs
cd apps/respawn && CDK_DEFAULT_ACCOUNT=000000000000 npx cdk list -c environment=dev \
  -c workspaceRoot=$PWD/../.. -c services=ut99,ut99-vanilla -c imageTag=t   # stack names byte-stable
```
Local UT99 image checks used `docker run roemer/ut99-server` / `bymatej/ut99-server` (webadmin
`admin/admin` on 5580, gamespy on 7778). Findings in the session scratchpad `uweb-findings.md`.

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
