# Respawn — Session Handoff

Snapshot for picking work back up after a context reset. Repo is `@respawn/source`
(AWS Fargate game servers, config-driven via `apps/<name>/.env`).

AWS account **847378615943**, region **us-east-1**, profile **respawn**
(`aws sso login --profile respawn`).

Work is on branch **`fix/exec-pty-and-manifest-schema`**, pushed to origin, **not merged**.
`main` is at `ab73d14`. Four commits ahead. Clean tree.

**All servers are scaled to 0. Nothing is billing.**

---

## What the MCP can and cannot do

It **controls and observes** servers. It **cannot create, deploy, scale, or wake** them —
there is no such tool, by omission not by accident. Deploying is the CLI's job
(`pnpm respawn`). This matters because `rcon`, `run_command`, `set_cvar`, `query` and
`container_stats` all need a *running task*, and the MCP cannot produce one.

| Tool | Needs a running task? |
|------|----------------------|
| `list_servers` | shows only running ones |
| `get_server_options` | no (manifest; live maps if up) |
| `server_health` | **no** — answers "why is nothing running" |
| `server_metrics` | no (CloudWatch history) |
| `server_logs` | no (CloudWatch history) |
| `run_command`, `set_cvar`, `query`, `rcon` | yes |
| `container_stats` | yes (one ECS Exec session per call) |

---

## Proven end-to-end

The full chain **MCP → ECS Exec → rcon-control sidecar → game** works, verified live
against doom2: `rcon` read `sv_gravity`, `run_command say` broadcast to the server, and
`set_cvar` drove gravity 800 → 900 → 800 with a verifying re-read. All four monitoring
tools were exercised too, three of them against a scaled-to-zero service.

**The EOF was a missing TTY, not KMS.** `aws ecs execute-command --interactive` tears the
session down at once when stdin is not a terminal; the remote command still runs to
completion but its output never returns. Minimal repro, no python involved:
`sh -c 'echo BEG; sleep 2; echo DONE'` → `BEG`, then EOF. `execRcon` now wraps its argv in
`script(1)` to manufacture a pty. Commit `f529af9` had dropped the customer-managed KMS
exec key chasing this same EOF — that was a misdiagnosis, and KMS can be reinstated on its
own merits whenever you want.

---

## To test the MCP in a fresh session

```bash
aws sso login --profile respawn
npx nx build respawn-mcp          # dist/ is gitignored — a fresh clone has none

# The MCP cannot wake a server. Do it yourself:
aws ecs update-service --cluster respawn-dev-doom2 --service respawn-dev-doom2 \
  --desired-count 1 --profile respawn
# ...wait for lastStatus=RUNNING and the rcon-control managed agent to be RUNNING

# Then drive it. Client config lives in apps/respawn-mcp/README.md.
# Scale back to 0 when done.
```

Local prerequisites, all present on this machine: `aws`, `script(1)`, and
`session-manager-plugin` (at `~/.local/bin`). `script` is what supplies the pty; without
it every exec-backed tool fails with the EOF above.

---

## Deployed inventory (all at desiredCount 0)

| Stack | rcon-control | ECS Exec | Notes |
|-------|--------------|----------|-------|
| `respawn-dev-shared` | — | — | VPC + ECR repos for cs16, css, doom2, gmod, tfc |
| `respawn-dev-doom2` | deployed | **enabled** | Zandronum, freedoom baked in. The only MCP-controllable server. Still carries `memoryLimitMiB: 192`; the branch lowers it to 128, so it needs a redeploy to converge. |
| `respawn-dev-cs16` | **never built** | **disabled** | `.env` says `ENABLE_RCON_CONTROL=true`, but the deployed service predates it. Needs one deploy before the MCP can touch it. |

`cs16` and `tfc` both have a pending image rebuild: their Dockerfiles now drop the empty
`/temp/mods` and `/temp/config` that made the upstream `jives/hlds` entrypoint log an rsync
error on every boot. The image tag is a content hash, so the next deploy of either rebuilds.

Secrets in AWS (all created): rcon for cs16, css, tfc, l4d2, tf2, gmod, cs2, doom2;
`respawn/rust/rcon-password`, `respawn/ut99/admin-pwd`, `respawn/valheim/server-pass`.

---

## Backlog

1. **Merge the branch.** Four commits: the pty fix, the manifest schema/Nx-cache fixes, the
   monitoring tools, and the sidecar memory sizing.
2. **A scale/wake tool** would close the chicken-and-egg above and make the MCP
   self-sufficient. It is the single most obvious gap.
3. **`doom2` declares zero queries**, so `query` cannot report who is playing. Of the 14
   games, 9 have a manifest and only **2** (cs16, doom2) set `ENABLE_RCON_CONTROL=true`.
   Game-level monitoring is a data problem, not a tools problem.
4. **Games with no sidecar transport** (no manifest, protocol not in `rcon.py`): rust
   (WebSocket rcon), 7dtd (telnet), ut99 (web admin), quakelive (idTech3, but its rcon
   differs from classic q3 — unconfirmed), valheim (no rcon). 7dtd telnet is the easiest.
5. **Mod commands** — manifests declare none yet (ULX, SourceMod, AMX Mod X). First-class
   in the schema via the `"mod"` field.
6. **Known cosmetic bug**: `CONTAINER_COMMAND` is split on whitespace without respecting
   quotes, so `+sv_hostname "Respawn Doom 2"` fractures and the hostname arrives as
   `"Respawn`. Fix = quote-aware parse in `loader.ts` `parseCommand`.
7. **doom2's CPU is fine — an earlier "peaked at 100%" claim here was wrong.** That peak
   was the observer: `CPUUtilization` is a *task* metric, so the CPU burned by ECS Exec
   sessions lands in it, and every 100% minute coincides with back-to-back `container_stats`
   and `rcon` probes. At 1-minute resolution over a task with nobody exec'ing into it, the
   game tops out near 39% of 0.25 vCPU. `CPU=512` is not indicated. Re-measure under real
   player load with `server_metrics resolution=1m` before changing anything.
8. **The game ignores SIGTERM** — every clean stop exits 137 via SIGKILL. Harmless today
   (and `explainExit` knows), but a graceful-shutdown shim would be tidier.

---

## Traps that cost real time (do not re-introduce)

- **Judge container memory by `rss`, never `memory.usage_in_bytes`.** `usage` counts page
  cache, which expands to fill whatever cgroup limit exists, so it reads near-100% at
  *every* limit and justifies nothing. A `memory.failcnt` in the millions is cache reclaim,
  not OOM. Both misled a diagnosis here. `container_stats` reports rss, cache and usage
  separately for exactly this reason.
- **Exit code 137 is not OOM here.** Zandronum and GoldSrc ignore SIGTERM, so ECS escalates
  to SIGKILL and every normal scale-to-zero exits 137. Only suspect OOM when `stopCode`
  shows ECS did not initiate the stop.
- **`CPUUtilization` measures the observer too.** It is a *task* metric, so an ECS Exec
  session's own CPU — `container_stats`, every `rcon` call — is counted as the game's. Read
  it at `resolution=1m` and check whether the peaks line up with your own probes before
  concluding the server is CPU-starved. An avg/peak summary hides this completely; that is
  why `server_metrics` returns the timeline.
- **ECS Exec needs a TTY.** See above. Without one, fast commands appear to work and slow
  ones vanish — the worst possible failure mode.
- **Rapid back-to-back exec sessions** can drop the SSM control channel
  (`TargetNotConnected`), and it does not recover on its own; stop the task and let the
  service replace it.
- **Shared stack must synthesize ALL service stacks every run**, not just the deployed one —
  CDK only emits a repo's cross-stack export when a stack references it.
- **Sidecar Dockerfiles use paths relative to the sidecar dir** (`COPY rcon.py`), because
  CDK builds them via `fromAsset(sidecarDir)`. Game-image Dockerfiles are the opposite:
  repo-root context.
- **pnpm non-TTY**: `.npmrc` has `confirm-modules-purge=false`. Never `CI=true` (wipes
  `node_modules`). Run nx targets directly if `pnpm <script>` aborts.

Full standards in `CLAUDE.md`; architecture in `README.md`; MCP setup and security model in
`apps/respawn-mcp/README.md`.
