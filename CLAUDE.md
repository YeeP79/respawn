# Claude Code Development Standards

**Project:** `@respawn/source`
**Description:** Deploy and manage retro game servers on AWS Fargate. Config-driven via `.env` files — add a server by dropping a `Dockerfile`, `.env`, and `project.json` into `apps/`.

---

## Commands

```bash
pnpm typecheck   # Type checking
pnpm lint        # Linting
pnpm test        # Tests (vitest, 47 tests)
pnpm build       # Build
```

Without a TTY, `pnpm <script>` can abort on `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
(it wants to confirm a `node_modules` purge). Run the target directly instead —
never set `CI=true` to force it, which silently wipes `node_modules`:

```bash
npx nx run-many -t typecheck        # same target, no dep-status check
```

**Deployment CLI** (interactive Clack menu — deploy, diff, synth, status, destroy, secrets):

```bash
pnpm respawn                        # requires: aws sso login --profile respawn
pnpm respawn:deploy                 # non-interactive batch (see gotcha below)
pnpm graph                          # nx project graph
```

---

## Type Safety

**No `any`.** Use `unknown` + validation, generics, or proper interfaces. The codebase
has zero `any` outside tests — keep it that way.

---

## Code Style

- **`export function` declarations** for module-level functions (not arrow consts) — matches every file in `apps/respawn/src`
- **Explicit return types** on exported functions
- **`.js` extensions on relative imports** — this is ESM; `import { logger } from './logger.js'` even though the source is `.ts`
- **Imports:** node builtins → external → internal (types first in each group)
- **Comments explain _why_, not _what_.** Existing code documents non-obvious constraints (why `|` and not `#`, why a background watcher). Do not add `@param`/`@returns` boilerplate; no file uses it.

**Nx module boundaries** (enforced by eslint, `eslint.config.mjs`): `type:app` may only
depend on `type:lib`. Tag every new project in its `project.json`.

---

## Architecture

SOLID applies; the two rules this codebase actually leans on are **dependency inversion**
(inject clients, never instantiate infrastructure inline) and **single responsibility**.

**Thin stacks, fat constructs.** Stacks are ~20 lines of construct instantiation; logic
lives in constructs. Never hardcode ports, sizes, counts, or names in stack code — they
come from `.env` via `loader.ts`.

---

## Testing

Priority: defensive tests → logic coverage → metrics. `loader.spec.ts` is the model —
every parse/validate branch has a rejection test, not just a happy path.

**Coverage:** no threshold is configured in vitest. Any new config parsing or validation
logic must ship with specs; that is where the bugs are.

---

## Project Patterns

**Adding a game server.** Four files in `apps/<name>/`:

| File | Purpose |
|------|---------|
| `.env` | Real config. **Gitignored.** Nothing deploys without it |
| `.env.example` | Tracked template. Keep in sync with `.env` |
| `Dockerfile` | Even when `IMAGE_URI` is set (unused, but discovery-friendly) |
| `project.json` | `{"name","projectType":"application","tags":["type:app","lang:dockerfile"]}` |

**Two image strategies.** Prefer the first:

1. **`IMAGE_URI` set** — upstream image, no build. Works when the image reads its
   config from env vars (`cs2`, `l4d2`, `tf2`).
2. **`IMAGE_URI` unset** — build `Dockerfile`, push to ECR. Required when the upstream
   image is config-*file* driven, or forwards args without `eval` so a secret can never
   be referenced on the command line. Add a `respawn-init.sh` shim that writes the game's
   config file from injected env vars, then `exec`s the upstream entrypoint.
   See `apps/gmod`, `apps/css` (LinuxGSM), `apps/cs16` (HLDS).

**Secrets.** `SECRET_REFS` → ECS `secrets:` (never `environment:`). Set values with the
`Secrets` CLI action, which writes to Secrets Manager / SSM over stdin. Naming:
`respawn/<service>/<name>` (sm), `/respawn/<service>/<name>` (ssm).
Full spec: `artifacts/AGENT_PROMPT.md` §7.

---

## Gotchas

### A service without `.env` is silently skipped

`stack-discovery.ts` skips any `apps/*` directory lacking `.env` — no error, it just
never appears in the CLI. If your new server "isn't showing up", this is why. (`.env` is
gitignored, so a fresh clone has none: `cp .env.example .env` per service.)

### Secrets must never touch `CONTAINER_COMMAND` or `GAME_ENV_*`

Both land in the ECS task definition in plaintext, readable by anyone with ECS read
access, and `CONTAINER_COMMAND` is additionally visible in `ps` inside the container.

```bash
# Wrong — plaintext in the task definition
CONTAINER_COMMAND=+rcon_password hunter2
GAME_ENV_RCON_PASSWORD=hunter2

# Correct — injected as an ECS secret, written to the game's cfg by respawn-init.sh
SECRET_REFS=RCON_PASSWORD=sm:respawn/cs16/rcon
```

`loader.ts` enforces this: a credential-looking name in either place is rejected at config
load. The heuristic matches `PASSWORD`/`TOKEN`/`PWD`/`GSLT` but deliberately not `RCON`, so
`RUST_RCON_PORT` still loads. If the image takes config only on the command line, add a
`respawn-init.sh` shim (see `apps/cs16`, `apps/tfc`).

### Every `SECRET_REFS` entry must exist before the first deploy

ECS resolves secrets *before* starting the container, and CDK only synthesizes an ARN —
it never checks existence. A referenced-but-absent secret fails the task with
`ResourceInitializationError`. Making a secret optional means **deleting its entry**, not
leaving the store empty. `deploy()` preflights this now, so it fails fast with a clear
message rather than after a full deploy — run the `Secrets` CLI action first.

### Anything the server cannot run without goes in `REQUIRED_ENV_VARS`

A GSLT, an admin Steam64 ID, an rcon password. Checked by `preflight()` in `deploy.ts`
against placeholders (`changeme`, `todo`, `<your-id>`, empty) as well as absence.

This is checked at **deploy** time, not load time, and that is deliberate:
`stack-discovery.ts` catches a config error and merely *warns*, so a service that throws
during load silently disappears from the CLI menu. A missing requirement must be loud.

### The `jsonKey` delimiter is `|`, not `#`

`dotenv` strips `#...` from a value as an inline comment, so `sm:secret#key` silently
truncates. Use `SECRET_REFS=DB=sm:respawn/app/db|password`.

### Docker build context is the repo root

`deploy.ts` passes `workspaceRoot` as the context, so `COPY` paths are repo-relative:

```dockerfile
COPY apps/css/respawn-init.sh /app/respawn-init.sh   # not ./respawn-init.sh
```

Also check the base image's `USER` before adding `RUN chmod +x` — `jives/hlds` runs as
`steam` and cannot chmod a root-owned `COPY`. Invoke via `ENTRYPOINT ["/bin/sh", ...]` instead.

### `pnpm respawn:*` scripts hardcode a `--service` list

The batch scripts in `package.json` name each service explicitly — currently all 14. It is
easy to forget when adding a server, and a missing name is skipped silently. Add yours, or
use the interactive `pnpm respawn` menu, which discovers them properly.

### `netstat` idle detection is blind to UDP games

UDP game servers hand every client a single unconnected socket (verified against hlds:
`/proc/net/udp` has exactly one entry, empty server or full), so `ss -tun state established`
reports zero however many people are playing. `netstat` is correct **only for TCP games**.

Ask the game instead. Each service configures its own probe in `.env`; the sidecar knows
nothing game-specific:

| `IDLE_CHECK_METHOD` | Games |
|---------------------|-------|
| `a2s` | GoldSrc/Source + Steam-hosted (cs16, css, cs2, gmod, tfc, tf2, l4d2, rust, 7dtd) |
| `q3` | idTech3 `getstatus` (quake3, quakelive) |
| `gamespy` | Unreal Engine 1 `\info\` (ut99) |
| `zandronum` | Zandronum launcher protocol, Huffman-coded (doom2) |
| `http` | poll `IDLE_STATUS_ENDPOINT` (valheim) |

Set `IDLE_QUERY_PORT` when the game answers somewhere other than its game port
(rust: 28017, ut99: game port + 1).

**A failed probe returns -1 = unknown, never 0.** The watchdog holds the idle timer rather
than scale a populated server to zero on one dropped packet, so a wrong protocol or port
costs money — it never kills a live match. Rate limiting counts as unknown too: Zandronum's
`sv_queryignoretime` reply must never read as "empty".

The Zandronum Huffman tree in `players.py` is lifted verbatim from
`zandronum/src/huffman/huffman.cpp`. Its codec emits a `0xff` prefix meaning "the rest is
unencoded" when coding would expand the data, which is why the probe can send a request
without implementing the encoder.

### Admin ports go in `INTERNAL_PORTS`, never `ADDITIONAL_PORTS`

The security group opens the primary port + every `ADDITIONAL_PORTS` entry to
`0.0.0.0/0`. RCON, web panels and telnet must go in `INTERNAL_PORTS` instead: they
get a task port mapping (so the game binds and the rcon-control sidecar reaches
them over loopback) but no public ingress. Putting an admin port in
`ADDITIONAL_PORTS` exposes it to the internet.

### Image tags are content hashes, never git SHAs

`sha-<12 hex>` over the Dockerfile + every `COPY`ed file + the `FROM` base's resolved digest
(`utils/image-hash.ts`). `deploy` skips build+push when that tag is already in ECR.

A git SHA is wrong in both directions: `git rev-parse HEAD` ignores the working tree, so an
uncommitted Dockerfile/shim edit would reuse a stale image; and an unrelated commit changes the
SHA, forcing a pointless multi-hundred-MB rebuild. The base digest is in the hash so an upstream
republish of a mutable tag (`jives/hlds:cstrike`) forces a rebuild.

Bump the `respawn-image-v1` salt in `computeImageTag` to force a fleet-wide rebuild.

### CPU and memory must be a valid Fargate pair

`loader.ts` validates against the AWS matrix and fails fast. `CPU=256` allows 512–2048 MiB;
`CPU=1024` allows 2048–8192 MiB.

---

## Setup

```bash
asdf install                        # node 24.13.0, python 3.14.2 (.tool-versions)
pnpm install
aws sso login --profile respawn     # account 847378615943, us-east-1
```

Docker is required for any service that builds its own image.

---

## Pre-Commit

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```
