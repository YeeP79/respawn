# Game Server CDK Executor — Agent Prompt

## Related Prompts

- **`GAME_SERVERS_PROMPT.md`** — Covers the actual game server configurations, upstream Docker repos, and per-service `.env` setup. Read that prompt for details on what Respawn is deploying.

## Context

You are working inside an existing Nx monorepo. The repo already has `/libs` and `/packages` directories scaffolded. Your job is to build a **game server deployment system** under `/apps/` that uses AWS CDK and a Clack-powered interactive CLI to deploy, manage, and tear down containerized game servers on AWS Fargate.

### Reference Files

Before you begin, read the reference files in `/artifacts/templates/`. These define the expected configuration shape and interfaces:

- `/artifacts/templates/.env.example` — per-game environment config (CPU, memory, ports, etc.)
- `/artifacts/templates/schema.json` — Nx executor schema definition
- `/artifacts/templates/cdk-config.ts` — TypeScript interfaces for extracted CDK settings
- `/artifacts/templates/cdk-defaults.ts` — sensible defaults for all CDK configuration

---

## Existing Repo Structure

The Nx monorepo is already scaffolded with the following layout. **Do not restructure existing code** except for renaming as noted below.

```
/apps/
  service-alpha/            # TypeScript app (existing) → RENAME to valheim/
    Dockerfile
    src/
    package.json
    project.json
  service-bravo/            # TypeScript app (existing) → RENAME to ut99/
    Dockerfile
    src/
    package.json
    project.json
  service-charlie/          # Python app (existing) → RENAME to tfc/
    Dockerfile
    pyproject.toml
    project.json
/libs/
  docker-utils/             # Existing Docker utility library — USE THIS
  shared-types/             # Existing shared types library
/artifacts/
  AGENT_PROMPT.md           # This file
  GAME_SERVERS_PROMPT.md    # Game server Docker setup details
  templates/                # Reference config shapes and defaults
```

**First task: Rename the existing apps**
- `service-alpha` → `valheim` (Valheim dedicated server)
- `service-bravo` → `ut99` (Unreal Tournament 99 server)
- `service-charlie` → `tfc` (Team Fortress Classic server)
- Update `project.json` names, any workspace references, and `tsconfig` paths accordingly

**Important context:**
- Package manager is **pnpm** (pnpm-workspace.yaml at root)
- Deployment is Docker-first — each service has a `Dockerfile`
- `libs/docker-utils` already exists. **Read its source code first** and use/extend it for Docker build and push operations. Do not create a separate `docker-builder.ts` utility if `docker-utils` already covers it.
- `libs/shared-types` already exists. Evaluate whether CDK config types belong there or in the executor's own config module. If the types are only used by the executor, keep them local.
- See `GAME_SERVERS_PROMPT.md` for details on each game server's upstream Docker image, ports, and configuration

## New Files to Create

```
/apps/
  respawn/                  # The Nx plugin + Clack CLI + CDK stacks
    src/
      executors/
        cdk/
          executor.ts       # Nx executor entry point
          schema.json       # Nx executor schema (copy from templates)
      cli/
        index.ts            # Clack interactive CLI flow
        actions/
          deploy.ts         # Build → Push → CDK Deploy
          destroy.ts        # Scale to 0 / destroy stack
          synth.ts          # CDK synth (preview CloudFormation)
          diff.ts           # CDK diff (preview changes)
          status.ts         # Show running services and their status
      stacks/
        game-server-stack.ts    # Main Fargate stack per service
        shared-stack.ts         # VPC, ECR repos, shared resources
      constructs/
        fargate-service.ts      # Reusable Fargate service construct
        idle-shutdown.ts        # Sidecar container for idle detection + scale-to-zero
        ecr-repo.ts             # ECR repository construct
        networking.ts           # Security groups, ALB if needed
        logging.ts              # CloudWatch log group construct
      config/
        loader.ts           # Reads .env + cdk-defaults, merges config
        types.ts            # Config interfaces (copy from templates)
        defaults.ts         # Default values (copy from templates)
      utils/
        cdk-runner.ts       # Child process wrapper for CDK CLI
        stack-discovery.ts  # Enumerates available service configs
        secrets-runner.ts   # Set/rotate secrets in Secrets Manager / SSM (masked input)
        logger.ts           # Consistent logging utilities
    executors.json          # Registers executor with Nx
    sidecar/
      idle-shutdown/
        Dockerfile          # Alpine + bash + curl + aws-cli
        watchdog.sh         # Connection monitoring + scale-to-zero script
    cdk.json                # CDK app entry point config
    tsconfig.json
    package.json
    project.json            # Nx project config

  valheim/.env              # Valheim server config (see template + GAME_SERVERS_PROMPT.md)
  ut99/.env                 # UT99 server config (see template + GAME_SERVERS_PROMPT.md)
  tfc/.env                  # TFC server config (see template + GAME_SERVERS_PROMPT.md)
  gmod/.env                 # Garry's Mod server config (see template + GAME_SERVERS_PROMPT.md)
```

### Service Discovery

The executor discovers deployable services by scanning `/apps/` for directories that contain **both** a `Dockerfile` and a `.env` file. This means:
- Existing services become deployable by simply adding a `.env` file
- The `respawn` app itself is excluded (no Dockerfile)
- Any new service follows the same convention

---

## Detailed Requirements

### 1. Nx Executor (`/apps/respawn/src/executors/cdk/`)

The executor is the Nx integration point. When a user runs `nx run respawn:cdk`, it launches the Clack CLI.

**`executor.ts`**
- Entry point called by Nx
- Accepts options from `schema.json` (see template)
- If `--non-interactive` flag is passed with required options (`--action`, `--environment`, `--service`), skip the Clack flow and execute directly. This enables CI/CD usage.
- Otherwise, launch the interactive Clack CLI flow
- Return `{ success: true/false }` per Nx executor contract

**`schema.json`**
- Use the template in `/artifacts/templates/schema.json`
- Supports: `action`, `environment`, `game`, `nonInteractive`, `dryRun`, `verbose`

**`executors.json`**
```json
{
  "executors": {
    "cdk": {
      "implementation": "./src/executors/cdk/executor",
      "schema": "./src/executors/cdk/schema.json",
      "description": "Deploy and manage game servers via CDK"
    }
  }
}
```

---

### 2. Clack CLI (`/apps/respawn/src/cli/`)

The interactive CLI uses `@clack/prompts` to walk the user through deployment actions.

**`index.ts` — Main CLI Flow**

```
1. intro()  — "🎮 Game Server Manager"
2. select() — Action: Deploy | Destroy | Synth | Diff | Status
3. select() — Environment: dev | staging | prod
4. multiselect() — Service(s): discovered from /apps/* (dirs with Dockerfile + .env)
5. (deploy only) Per-service deploy prompts — for each selected service that declares
   DEPLOY_PROMPTS in its .env, ask the question(s) and collect the answers (see below)
6. confirm() — Summary of action + environment + selected services + any deploy-prompt answers
7. spinner() — Execute the action, stream output
8. outro()  — Success/failure summary
```

**Per-service deploy prompts**

Some services need a choice made at deploy time rather than baked into `.env` (e.g. Garry's Mod's gamemode). Keep this generic — do not hardcode per-game logic in the CLI. A service declares its prompts in `.env`:

```
DEPLOY_PROMPTS=GAMEMODE:select:ttt|prop_hunt|darkrp
```

- Format: `<ENV_VAR>:<promptType>:<opt1>|<opt2>|...` (comma-separate multiple prompts)
- `promptType` of `select` renders a Clack `select()`; the chosen value is injected as `GAME_ENV_<ENV_VAR>` (→ `<ENV_VAR>` in the container), merging into `gameEnvVars`
- Prompts fire only for the `Deploy` action, after service selection, before the confirmation summary
- **Non-interactive / CI:** deploy prompts are skipped — the value must already be set in `.env` (e.g. `GAME_ENV_GAMEMODE=darkrp`) or passed as an explicit flag, so scripted deploys are unaffected

Important behaviors:
- **Discover services dynamically** by scanning `/apps/` for directories containing both a `Dockerfile` and a `.env` file (excluding the `respawn` app itself)
- **Show a summary** before confirmation: action, env, games selected, key config values (CPU/memory)
- **Stream CDK output** in real-time during execution, not just at the end
- **Handle errors gracefully** — if one service fails, report it and continue with others (unless user chose to abort on failure)
- **Color-code output** — green for success, red for failures, yellow for warnings

**Action Handlers (`/apps/respawn/src/cli/actions/`)**

Each action module exports an async function that:
- Accepts the resolved config (game config + environment + defaults)
- Executes the appropriate CDK/Docker commands
- Returns a result object with success/failure and any output

**`deploy.ts`**
1. Build Docker image from service directory using `libs/docker-utils` (or pull if `IMAGE_URI` is set in `.env`)
2. If idle shutdown is enabled, build the sidecar image from `/apps/respawn/sidecar/idle-shutdown/`
3. Tag images with environment and git SHA
4. Push to ECR (service image + sidecar image if applicable)
5. Run `cdk deploy` for the service's stack with context values from config
6. Report the service endpoint/IP on success

**`destroy.ts`**
1. Confirm destruction (extra confirmation for `prod`)
2. Run `cdk destroy` for the selected service stacks
3. Optionally clean up ECR images (prompt user)

**`synth.ts`**
1. Run `cdk synth` and output the CloudFormation template
2. Optionally save to a file

**`diff.ts`**
1. Run `cdk diff` and display changes

**`status.ts`**
1. Query ECS to show running services, task count, health, last deployment time
2. If idle shutdown is enabled, show time since last connection (if available from logs)
3. Display in a formatted table

---

### 3. CDK Stacks (`/apps/respawn/src/stacks/`)

**`shared-stack.ts`** — deployed once per environment
- VPC (use default VPC or create a simple one — make this configurable)
- ECR repositories (one per service)
- Any shared security groups
- Export VPC and ECR ARNs via `CfnOutput` for service stacks to import

**`game-server-stack.ts`** — deployed per service per environment
- Imports shared VPC and ECR from shared stack
- Creates Fargate service using the `fargate-service` construct
- All values driven by the merged config (`.env` + defaults)
- Stack naming convention: `{environment}-{serviceName}-server`
- Tag all resources with `environment`, `service`, `managedBy: respawn`

---

### 4. CDK Constructs (`/apps/respawn/src/constructs/`)

Build reusable constructs so stacks stay thin.

**`fargate-service.ts`**
- ECS Cluster (or reuse shared one per environment)
- Task Definition with config-driven CPU/memory
- Container definition with port mappings, environment variables, log config
- Fargate Service with desired count from config
- Security group allowing inbound on `CONTAINER_PORT` and `HOST_PORT`
- Optional auto-scaling if `ENABLE_AUTOSCALING=true`
  - Min/max from config
  - Target tracking on CPU utilization (threshold configurable)
- If idle shutdown is enabled, add the sidecar container to the task definition (see `idle-shutdown.ts`)

**`idle-shutdown.ts`**
- A lightweight sidecar container added to the same Fargate task definition as the game server
- Built from a small Alpine-based Docker image included in the repo at `/apps/respawn/sidecar/idle-shutdown/`
  - `Dockerfile` — Alpine + bash + curl + aws-cli
  - `watchdog.sh` — the monitoring script
- The sidecar shares the task's network namespace, so it can inspect connections on localhost
- **Netstat mode (`checkMethod: 'netstat'`):**
  - Runs `ss -tun state established dst :$CONTAINER_PORT` (or `sport` for UDP) on the configured interval
  - If zero established connections for `timeoutMinutes` consecutive minutes, triggers shutdown
- **HTTP mode (`checkMethod: 'http'`):**
  - Polls the configured `statusEndpoint` on the configured interval
  - Parses JSON response for a `connections` or `players` field
  - If value is 0 for `timeoutMinutes` consecutive minutes, triggers shutdown
- **Shutdown action:**
  - Calls `aws ecs update-service --desired-count 0` to scale the service to zero
  - Logs the shutdown event to CloudWatch before scaling down
- The sidecar needs an IAM policy attached to the task role allowing `ecs:UpdateService` and `ecs:DescribeServices` scoped to its own service
- All config values are passed as environment variables to the sidecar container from the merged config:
  - `IDLE_TIMEOUT_MINUTES`, `IDLE_CHECK_INTERVAL_SECONDS`, `IDLE_CHECK_METHOD`
  - `IDLE_STATUS_ENDPOINT`, `CONTAINER_PORT`, `ECS_CLUSTER`, `ECS_SERVICE`
- The sidecar should use minimal resources: 64 CPU units, 128 MiB memory
- If `idleShutdown.enabled` is false, the sidecar is not added to the task definition at all

**`ecr-repo.ts`**
- ECR repository with lifecycle rules (keep last N images, configurable)
- Image scanning on push enabled by default

**`networking.ts`**
- Security groups with rules driven by config
- If `ENABLE_PUBLIC_ACCESS=true`, set up appropriate ingress
- If game uses UDP (common for game servers), handle UDP security group rules
- Protocol (TCP/UDP) should be configurable in `.env`

**`logging.ts`**
- CloudWatch log group per service per environment
- Retention period from config (default: 7 days for dev, 30 for prod)

---

### 5. Configuration System (`/apps/respawn/src/config/`)

This is critical — the goal is to extract as much as possible so adjustments are easy.

**`types.ts`**
- Use the interfaces from `/artifacts/templates/cdk-config.ts`
- These define every configurable parameter

**`defaults.ts`**
- Use the defaults from `/artifacts/templates/cdk-defaults.ts`
- These are the fallback values when not specified in a game's `.env`

**`loader.ts`**
- Load the service's `.env` file using `dotenv`
- Merge with defaults (`.env` values override defaults)
- Apply environment-specific overrides (e.g., prod gets higher retention, no Fargate Spot)
- Validate the final config — error early if required values are missing
- Return a fully typed `GameServerConfig` object

**Environment-specific override logic:**
```
dev:    Fargate Spot enabled, lower defaults, shorter log retention
staging: Fargate Spot enabled, prod-like defaults
prod:   No Fargate Spot, higher minimums, longer retention, extra confirmation
```

---

### 6. Utilities (`/apps/respawn/src/utils/`)

**`cdk-runner.ts`**
- Wraps `child_process.spawn` to run CDK CLI commands
- Streams stdout/stderr in real-time
- Passes CDK context values (`-c key=value`) from config
- Handles exit codes and throws on failure
- Supports `--require-approval never` for non-interactive mode
- Supports `--dry-run` via `cdk synth` instead of `cdk deploy`

**Docker Build & Push — use `libs/docker-utils`**
- **Read the existing `libs/docker-utils` source first.** Extend it if needed rather than writing new Docker utilities.
- Required capabilities (add to `docker-utils` if missing):
  - Build Docker images from a given directory/Dockerfile path
  - Tag with `{environment}-{gitSha}` and `{environment}-latest`
  - Push to ECR
  - `docker buildx` support if available for multi-platform builds
  - Report image size after build

**`stack-discovery.ts`**
- Scans `/apps/` for valid deployable service directories
- A valid service directory contains both a `Dockerfile` and a `.env` file
- Excludes the `respawn` app itself
- Returns list of `{ name, path, config }` objects
- Used by the Clack CLI to populate the service selection prompt

**`logger.ts`**
- Wraps console output with consistent formatting
- Supports log levels: debug, info, warn, error
- `--verbose` flag enables debug output
- Timestamps on all output

---

### 7. Secrets Management

Game servers need secrets — RCON/admin passwords, Steam GSLT/login tokens, API keys. These must never live in plaintext `.env` files, the task definition, or CloudWatch logs.

**Standard: AWS Secrets Manager (`sm`) and SSM Parameter Store SecureString (`ssm`).** Use only these two stores. (An earlier draft referenced `nw-secrets-manager` — that package does not exist in this repo and is no longer the approach. Do not reintroduce it.)

**1. Reference in `.env` via `SECRET_REFS`.** Each entry maps a container env var to a stored value:

```
SECRET_REFS=<ENV_VAR>=<sm|ssm>:<sourceId>[|<jsonKey>], ...
```

- `<ENV_VAR>` — the variable name the container receives (same effect as a `GAME_ENV_` var, but the value comes from the secret store)
- `sm:<sourceId>` — Secrets Manager secret name or ARN; append `|<jsonKey>` to pull one field from a JSON secret
- `ssm:<sourceId>` — SSM SecureString parameter path
- Naming convention: `respawn/<service>/<name>` (sm), `/respawn/<service>/<name>` (ssm)
- The jsonKey delimiter is `|`, not `#` — `dotenv` strips `#...` from a value as an inline comment

Example: `SECRET_REFS=RCON_PASSWORD=sm:respawn/gmod/rcon,GSLT=ssm:/respawn/gmod/gslt`

**2. Resolve + inject (config loader + Fargate construct).**
- The loader parses `SECRET_REFS` into `SecretRef[]` (see `cdk-config.ts`) — splitting each entry into `{ containerEnvVar, store, sourceId, jsonKey? }`. Malformed entries fail fast at load.
- The Fargate construct converts each ref to an `ecs.Secret` and adds it to the container's **`secrets`** map (NOT `environment`):
  - `sm` → `ecs.Secret.fromSecretsManager(Secret.fromSecretNameV2(scope, id, sourceId), jsonKey?)`
  - `ssm` → `ecs.Secret.fromSsmParameter(StringParameter.fromSecureStringParameterAttributes(scope, id, { parameterName: sourceId }))`
- Grant the task **execution** role read access to each referenced secret/parameter (`grantRead`).

**3. Set / rotate values out-of-band — never commit them.** Provide `utils/secrets-runner.ts` (wrapping the AWS CLI) and surface it as an optional `Secrets` CLI action:
- Set SM: `aws secretsmanager create-secret` / `put-secret-value`
- Set SSM: `aws ssm put-parameter --type SecureString --overwrite`
- Prompt for the value with masked input (Clack `password()`); never echo it or pass it as a CLI arg where it lands in shell history.

Build the secrets path only when a service actually declares `SECRET_REFS`. Until then the loader returns an empty list and nothing is injected.

---

## Key Principles

1. **Config-driven everything** — If a value might change between services or environments, it goes in `.env` or defaults. Never hardcode AWS resource sizes, ports, counts, or names in stack code.

2. **Thin stacks, fat constructs** — Stacks should be ~20 lines of construct instantiation. All logic lives in constructs.

3. **Interactive by default, scriptable by flag** — The Clack CLI is the primary interface. `--non-interactive` mode with explicit flags enables CI/CD.

4. **Fail fast, fail clearly** — Validate config before any AWS calls. Surface errors with actionable messages, not stack traces.

5. **Environment safety** — Production deployments require extra confirmation. Destructive actions always require confirmation. `--force` flag available but discouraged.

6. **Tagging** — Every AWS resource gets tagged with `environment`, `service`, `managedBy`, and `deployedAt`.

---

## Dependencies

```json
{
  "dependencies": {
    "aws-cdk-lib": "^2.x",
    "constructs": "^10.x",
    "@clack/prompts": "^0.7.x",
    "dotenv": "^16.x",
    "chalk": "^5.x"
  },
  "devDependencies": {
    "aws-cdk": "^2.x",
    "typescript": "^5.x",
    "@nx/js": "*"
  }
}
```

Note: Match `aws-cdk-lib` and `aws-cdk` (CLI) versions exactly.

---

## Getting Started Sequence

When beginning work:

1. Read all files in `/artifacts/templates/` to understand the config shape
2. Read `libs/docker-utils/src/` to understand existing Docker utilities
3. Read `libs/shared-types/src/` to understand existing shared types
4. Scaffold the directory structure under `/apps/respawn/`
5. Build the config system first (`config/types.ts`, `config/defaults.ts`, `config/loader.ts`)
6. Build the CDK constructs and stacks (including the idle-shutdown sidecar Dockerfile and watchdog script)
7. Build the utilities (`cdk-runner`, `stack-discovery`) — extend `libs/docker-utils` for Docker/ECR operations
8. Build the Clack CLI flow and action handlers
9. Wire up the Nx executor
10. Add `.env` files to `valheim`, `ut99`, and `tfc` based on the template and `GAME_SERVERS_PROMPT.md`
