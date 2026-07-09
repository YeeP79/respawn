# Respawn — Session Handoff

Snapshot for picking work back up after a context reset. Repo is `@respawn/source`
(AWS Fargate game servers, config-driven via `apps/<name>/.env`).

`main` is at **`f529af9`**, clean tree, pushed to origin. AWS account **847378615943**,
region **us-east-1**, profile **respawn** (`aws sso login --profile respawn`).

---

## ⚠️ Do this first

### 1. doom2's deployed exec config is STALE (the one loose end)
The code fix that removes the customer KMS exec key is **committed and pushed**
(`f529af9`), but doom2 **in AWS was never redeployed** with it. So the live doom2
still carries the broken KMS session config. Until it's redeployed, ECS Exec into
doom2 fails with `Cannot perform start session: EOF`.

```bash
# Redeploy to apply the KMS removal (images unchanged → fast, cluster-config update):
npx nx run respawn:cdk --nonInteractive --action=deploy --profile=respawn \
  --environment=dev --service=doom2 --requireApproval=never
```
This restarts the doom2 task (new public IP). It was scaled to 0 at end of session,
so deploy brings it back up.

### 2. Servers are OFF (scaled to 0) — billing stopped
`respawn-dev-cs16` and `respawn-dev-doom2` are both `desiredCount=0`. Bring one back
with the deploy above, or `aws ecs update-service … --desired-count 1`.

---

## The goal we were mid-flight on

**Prove the MCP → ECS Exec → sidecar → game loop end-to-end on doom2.** The
`session-manager-plugin` is now installed at `~/.local/bin/session-manager-plugin`
(v1.2.835.0), which was the missing piece. After the doom2 redeploy above, the
next action is:

```bash
# Drive the real MCP against live doom2 (build first: npx nx build respawn-mcp):
#   list_servers  → should show doom2
#   rcon(service=doom2, command="get sv_gravity")  → should return 800
# Or raw exec to sanity-check the channel:
TASK=$(aws ecs list-tasks --cluster respawn-dev-doom2 --profile respawn --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster respawn-dev-doom2 --task "$TASK" \
  --container rcon-control --interactive \
  --command "python3 /usr/local/bin/rcon.py --command 'get sv_gravity'" --profile respawn
```
If exec still EOFs after the redeploy, the KMS theory was wrong — investigate the
ssmmessages data channel / agent next (all other prereqs were verified: agent
RUNNING, public IP, IAM, caller can GenerateDataKey).

---

## What exists and is proven

**MCP server** (`apps/respawn-mcp`, TypeScript, built JS at `dist/index.js`):
- Manifest-driven — NO game-specific logic in the MCP. Tools: `list_servers`,
  `get_server_options`, `run_command`, `query`, `set_cvar`, `rcon`.
- Per-game manifests in `apps/<name>/rcon-manifest.json`, bundled at build by
  `generate-manifests.mjs`. Present for **9 games**: cs16, cs2, css, doom2, gmod,
  l4d2, quake3, tf2, tfc.
- Discovers running servers from AWS (works installed anywhere). Setup +
  security docs in `apps/respawn-mcp/README.md`.

**rcon-control sidecar** (`apps/respawn/sidecar/rcon-control/`):
- ECS-Exec-only, reaches the game over loopback; rcon password never leaves the
  task. `rcon.py` speaks **4 protocols**: `goldsrc`, `source`, `q3`, `zandronum`.
- Enabled per-service via `ENABLE_RCON_CONTROL=true` + `RCON_PROTOCOL` + `RCON_PORT`.
- Verified running in AWS on doom2 (first successful sidecar deploy). Verified
  live with `rcon.py` directly: goldsrc (cs16/tfc) and zandronum (doom2) do real
  map/cvar changes.

**Verification status of the control path:**
- rcon protocols (goldsrc, zandronum): ✅ verified live against real game containers.
- sidecar image + deploy: ✅ verified running in AWS (doom2).
- **MCP → exec → sidecar → game: ❌ NOT yet proven** — blocked on the doom2
  redeploy (item 1) then the plugin test. This is the single open thread.

---

## Deployed inventory (all scaled to 0)

| Stack | Notes |
|-------|-------|
| `respawn-dev-shared` | VPC + ECR repos for cs16, css, doom2, gmod, tfc |
| `respawn-dev-cs16` | GoldSrc, rcon-control configured. **Its sidecar has NEVER been redeployed** since rcon-control was added — deploying cs16 will build its sidecar for the first time (the Dockerfile COPY bug that blocked this is fixed in `f529af9`). |
| `respawn-dev-doom2` | Zandronum, freedoom baked in, sidecar deployed. Needs the KMS-removal redeploy. |

Secrets in AWS (all created): rcon for cs16, css, tfc, l4d2, tf2, gmod, cs2, doom2;
`respawn/rust/rcon-password`, `respawn/ut99/admin-pwd`, `respawn/valheim/server-pass`.

---

## Backlog / next work

1. **Redeploy doom2, test MCP end-to-end** (items above). Then wire the MCP into an
   MCP client (config in `apps/respawn-mcp/README.md`).
2. **Games still needing a sidecar transport** (no manifest yet, protocol not in
   `rcon.py`): rust (WebSocket rcon), 7dtd (telnet), ut99 (web admin),
   quakelive (idTech3 but its rcon differs from classic q3 — unconfirmed),
   valheim (no rcon). 7dtd telnet is the next-easiest.
3. **Mod commands** — manifests have no mod commands yet (ULX, SourceMod, AMX Mod X).
   They're first-class in the schema (`"mod"` field); add per the mods actually run.
4. **Known cosmetic bug**: `CONTAINER_COMMAND` is split on whitespace without
   respecting quotes, so `+sv_hostname "Respawn Doom 2"` fractures into tokens and
   the hostname comes through as `"Respawn`. Affects any quoted multi-word value in
   `CONTAINER_COMMAND` (seen in doom2 logs). Fix = quote-aware parse in `loader.ts`
   `parseCommand`.
5. **KMS on exec** — dropped because it broke the session (EOF). To revisit: give
   the exec log group its own KMS key and diagnose the session-key handshake, or
   leave it (channel is already TLS + IAM + audit-logged).
6. **Other pre-existing backlog** (from earlier sessions): 3 games still lack a
   `.env` and are undeployable (cs2, gmod, valheim have `.env` now — recheck);
   `tf2`/`l4d2`/`rust`/`ut99` had `changeme` placeholders that were migrated to
   secrets. Verify with `pnpm respawn` menu discovery.

---

## Gotchas that bit us this session (all fixed, don't re-introduce)

- **Shared stack must synthesize ALL service stacks every run**, not just the
  deployed one — CDK only emits a repo's cross-stack export when a stack references
  it, and a missing export that another deployed stack imports makes CFN roll back.
  Fixed in `app.ts`; deploy selectively via the `stacks` arg.
- **Sidecar Dockerfiles use paths relative to the sidecar dir** (`COPY rcon.py`),
  NOT repo-root — CDK builds them via `fromAsset(sidecarDir)`. (Game-image
  Dockerfiles are the opposite: repo-root context.)
- **pnpm non-TTY**: `.npmrc` has `confirm-modules-purge=false`. Never `CI=true`
  (wipes node_modules). Run nx targets directly if `pnpm <script>` aborts.
- **Wad/asset downloads** were blocked from the host but worked from inside a
  container (`docker run alpine … curl`). AWS S3 downloads worked from host.

Full standards + more gotchas in `CLAUDE.md`; architecture in `README.md`.
