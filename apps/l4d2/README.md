# Left 4 Dead 2 (`l4d2`, `l4d2-modded`)

A Source-engine Left 4 Dead 2 server. UDP 27015, scales to zero when empty. Two variants:
a stock upstream image, and a heavily modded build that is drivable by an agent.

## Layout: a variant project

l4d2 is a **variant project** — it is represented only by `variants/*`, never by this
directory. `.env` here is the shared **base**; each variant layers its own on top and wins
on a key collision.

```
apps/l4d2/
  .env / .env.example        # BASE — ports, sizing, idle policy, game defaults
  vendor/                    # hash-pinned Workshop VPKs (gitignored payload)
  mods/                      # mod manifests, one per concern
  plugins/ vscript/          # respawn_director's two halves
  scripts/                   # vendor fetch/publish, local run, workshop snapshot
  variants/
    vanilla/                 # SERVICE_NAME=l4d2         <- upstream image, no build
    modded/                  # SERVICE_NAME=l4d2-modded  <- local build
```

The modded variant takes the **suffixed** name deliberately. `l4d2` belongs to
`variants/vanilla`, and taking the bare name here would read to the shared stack as
deleting that service — which deadlocks every deploy in the fleet (see CLAUDE.md).

## ⚠️ `l4d2-modded` does not deploy to the fleet's account

Every other service inherits the AWS target from the workspace-root `.env.defaults`. This
one overrides all three keys and deploys to the **New Western marketplace-dev** account:

```
AWS_ACCOUNT_ID=679252296174
AWS_REGION=us-east-2
AWS_PROFILE=marketplace-dev--dev
```

`us-east-2` is deliberate — marketplace-dev's us-east-1 is at its VPC quota and
`SharedStack` **creates** a VPC rather than looking one up, so a deploy there fails with
`VpcLimitExceeded`. Secrets are per account **and** per region, so moving regions means
recreating them.

The block ships **commented out** in `.env.example`: a fresh clone must not silently aim at
a corporate account. `.env` is gitignored, so this target reaches no other machine through
git — uncomment it there to take the live server over. All three keys are required
together; `deploy()` preflights `AWS_ACCOUNT_ID` against `sts get-caller-identity` and
refuses a mismatch, which is the guard working.

**`pnpm respawn` cannot deploy this service.** That script hardcodes `--profile respawn`,
and the CLI flag *wins* over the `.env` value (`opts.profile ?? config.aws.profile`), so it
preflights the wrong identity and refuses. Same trap on the Secrets action. Run the CLI
directly:

```bash
npx tsx --conditions development apps/cli/src/index.ts
```

## Setup from a fresh clone

1. **`.env` files** — gitignored, and `stack-discovery.ts` *silently skips* a service
   without one, so a missing `.env` presents as the service not existing:
   ```bash
   cp apps/l4d2/.env.example                 apps/l4d2/.env
   cp apps/l4d2/variants/modded/.env.example apps/l4d2/variants/modded/.env
   ```
2. **Build the MCP** — `.mcp.json` is tracked and points at
   `apps/respawn-mcp/dist/index.mjs`, but that binary and `src/manifests.generated.ts` are
   both gitignored. Without this the MCP server fails to start and every tool is missing,
   which reads as a misconfigured MCP rather than an unbuilt one:
   ```bash
   pnpm install && npx nx build respawn-mcp
   ```
3. **Vendored VPKs** — the Dockerfile fails the build without them, rather than producing a
   server whose bots silently do nothing. They live in the **personal** account's state
   bucket, so this step needs different credentials from the deploy:
   ```bash
   apps/l4d2/scripts/fetch-vendor.sh <state-bucket> <personal-profile>
   ```

## Image: local build, and why the Workshop is vendored

The modded variant builds (`UPDATE_CHECK=build`, no `IMAGE_URI`): the mods, a C++ runtime
swap and `respawn_director` all have to be baked in. ~17 GB uncompressed, ~5.6 GB pushed.

**The Workshop has no version concept** — an author can republish under the same id with no
signal, which collides with content-hash image tags. So a VPK is snapshotted, hashed, and
vendored to the private state bucket; `vendor/workshop.txt` is the tracked pin and a hash
mismatch is a hard failure. Re-pinning is deliberate, and the diff is the review.

## Secrets, and the two very different passwords

```
SECRET_REFS=RCON_PASSWORD=sm:respawn/l4d2-modded/rcon,JOIN_PASSWORD=sm:respawn/l4d2-modded/join-pw
```

`JOIN_PASSWORD` is `sv_password` — the only thing that actually keeps strangers out, and
required because this build sits in a shared corporate account behind a `0.0.0.0/0` ingress
rule on 27015/udp. Being unlisted hides the server; it authenticates nobody.

Neither may be a `GAME_ENV_` value: `loader.ts`'s credential heuristic rejects the name, and
it would land in the task definition in plaintext. `respawn-init.sh` writes `sv_password`
into a cfg that `server.cfg` execs, from the injected secret.

**They are not equally protected.** The upstream entrypoint puts the rcon password on the
srcds command line, so it is visible in `ps` *inside* the container — upstream behaviour,
shared with the vanilla variant. `sv_password` never touches argv.

**Do not read `sv_password` back over rcon.** Source echoes rcon output to the console and
`source-logship.sh` ships the console to CloudWatch, so that one query writes the password
into the log group this whole arrangement exists to keep it out of. Read it from Secrets
Manager instead.

A password containing a `"` or a newline **fails the container on purpose**. It cannot be
expressed in a cfg value: `p@ss word"tricky` writes `sv_password "p@ss word"tricky"`, which
Source reads as `p@ss word` — the server then rejects the real password, nobody can join,
and nothing names the cvar, the file or the secret. An *absent* value is caught at deploy
time by `REQUIRED_ENV_VARS`; a malformed one passes every deploy-time check there is.

## Joining

Direct console `connect <ip>` only — there is no lobby path.
`sv_allow_lobby_connect_only 0` (in `GAME_ENV_EXTRA_ARGS`) is what makes that work; it
defaults to 1 and refuses direct connects outright, which is a server nobody can join while
every health check stays green. Players set `password "<value>"` first.

**The public IP is ephemeral** — no Route53 record, no Elastic IP, so it changes on every
task replacement. Combined with idle shutdown (30 minutes), the address differs most
sessions; read it from `server_health`. Idle is measured by A2S query, not netstat: UDP
games serve every client from one socket, so netstat always reports zero however many are
playing. A failed probe returns -1 and **holds** the timer rather than killing a populated
server.

## Slots: coop past 4

Stock coop is capped at 4. `GAME_ENV_MAX_PLAYERS` raises it — read at **runtime** by
`respawn-init.sh`, which writes `sv_maxplayers` and `sv_visiblemaxplayers` into a cfg
`server.cfg` execs. So the number is a task-definition change and a restart, **not** a
rebuild.

The machinery — L4DToolZ, `l4dmultislots`, and a repair tail of plugins fixing things that
assume four survivors — is **inert** at four players, byte-identical to base. None of it
does anything until the cvar is set.

- **L4DToolZ never appears in `meta list`.** It registers via `addons/l4dtoolz.vdf`, the
  engine's server-plugin loader, *below* Metamod. Use `plugin_print`. Reading its absence
  from `meta list` as a half-loaded stack has already produced one wrong conclusion here.
- **`sv_setmax` is the real ceiling** (engine max *clients*, default 18) and is deliberately
  unset — 18 already covers 8 humans plus the survivor bots filling empty slots. Raising
  `sv_maxplayers` past it advertises slots the engine cannot seat, and that surfaces as
  players failing to connect, nowhere near the cvar that caused it. Ceiling 31; above that
  crashes.

## The MCP control surface

`rcon-manifest.json` is the entire control surface — the MCP contains no game-specific
logic, it runs what the manifest declares. 17 commands, 5 queries, 24 cvars. Start with
`get_server_options`.

**All4Dead2's commands split three ways by whether they need a player, and it is not
guessable from what a command does:**

| Class | Commands | Behaviour |
|---|---|---|
| Cvar path | `force_tank` `force_witch` `panic_forever` `continuous_bosses` `add_zombies` `reset_director` | Work **always**, including on an empty server |
| Client path | `force_panic` `spawn_infected` | Need somebody connected; a bot counts. Empty → `Client index 0 is invalid` |
| Impossible over rcon | `spawn_item` `spawn_weapon` | Absent on purpose — `give` refuses a console caller at **any** population |

`force_panic` is client-path while `force_tank` and `force_witch` are not, which is the
counter-intuitive part. The third class needs a client *calling*, not a client *present* —
`Console<0>` has no crosshair, so no number of players fixes it. `give_item`
(`sm_rd_give`) exists precisely because of that.

**Every director cvar is `FCVAR_CHEAT`.** The plain set path is refused with "Can't use
cheat cvar ..." and changes nothing, so each carries an explicit `sm_cvar` template.
Setting one by hand over raw `rcon` needs `sm_cvar <name> "<value>"`.

## ⚠️ Live rcon changes are ephemeral — with one exception

**A map change reverts every director cvar to stock.** `a4d_reset_to_defaults` does *not* —
it resets only the cvars All4Dead2 itself changed, leaving e.g. `z_minion_limit` where you
put it.

**The player cap is the exception**, and its lifecycle is the opposite. It lives in a cfg
that `server.cfg` execs, and `server.cfg` re-execs on every map change — so the cap survives
a map change and is instead undone by a task restart. Setting `sv_maxplayers` over rcon
changes the running server only; to change it durably, edit `.env` and redeploy.

## ⚠️ Editing the manifest requires a rebuild

`rcon-manifest.json` is not read at runtime. `generate-manifests.mjs` writes
`apps/respawn-mcp/src/manifests.generated.ts`, which is **compiled into `dist/index.mjs`**.

```bash
npx nx build respawn-mcp    # runs generate-manifests itself (build dependsOn it)
/mcp                        # reconnect the MCP server
```

Reconnecting *without* rebuilding changes nothing, and the symptom is that your corrected
command still returns the old error — which reads as "the fix did not work" rather than
"the fix was never compiled", and sends you back to re-edit a manifest that was already
correct. Settle it with
`grep -c '<your new rcon template>' apps/respawn-mcp/dist/index.mjs`.

## Two habits this codebase earned the hard way

- **"Success" is the thing to distrust.** S16 found four defects that all returned OK for
  something that never happened. A reply of "executed" is not evidence — read `server_logs`
  or re-query state.
- **Never test whether a command exists by running it.** Probing All4Dead2's twelve is what
  produced the conclusions S2 later had to correct.

## Reference

- `docs/spikes/S2.md` — the director surface, and the three-class split corrected against a
  live human player
- `docs/spikes/S11.md`–`S15.md` — the mod stack, slot machinery, C++ runtime swap
- `docs/spikes/S16.md` — the agent loop with a real player, and the four silent failures
- `apps/l4d2/mods/README.md` — the mod manifests
- `docs/l4d2-agent-ambitions.md` — where the agent bridge is going
