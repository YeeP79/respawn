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
never appears in the CLI. `apps/gmod` and `apps/cs2` are committed in exactly this state.
If your new server "isn't showing up", this is why.

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

`apps/tfc`, `apps/l4d2`, `apps/rust`, and `apps/tf2` still violate this with `changeme`
placeholders. Do not copy them.

### Every `SECRET_REFS` entry must exist before the first deploy

ECS resolves secrets *before* starting the container, and CDK only synthesizes an ARN —
it never checks existence. A referenced-but-absent secret fails the task with
`ResourceInitializationError`. Making a secret optional means **deleting its entry**, not
leaving the store empty. Run the `Secrets` CLI action first.

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

The batch scripts in `package.json` name each service explicitly, and the list has drifted:
`cs16`, `cs2`, `css`, and `gmod` are all missing. Add new servers there, or use the
interactive `pnpm respawn` menu, which discovers them properly.

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
