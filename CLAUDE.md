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

**Deployment CLI** (interactive Clack menu — deploy, diff, synth, status, scale, destroy, secrets):

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

**Adding a game server.** Five files in `apps/<name>/`:

| File | Purpose |
|------|---------|
| `.env` | Real config. **Gitignored.** Nothing deploys without it |
| `.env.example` | Tracked template. Keep in sync with `.env` |
| `Dockerfile` | Even when `IMAGE_URI` is set (unused, but discovery-friendly) |
| `project.json` | `{"name","projectType":"application","tags":["type:app","lang:dockerfile"]}` |
| `rcon-manifest.json` | The MCP's entire control surface for the game |

Without `rcon-manifest.json` the server deploys and runs but cannot be *driven*: the MCP
has no commands, queries or cvars for it, so there is no map change, no player list, no
settings. It is data, not code — the MCP runs what it declares and contains no
game-specific logic — so a new game is a manifest, not a code change. Run
`node apps/respawn-mcp/generate-manifests.mjs` after editing one; the bundle it writes is
gitignored and rebuilt, and it validates the manifest as a side effect.

**Env files layer, lowest precedence first.** A service does *not* declare the AWS target:

| Layer | Holds |
|-------|-------|
| `.env.defaults` (workspace root) | Fleet-wide: `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_PROFILE` |
| `apps/<project>/.env` | Shared across a project's variants |
| `apps/<...>/<service>/.env` | The service itself — always wins |

Declaring the AWS target once is the point: sixteen copies drift, and one stale
`AWS_ACCOUNT_ID` aims a deploy at the wrong account. Re-declare a key in a service's
own `.env` only to put **that** service somewhere else — `apps/ut99/variants/modded`
does exactly this. `deploy` preflights the declared account against
`sts get-caller-identity` and refuses on a mismatch, so a wrong target fails before
anything is created rather than silently succeeding in the wrong place.

**Variants (one project, multiple builds).** A project can offer several builds — e.g.
different mod sets — that deploy independently. Add a `variants/` dir; each
`apps/<project>/variants/<variant>/` holds its own `.env`, `.env.example`, `Dockerfile`,
and `rcon-manifest.json`, layered over a shared base `apps/<project>/.env` (the overlay
wins on a key collision — put common knobs like ports/CPU in the base, deltas in the
variant; the AWS target comes from `.env.defaults` above). Identity is author-controlled via each variant's `SERVICE_NAME`: the canonical
build keeps the bare project name (`ut99`), others get a suffix (`ut99-vanilla`). A project
with a `variants/` dir is represented **only** by its variants — the project dir itself is
not a service. See `apps/ut99` (`modded` = roemer image; `vanilla` = bymatej image). Only
discovery (`stack-discovery.ts`) and the manifest generator decode this layout; every other
consumer reads discovery output, so a variant is a first-class service everywhere else.

**Two image strategies.** Prefer the first:

1. **`IMAGE_URI` set** — upstream image, no build. Works when the image reads its
   config from env vars (`cs2`, `l4d2`, `tf2`).
2. **`IMAGE_URI` unset** — build `Dockerfile`, push to ECR. Required when the upstream
   image is config-*file* driven, or forwards args without `eval` so a secret can never
   be referenced on the command line. Add a `respawn-init.sh` shim that writes the game's
   config file from injected env vars, then `exec`s the upstream entrypoint.
   See `apps/gmod`, `apps/css` (LinuxGSM), `apps/cs16` (HLDS).

   A shim is also the only durable home for a setting the image exposes no env var for.
   `apps/ut99/variants/modded` is that case: it is `FROM` the upstream image and edits two
   ini keys the image never surfaces. An rcon `set` is not an alternative — UE1 `set`
   writes the in-memory class default, which dies with the task.

**`UPDATE_CHECK` must match the image strategy**, and `loader.ts` refuses the mismatch:
`image` requires `IMAGE_URI`, `build` requires its absence. Switching a service between
strategies means changing both, and because `UPDATE_CHECK` is usually declared in a
project's shared `.env`, a variant that builds locally while its siblings do not has to
override it (see `apps/ut99/variants/modded`).

**Secrets.** `SECRET_REFS` → ECS `secrets:` (never `environment:`). Set values with the
`Secrets` CLI action, which writes to Secrets Manager / SSM. Interactive via
`pnpm respawn` → Secrets; headless (for automation) pipes the value on stdin — never argv:
`echo -n "$VALUE" | respawn --non-interactive --action secrets --service <svc> --secret <ENV_VAR>`.
Naming: `respawn/<service>/<name>` (sm), `/respawn/<service>/<name>` (ssm).
Full spec: `artifacts/AGENT_PROMPT.md` §7.

**Secrets are per account AND per region.** They are not part of the stack, so moving a
service to another account or region leaves them behind and the first deploy there fails
preflight naming the missing entry. Recreate them against the new target before
deploying — the same `SECRET_REFS` paths, written with the same command plus a
`--profile` pointing at the new account.

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

### GoldSrc logs the rcon password; the shim must filter stdout

HLDS echoes every rcon request to the console verbatim, password included, in two
shapes:

```
rcon 711248148 "<password>" sv_airaccelerate
L 08/28/2026 - 22:59:08: Rcon: "rcon 711248148 "<password>" sv_airaccelerate
```

Container stdout is the CloudWatch stream, so every command the rcon-control sidecar
issues wrote the credential into the log group — which defeats `SECRET_REFS`, whose
whole point is keeping secrets out of anything readable with ordinary infrastructure
access. There is no cvar to disable it, and rotating does not help: the next call logs
the new value.

Every goldsrc shim therefore hands off through `apps/_shared/hlds-log-redact.sh`
instead of `exec`ing the upstream entrypoint directly:

```sh
exec /bin/sh /hlds-log-redact.sh /bin/sh ./entrypoint.sh "$@"
```

It redacts rather than suppresses, because the line is also the only audit trail of
rcon use (a stranger's failed guess logs the same shape as `Bad Rcon:`). Two things it
is careful about, both measured rather than assumed:

- **It does not use `exec hlds | sed`.** That makes the shell PID 1 and hands the
  container sed's exit status, and `server_health` reads that status to tell a normal
  stop (`SIGKILL after ECS asked it to stop`) from an OOM kill.
- **`set -e` must be off around its `wait`.** `wait` reports the *game's* exit status,
  so a server exiting non-zero — a crash, or the SIGKILL ending every normal stop —
  terminates the wrapper on the spot and the container is torn down before the filter
  drains. Measured with errexit on: a server exiting 42 delivered its log 1 run in 5,
  and the faster it died the less survived, which is backwards.

A new goldsrc service needs both halves: `COPY apps/_shared/hlds-log-redact.sh` in the
Dockerfile, and the handoff line above in the shim. Verify with a real rcon call —
grep the container log for the password and expect zero hits.

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

### Deleting a service from the repo blocks EVERY deploy until its stack is gone

The shared stack owns one ECR repository per service. Remove a service's directory (or
rename its `SERVICE_NAME`, which is the same thing) and the shared stack stops declaring
that repository — so the next deploy of ANY service tries to delete it, CloudFormation
refuses because the still-existing service stack holds an export on it, and the shared
stack rolls back:

```
Delete canceled. Cannot delete export
  respawn-dev-shared:ExportsOutputFnGetAttEcrvalheimmoddedRepository...Arn
  as it is in use by respawn-dev-valheim-modded.
❌ respawn-dev-shared failed: UPDATE_ROLLBACK_COMPLETE
```

Every deploy touches the shared stack first, so this is **fleet-wide**, not scoped to the
service you removed. Nothing can deploy until it clears. The rollback is clean — the
existing fleet keeps running — but the new service's ECR repository is never created.

**So a service rename is: destroy the old stack FIRST, then deploy.** That is the reverse
of the safe-looking order, and the safe-looking order deadlocks. If the old stack cannot
be destroyed yet (its volume holds something you still need), keep the old service
directory in the repo until it can — the shared stack only cares that something still
declares the repository.

### `pnpm respawn:*` scripts hardcode a `--service` list

The batch scripts in `package.json` name each service explicitly — currently all 24,
counting each variant separately (`ut99` and `ut99-vanilla` are two entries; Valheim
alone is six). It is easy to
forget when adding a server or a variant, and a missing name is skipped silently. Add yours,
or use the interactive `pnpm respawn` menu, which discovers them properly.

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

### Custom game content: the layout is the game's, the selection is yours

A service shipping custom maps uses this shape. `tfc` is the reference; `quake3`,
`quake1` and any future skill-map service should follow it rather than reinvent:

```
apps/<svc>/…/content/        gitignored payload — layout dictated by the GAME
apps/<svc>/…/maps.txt        tracked manifest: <name> <category> <url>
apps/<svc>/…/mapcycles/      tracked, GENERATED from maps.txt
apps/<svc>/…/scripts/        fetch-content, generate-mapcycles, publish-fastdl
```

**Do not try to organise `content/`.** GoldSrc needs a flat `tfc/maps/*.bsp` with wads
at the game-dir root; nesting by category breaks every map. Organise the *manifest*
instead — that is what "skill maps only" actually needs.

`maps.txt` is the single source of truth. `scripts/generate-mapcycles.sh` derives the
cycles from its category column; the results are **tracked** so the image can COPY them
without running the generator at build time, and so drift shows up as a diff in review.
Hand-writing a cycle instead means it silently stops matching the manifest the first
time somebody adds a map — mapchooser just never offers the new one.

Selecting a cycle (`GAME_ENV_MAPCYCLE=skill`) is an **env change, not a rebuild** —
every cycle ships in the image, so it is a new task definition and a restart. Only
*adding a map* forces a rebuild, because the `.bsp` is COPYed and covered by the image
content hash. An unknown cycle name aborts the container with the valid list rather
than booting with a vote that has nothing to offer.

### Custom game content is a two-sided change: image AND FastDL

A service that ships custom maps (`apps/tfc/variants/modded`) keeps them in a
gitignored `content/` dir, rebuilt from a tracked manifest with
`pnpm tfc:content:fetch`. Docker's build context ignores `.gitignore`, so they are
still COPYed into the image and still covered by the content hash — a new map changes
the tag and forces exactly one rebuild.

Adding a map therefore needs **both** halves:

| Half | Command | Skipping it means |
|------|---------|-------------------|
| Server | manifest → `content:fetch` → deploy | `changelevel <map>` fails; the server has no file |
| Client | `pnpm tfc:content:publish <bucket> <profile>` | Joiners crawl at HLDS's 8 kB/s cap and time out |

Plus `mapcycle.txt`, or the vote never offers it.

**Check before launching, not after:** `pnpm tfc:content:check <bucket> <profile>
[--cycle <name>]`, or the MCP's `check_content` verifies both halves and exits non-zero on either — that the current
content corresponds to a tag actually in ECR (so the image is not older than a map you
added), and that FastDL carries every `.bsp` and `.wad` the chosen cycle needs. Both
failures are otherwise silent until a player cannot join.

The MCP mirrors all three, returning the scripts' output verbatim so a failure reads
the same either way: `check_content` (read-only, always available), `publish_content`
and `clear_content` (both need `RESPAWN_ALLOW_DEPLOYS=true`; clear also needs
`confirm` set to the bucket name). They are generic — the MCP looks for
`<service-path>/scripts/<name>.sh` and says so plainly when a service has none, the
same "run what the service declares" rule the rcon manifests follow.

S3 is a **pre-play step, not a runtime dependency** — the server never reads the
bucket, only players do, so an empty or stale bucket makes joins slow but cannot stop
the server starting. Keep it that way: moving content fetch into the boot path trades
a safe failure mode for an unsafe one.

The FastDL bucket must be public-read (GoldSrc clients send no credentials), so treat
anything uploaded as openly downloadable.

### A save file is not FastDL content: it must round-trip, not publish

`apps/valheim` ships a world save through S3, and it looks like the `tfc` content
pattern but is its opposite. Custom maps are **static, read-only, and reproducible**
from `maps.txt` — the server never reads the bucket, so publishing and clearing them
one-way is safe, and a lost copy is one `content:fetch` away. A world save is
**mutable live state and the only copy of a session's progress**. Push-before /
clear-after, applied to it, discards every session.

So the cycle is a round trip, and both halves are load-bearing:

| Half | Command | Skipping it means |
|------|---------|-------------------|
| In | `pnpm valheim:world:publish <variant> <world>` → restart | the server keeps playing the world it booted on |
| Out | `pnpm valheim:world:pull <variant> <world>` | the session's progress exists only on EFS, then only until the next seed |

Every script takes the **variant** first (`vanilla` \| `modded`): the library, the S3
prefix and the flavor are all per-variant, and defaulting it would pick one server's
library while talking to the other's bucket.

The `world-sync` sidecar (`apps/respawn/sidecar/world-sync`) mounts the same EFS
volume as the game and mirrors the save to `<prefix>/live/` on an interval **and** on
SIGTERM. The interval one is the load-bearing one — a task can die without ever
delivering SIGTERM — exactly as in `sidecar/mysql-backup`.

It is **not** that sidecar with different paths. `mysql-backup` restores from S3
unconditionally, which is right when the task has no volume and S3 holds the only
copy. Here EFS outlives the task and holds the live world, so an unconditional restore
would replay a stale save over a played one. Two rules follow, both enforced:

- **The volume is authoritative.** Nothing is written to it unless a save was
  explicitly placed in `<prefix>/inbox/`, which is drained **once** and deleted — a
  handoff, not standing config, so a task restarting mid-session cannot re-seed over
  live play.
- **A stale push is refused.** The `.db` header carries `netTime`, the in-game clock,
  which Valheim advances only while a player is connected. An incoming save whose
  clock is *behind* the volume's is rejected on both sides (script and sidecar) —
  that is the machine-checkable form of "this would discard progress". mtime cannot
  do this: it does not survive a copy or an upload. `WORLD_SYNC_SEED_FORCE=true`
  overrides, for a deliberate rollback.

**There is deliberately no default world, and that is a safety property.** Valheim does
not error on an unknown world name — it **generates a new empty world under it** and runs
happily. So a defaulted `GAME_ENV_WORLD_NAME` means a routine deploy can fabricate a
convincing empty world wearing a real world's name, which the sidecar then mirrors to S3
where it can later be pulled down and mistaken for the real thing. That happened twice
before this guard existed, including 325 KB of junk mirrored under a name that mattered.

Three layers, because the failure is silent at every one of them alone:

| Layer | Guard |
|---|---|
| Deploy | preflight refuses a world-sync service that names no world, listing the library |
| Synth | an unnamed world emits `WORLD_NAME=''` rather than throwing — `app.ts` synthesizes **every** stack each run, so a throw would break the fleet for one service |
| Runtime | the sidecar refuses to signal ready when the save is absent, so the game is held back and creates nothing (`WORLD_ALLOW_CREATE=true` opts in to a genuinely new world) |

The load-time check was tried and removed: `stack-discovery.ts` catches a config error and
only **warns**, so throwing there made the service vanish from the CLI menu instead of
asking which world to run — the opposite of the intent. `REQUIRED_ENV_VARS` does not work
here either, because `findUnsatisfiedRequirements` treats a `DEPLOY_PROMPTS` entry as
satisfying the requirement, which is right interactively and wrong for a headless deploy
where the prompt never runs.

**Rotating to a different world is a deploy-time choice**, via `DEPLOY_PROMPTS=WORLD_NAME:select:...`
— `pnpm respawn` → Deploy → valheim → pick. The name *is* the save's file name, and the
sidecar resolves it through `resolveWorldName()` from `gameEnvVars`, **not** from the
loaded config. That indirection is load-bearing: `app.ts` applies the prompt answer to
`gameEnvVars` *after* `loadConfig` runs, so a name captured at load time is the
pre-prompt one — which moved the game to the new world and left the sidecar seeding an
inbox nobody fills and mirroring a world nobody plays, silently, in both directions.
`WORLD_SYNC_NAME` pins the sidecar against a rotation, for the rare case that wants it.

**Worlds accumulate on the volume by file name**, so rotating back to one that has
already run here needs no S3 at all — the sidecar finds no inbox entry and keeps what
the volume has. S3 is only for bringing a world IN from a laptop or taking one OUT.
Consequence worth knowing: the volume can hold worlds the local library has never seen,
and nothing local lists them — `check-content.sh` sees only the library and the bucket.

The game container waits on the sidecar's health check before starting. Valheim reads
the world once and holds it open, so a save installed after that point is not merely
ignored — the game's next periodic save overwrites it. Losing that race silently
*reverses* the rotation rather than delaying it.

**What the clock guard does NOT catch.** It compares *how much play* two copies hold,
so it only ever protects against losing progress. It is blind to a world being
*damaged* — a mod-corrupted save has a HIGHER clock than the clean one, so both the
sidecar and the scripts will happily install it and pull it down over a good copy.
Valheim stores objects as a continuous stream, so a save corrupted by a removed
content mod is often unrecoverable rather than merely degraded. Before enabling any
mod that adds prefabs, copy the world to a new name in `worlds/` — that snapshot is a
first-class rotation target and nothing automatic can overwrite it.

Use the **private** state bucket (`respawn-state-*`, shared with cs16-kz's dumps and
scoped per-prefix by the task role), never the FastDL one: that is public-read by
necessity, and a world save is the entire map, every base and chest in it.

`apps/*/worlds/` is gitignored like `content/`, but unlike `content/` it is **not
reproducible** — there is no manifest to refetch it from. It is the master copy and
needs its own backup.

### The Valheim variants are a lattice, and a save remembers where it ran

`apps/valheim` is six variants. Each is a **ruleset** — which mods load, what the server
can be driven with — and NOT a world: which world runs on one is a separate, deploy-time
choice, and the same save can sit in several variants' libraries at once.

| Variant | Carries | Client install | Worlds stamped |
|---|---|---|---|
| `valheim` | nothing (crossplay on, Xbox can join) | none | `vanilla` |
| `valheim-admin` | rcon only | none | `vanilla` |
| `valheim-qol` | + convenience mods | small | `vanilla` |
| `valheim-loot` | + EpicLoot, CLLC, Drop/Spawn That | ~40 MB | **`modded`** |
| `valheim-build` | + OdinArchitect, OdinsKingdom, PlantEverything | ~50 MB | **`modded`** |
| `valheim-overhaul` | the union of both, plus the Therzie suite | ~500 MB | **`modded`** |

They form a lattice rather than a line: `qol → loot → overhaul` and `qol → build →
overhaul`, with `loot` and `build` siblings that a world cannot move between. That shape
is not documentation, it is **expressed in the manifests** — `variants/overhaul/mods.txt`
includes `../loot/mods.txt` and `../build/mods.txt` rather than restating either, so a
change to a lower rung reaches the top automatically and the three cannot drift into a
state where a world can no longer climb.

Separate services means separate stacks, so **separate EFS volumes and disjoint S3
prefixes**; no variant can reach another's world by construction.

That is not enough on its own, because a save can be carried between them by hand. So
every save carries a provenance stamp, `<world>.respawn.json`, written by the sidecar
(which knows what server it is) and travelling with the `.db`/`.fwl` through S3:

```json
{ "world": "respawn-world", "flavor": "modded", "mods": ["EpicLoot.dll"],
  "history": [ { "service": "valheim-loot", "flavor": "modded", "at": "…", "mods": […] } ] }
```

**Flavor alone stopped being sufficient the moment more than one variant was modded.**
`modded` → `modded` looks identical whether a world is climbing from `qol` to `overhaul`
(safe — the target has every plugin the save has met) or descending the other way
(destructive — the target lacks the plugins whose prefabs are in the file). So the guard
compares the **plugin sets**: a seed is refused when the incoming stamp's
`mods_world_altering` names a plugin this server does not have, and the refusal names the
plugin rather than the variant. Checked in `sync.sh` at seed time (the side that cannot be
bypassed by copying files into the bucket) and in `assert_plugins_compatible` at publish
time (so the operator finds out at the keyboard). A stamp written before
`mods_world_altering` existed yields nothing and falls through to the flavor check below —
the same honest degradation the stamp makes everywhere else.

**The flavor rule still holds underneath it: `vanilla` → `modded` is allowed and stamps
the save permanently; a save stamped `modded` is refused by the vanilla server for ever.** That asymmetry
mirrors the physical fact — mod-added objects are ZDOs carrying the mod's prefab hashes,
and loading them without the mod makes Valheim destroy those objects and rewrite a
continuous object stream that usually cannot be repaired. Adding mods costs nothing;
removing them is the destructive direction.

Checked in three places, deliberately: `publish-world.sh` (so the operator finds out at
the keyboard), the sidecar at seed time (the side that cannot be bypassed by copying
files into the bucket), and `check-content.sh`, which flags a modded save sitting in a
vanilla library. An **unstamped** save is refused into vanilla too — unknown provenance
is not the same as known-clean — and `--assume-vanilla` is the operator asserting it.

`write_stamp` takes `modded` from whichever side carries it, so a later vanilla run
cannot launder a modded save; it only appends to `history`.

**A sidecar's memory limit must not be outgrown by the payload it moves.** `world-sync`
ran at a hard 128 MiB, which is ample for a world save and was not ample for a large mod
set: `aws s3 sync` over `valheim-overhaul`'s 527 MB of plugins was OOM-killed by the
kernel, and the only clue was a shell line in the log —

```
sync.sh: line 113: 8 Killed   aws s3 sync ... --delete --only-show-errors
[world-sync] ERROR could not sync plugins from s3://.../valheim-overhaul/plugins
[world-sync] not signalling ready — the game will not start
```

The fail-closed design worked exactly as intended (a modded server was held back rather
than coming up unmodded), but "could not sync" pointed at S3 or IAM rather than at a
memory limit, which is where the time goes.

Both halves of the fix matter. `sync.sh` now caps the transfer's concurrency and chunk
size (`max_concurrent_requests 2`, `multipart_chunksize 4MB`), because `aws s3 sync` holds
roughly concurrency x chunk size of buffers on top of the CLI's own ~80 MB — so the
default 10 x 8 MB cannot fit in 128 MiB whatever the payload. That makes the sidecar's
memory roughly **constant in the size of the mod set**, which is the property that makes
publishing an arbitrary mod list safe. The limit was also raised to 256 MiB for headroom.
Raising the limit alone would only have moved the cliff to the next mod set, and every
MiB given to a sidecar is taken from the task total and therefore from the game.

**Mods are content, not state.** `mods.txt` is tracked and `mods/` is gitignored and
rebuildable — the `content/` relationship, not the `worlds/` one. Both the fetch and the
publish use `--delete`, as does the sidecar's sync: without that, removing a line from
`mods.txt` leaves the plugin on the volume and the server keeps loading a mod nobody
believes is installed, which then writes its prefabs into the world.

**A manifest can `include` another, and the effective set is locked.** Shared sets live at
the project level — `mods-admin.txt` (rcon, the floor for every modded variant) and
`mods-qol.txt` (convenience, layered on it) — so a set used by five variants is declared
once. Includes are resolved recursively and a file reached twice contributes once, which
is what lets `overhaul` include both siblings. Two rules keep the merge honest: two
manifests naming the same package must agree on the version, and `world-safe` is dropped
unless **every** listing asserts it. `fetch-mods.sh` then writes the flat resolved set to
the variant's **tracked** `mods.lock` — the `mapcycles/` relationship, generated and
committed so drift shows up as a diff, and the one authoritative list a player's modpack
has to match.

**`mods-qol.txt` must stay Jotunn-free, and that is load-bearing.** Its variants' worlds
stay stamped `vanilla` only while every plugin in it is world-safe, and Jotunn ships four
embedded asset bundles and calls `AddPrefab` — it cannot honestly be asserted world-safe,
and the error directions are not symmetric: wrongly marking it safe lets a modded world go
back to vanilla and be shredded, wrongly marking it unsafe only costs portability. One
unflagged plugin added to that file makes every world on **every** variant including it
permanently un-returnable. `MSchmoecker/MultiUserChest` is what this costs — it declares
Jotunn, so it lives in the content rungs instead.

**Thunderstore dependencies are checked, never auto-fetched.** A package nobody declared
is a package nobody assessed, and `world-safe` is an operator assertion — auto-fetching
would silently add plugins with no assertion attached, and the conservative default would
then quietly make every world there world-altering. So `fetch-mods.sh` reads each
package's own `manifest.json`, and refuses with the exact lines to add. This is not
theoretical: nothing had ever hit it because `ValheimRcon`'s only dependency is BepInEx,
which the image provides — the first content rung needed `Jotunn` + `JsonDotNET`, and the
building rung turned out to need `HookGenPatcher`, which nobody had noticed.

**A BepInEx PATCHER cannot be delivered by this pipeline, and the fetcher refuses one.**
Patchers load from `BepInEx/patchers/` during the preloader phase, and the upstream
image's `write_bepinex_config` syncs exactly one directory (`$config_path/plugins/` → the
live plugin dir) with no patcher equivalent. A patcher flattened in with the plugins is
copied where nothing reads it: it never runs, the mod requiring it fails to load, and
BepInEx logs that and carries on — a healthy-looking server missing a mod. This is why
`MathiasDecrock/PlanBuild` is absent from `valheim-build`. Adding the capability means a
second published prefix, a second sidecar sync, and a copy into `/opt` from the
`PRE_SERVER_RUN_HOOK` shim.

Plugins are mirrored **one way** (S3 → volume) before the game starts, and a failed
plugin sync deliberately never signals ready — the game container's dependency holds it
back for ever rather than let a modded server come up unmodded and write an unmodded
state into a world whose players expect the mods.

**Crossplay is incompatible with BepInEx** and is pinned off on the modded variant. With
crossplay on, Valheim uses PlayFab networking instead of Steam, BepInEx cannot hook it,
and plugins silently do not load — a healthy-looking, entirely unmodded server.

### Mid-game admin is a modded-only capability, and the MCP drives it

Vanilla Valheim has **no remote console at all**: an admin must be a logged-in player,
and on a dedicated server only Group A commands (kick/ban/unban/banned/save/ping) work.
So `valheim` cannot be administered mid-game by anything, ever. That is the entire reason
`valheim-admin` exists: vanilla gameplay, nothing for a player to install, and a server the
MCP can still drive.

Every modded variant gets it from `Tristan/ValheimRcon` (via `mods-admin.txt`), which adds an rcon listener — and
the fleet already speaks that: `ENABLE_RCON_CONTROL` + `RCON_PROTOCOL=source` hands the
whole existing rcon-control sidecar and MCP surface to Valheim with no new transport.

Two things that are easy to get wrong:

- The port is `2458/tcp` in **`INTERNAL_PORTS`**, so it gets a task mapping and no public
  ingress (verified in the synthesized template: only 2456-2458/**udp** are open). An
  admin port in `ADDITIONAL_PORTS` would be world-reachable.
- The plugin is config-**file** driven, so the password cannot be a `GAME_ENV_` value —
  that lands in the task definition in plaintext. `WORLD_SYNC_RCON_CONFIG` makes the
  world-sync sidecar write it, because that container is the only one that both holds the
  ECS secret and mounts the volume the config lives on. It **patches** the two keys rather
  than generating the file, so it needs no knowledge of the plugin's section name; only a
  first-ever boot takes the generate path, and it says so in the log. Failure is
  fail-closed by the plugin's own design — an empty password disables it, so a config that
  cannot be written means no rcon, never an unauthenticated listener.

**A mod's console commands are reachable, mostly useless, and silent about both.**
ValheimRcon's `consoleCommand` executes anything the game's console accepts, so a plugin
that registers a console command is in principle drivable. Three measurements against a
live `valheim-loot` task (2026-08-30) bound what that is worth:

- **The reply carries no information.** `consoleCommand` answers `Command 'X' executed.`
  whether X succeeded, failed, or does not exist. Output goes to the container's stdout,
  so the result is read from `server_logs` afterwards — and a typo is indistinguishable
  from success. This is why mod commands are modelled as commands and never as queries:
  there is no reply to parse.
- **EpicLoot's 30 console commands do not work on a dedicated server.** `el-help` lists
  them (`magicitem`, `bounties`, `lucktest`, `gotomerchant`, …), which makes them look
  available; `lucktest Greydwarf 1.0` answers `'lucktest' is not valid in the current
  context.` They are player-context commands and a dedicated server has no player. They
  are deliberately NOT in the manifest — declaring them from that help output would have
  produced a surface that reports success on every call and does nothing.
- **Drop That and Spawn That are the real additions.** `dropthat:reload` re-reads loot
  configuration without a restart (verified), plus two config-dump commands and the two
  `spawnthat:` commands that take an explicit spawn id rather than the player's position.
  CreatureLevelAndLootControl, Jotunn, MultiUserChest, TargetPortal, PlantEasily,
  QuickStackStore, AzuCraftyBoxes and AAA_Crafting register **no** console commands.

**`requires` on a manifest entry is what keeps one manifest honest across six variants.**
It lists the Thunderstore packages an entry needs, matched against the variant's tracked
`mods.lock`. `get_server_options` filters the surface to what that server actually has and
reports the rest under `unavailableHere` (declared, but not here, and what it needs) —
because "not on this server" and "never declared" are different answers, and only the
first tells you which variant to run it on. The one-line family summary counts
**post-gate** for the same reason: it read "35 commands" on a server whose body listed 30
and gated 5, and the summary is the half people scan. `list_services` carries the gate as
its own token too — `commands:30(+5 need mods)` — on the same reasoning that gave drift
its token: hiding it behind a per-service call defeats the point of a listing. `run_command` refuses a gated command outright,
which matters precisely because the console would have answered "executed". A service with
no `mods.lock` gates **nothing**: unknown must not read as unavailable, or every non-Valheim
service would lose its whole command surface.

**`world-safe` in `mods.txt` is what stops admin tooling quarantining a world.** A plugin
that opens a socket and runs commands writes no prefabs, so a world it ran under is still
a vanilla world — stamping it `modded` would refuse it from the vanilla server for ever,
for nothing. The flag asserts that, the sidecar stamps `vanilla` when every plugin present
carries it, and `world_safe_only` in the stamp's history records the claim so it can be
audited. It is an assertion, not something derivable from a `.dll`: the default is unsafe
and one unlisted plugin makes the whole run world-altering.

**Adoption cost of mods is one thing, and it is not client installs.** A server-side
plugin needs nothing from players. What it costs is crossplay: with crossplay on Valheim
uses PlayFab networking, BepInEx cannot hook it, and plugins silently do not load — so the
modded variant pins `GAME_ENV_CROSSPLAY=false` and is **Steam/PC only**. That exclusion is
invisible to an Xbox player (their join looks like a network fault), so it is carried in
`SERVER_NAME` and `SERVICE_DISPLAY_NAME` rather than left in a comment.

`list_worlds` answers **"which worlds do we have"** and is the entry point to all of the
above — `publish_world` and `switch_world` both need a name you can only get from
somewhere. It reads local disk only: no AWS calls, instant, and it still works when the
SSO session has expired, which is precisely when `world_status` cannot answer (it needs
three S3 round trips and degrades to VERDICT UNKNOWN). The two answer different
questions — "what do we have" vs "has the server been played since my copy" — and neither
substitutes for the other.

**"Can it run without mods" is the wrong question, so the tool does not answer it.** A
modded save loads on a vanilla server perfectly happily — it just silently deletes every
object the mods created, and Valheim writes objects as a continuous stream, so that damage
is usually unrepairable. What matters is the *cost*, which is reported as a consequence:

```
without mods: safe — nothing mod-created is in this save
without mods: DESTRUCTIVE — objects created by EpicLoot.dll would be deleted on load, permanently
without mods: UNKNOWN — no provenance stamp, so nothing knows whether a world-altering mod ever ran
```

The stamp records `mods_world_safe` and `mods_world_altering` separately, not just a flat
`mods` list, so the culprit can be **named**. A bare list says what ran; it does not say
which of those threaten a later vanilla load — and the `.world-safe` manifest that would
answer that lives on a server, not next to the save. A stamp written before the split
degrades honestly: no annotation, verdict still taken from `flavor`, no invented
classification.

It groups by world NAME rather than by service, because one save living in two libraries
is one world; and it flags **divergence** when those copies disagree on save-format
version or world clock, which is the state where "the world" silently names two
different things.

The MCP exposes the world lifecycle as `world_status` (read-only, always available),
`publish_world`, `pull_world`, `clear_world` and `switch_world`. `switch_world` redeploys
with a `WORLD_NAME` override and **refuses a name the library does not have** — deploying
an unknown world does not fail, Valheim creates a new empty one and runs it, so a typo
would silently replace the session with a fresh spawn.

### The MCP's tools are service-parameterised, so applicability is data

One `deploy`, one `run_command`, twenty services — per-server tools would mean 32 x 20 of
them. The cost of that shape is a discoverability gap: nothing said which families a given
service supports, and the failure it produced was not an error but a *wrong conclusion*.
`valheim` has no rcon transport, so "no manifest" there is a category fact about the game,
not a file somebody forgot to write — and a caller who read it as the latter would go and
write one that could never help.

`resolveFamilies()` in `capabilities.ts` derives it from config in **one** place, so a new
family cannot be added to the fleet and quietly stay missing from what the MCP advertises.
Surfaced by `list_services` (every configured service, running or not) and by
`get_server_options` on **both** branches — the summary used to exist only where a manifest
was missing, so the services with the richest surface were told least about it.

Three states, kept distinct because they call for opposite actions:

| State | Meaning |
|---|---|
| `commands:<n>` | transport + manifest; usable |
| `commands:UNREACHABLE(drift)` | a manifest exists but `ENABLE_RCON_CONTROL` is off — declared and unreachable |
| `commands:none` | no transport configured |
| `commands:no-manifest` | transport is on, nobody wrote the manifest |

Drift gets its own token in the one-line listing rather than folding into `none`, because
the listing is what people scan; hiding it behind a per-service call defeats the point.
It found six real cases on first run (`cs2`, `css`, `gmod`, `l4d2`, `tf2`, `quake3`).

**The no-transport message deliberately does not claim the game has no console.** Config
cannot tell "offers none" from "nobody enabled it" — Valheim being the former took
research, not a config read, and asserting it generally would be a guess wearing the
costume of a fact.

`get_server_options` returns this as a **success**, not an error. Returning `isError` for a
fully working service made it read as misconfigured.

### A mod's config file is written by the game container, not by a sidecar

Every modded Valheim variant builds its own image (`FROM ghcr.io/lloesche/valheim-server`)
for exactly one reason: the rcon plugin's password. Their Dockerfiles are **byte-identical
on purpose** and COPY one shared shim from the project level, `apps/valheim/respawn-rcon-config.sh` —
variants differ in their mod set, which is published to S3 and synced onto the volume at
boot, and none of that is baked into an image. (Identical content means an identical
content-hash tag, but ECR repositories are per service, so each still builds and pushes
into its own: the tag dedupes within a repository, not across them.) The plugin is config-**file** driven, so
the value cannot be a `GAME_ENV_` (plaintext in the task definition) — it has to be written
into a file, from an ECS secret, inside the container.

The obvious home was the `world-sync` sidecar, which already holds a secret and mounts the
volume. **Measured, and wrong.** On the first real deploy:

```
23:21:39  [world-sync] wrote rcon config to /config/bepinex/config/
23:23:57  [valheim-updater] Fresh BepInEx install        <- into /opt, 2 min later
23:24:15  [Valheim Rcon] Password is empty. Plugin will not work.
23:24:42  [Valheim Rcon] Start listening rcon commands
```

BepInEx installs into `/opt/valheim/bepinex/`, and the plugin reads its config from there —
never from the volume. Only the game container has **both** the injected secret and that
tree, which is why this is a shim, exactly as the two-image-strategies rule says.

**The failure mode is the part worth remembering:** an empty password does not disable the
listener, it makes it reject every auth. So a config that was never read presents as
`rcon password rejected` — indistinguishable from a wrong credential, and nothing points at
the file. `rcon-control` and the wire protocol were both fine the whole time.

Timing is the whole mechanism. The shim runs on **`PRE_SERVER_RUN_HOOK`**, after the updater
merges BepInEx and before the server starts. Both earlier hooks (bootstrap,
`POST_BEPINEX_CONFIG_HOOK`) fire *before* a fresh install, which then lands on top of
whatever they wrote — and the plugin's own config says "[Server restart required for
update]", so being late is not recoverable within a run either. The hook is set as `ENV` in
the Dockerfile, not in `.env`, so no shell quoting has to survive a dotenv value and a task
definition.

It patches the two keys it owns rather than generating the file, so it stays correct if the
plugin renames or reorders sections; it only generates on a first run, under `[1. Rcon]` —
read out of the shipped assembly's string table, not guessed. Every failure path is
non-fatal: no secret, no BepInEx tree, or no `Password` key all leave rcon disabled rather
than blocking a server that is otherwise fine.

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
