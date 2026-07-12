# cs16 FFA Deathmatch — modding attempt (not shipped)

This documents an attempt to build a **separate** free-for-all deathmatch image for
cs16 (Metamod + AMX Mod X + CSDM), kept apart from the vanilla server. It is **not
shipped** — it hit a base-image incompatibility. Written up so the next attempt
starts from the conclusion, not from scratch.

> # 🛑 SOLVED — and the conclusion below is WRONG. Read this first.
>
> **The base image is fine. The bug was a FILENAME.**
>
> `jives/hlds` is **not** a custom HLDS build — its Dockerfile is plain SteamCMD
> (`app_update 90`), i.e. stock Valve HLDS. So "this engine refuses a game-DLL swap"
> cannot be right; it is everyone's engine.
>
> The real cause is a Valve engine bug ([halflife#3399](https://github.com/ValveSoftware/halflife/issues/3399)):
> when resolving `gamedll_linux`, the engine **truncates the path at the first `_` and
> appends `.so`**. Metamod-R's release zip contains **only `metamod_i386.so`** — no
> `metamod.so`. The engine therefore mangles the name, `dlopen`s a path that does not
> exist, and dies **before Metamod prints its banner**, with a garbled gamedll path.
>
> That is *precisely* the symptom recorded below — and it explains the most confusing part
> of this writeup: why Metamod-R, Metamod-P, `config.ini` and `+localinfo mm_gamedll` all
> failed **identically**. Every one of those is a *Metamod-level* setting that only takes
> effect **after** Metamod loads. None of them could ever have helped. The "identical
> failure across every fix" was read as evidence of an engine incompatibility; it was
> actually evidence that **Metamod was never being loaded at all**.
>
> ## The fix
>
> Use Metamod **`1.21.1-am`** (https://www.amxmodx.org/release/metamod-1.21.1-am.zip),
> which ships a correctly-named **`metamod.so`**, place it at
> `addons/metamod/dlls/metamod.so`, and point `liblist.gam` at it:
>
> ```
> gamedll       "addons\metamod\dlls\metamod.dll"
> gamedll_linux "addons/metamod/dlls/metamod.so"
> ```
>
> **Verified locally on the untouched `jives/hlds:tfc` base:** `Metamod version 1.21.1-am`
> loads. No ReHLDS, no new base image needed. A live reference doing this on stock HLDS:
> [`LacledesLAN/gamesvr-goldsource-tfc`](https://github.com/LacledesLAN/gamesvr-goldsource-tfc).
>
> Everything below about the **AMX Mod X + CSDM assembly and wiring is still correct and
> reusable** — that part was never the problem. Only the "needs a different base" verdict
> is retracted. The same fix unblocks a modded **TFC** server (AMXX ships a `tfcx` addon).

> **Read this first — the mechanism has changed.** This was written when the only way to
> ship a second build was to swap image tags on the one `cs16` service. cs16 is now a
> **variant project**, so the FFA build is a *sibling service*, not a tag swap: it gets its
> own `apps/cs16/variants/ffa/` (own `.env`, `Dockerfile`, `rcon-manifest.json`),
> `SERVICE_NAME=cs16-ffa`, its own stack and ECR repo — and **vanilla keeps running the
> whole time**. Adding it is purely additive; you never touch `variants/vanilla`.
> The "Goal" below is superseded accordingly. Everything from **The blocker** down still
> stands and is still the thing to solve.

## Goal (superseded — see the note above)

~~A second cs16 image, stored under its own tag in the same ECR repo… switch the running
service to the FFA tag when wanted, switch back to go vanilla.~~ **Now:** a second
*service*, `cs16-ffa`, running CSDM free-for-all (respawns, per-map spawns, `csdm_ffa`)
alongside an untouched vanilla `cs16`. Vanilla CS 1.6 has **no native deathmatch** — it
requires the AMX Mod X + CSDM plugin stack.

## What was assembled (and worked)

Layered onto the cs16 base, staged host-side and `COPY --chown=999:999`'d in:

| Component | Version / source | Notes |
|-----------|------------------|-------|
| AMX Mod X | 1.8.2 base + cstrike, `amxmodx.org` | `.so` modules + `.amxx` plugins |
| CSDM | 2.1.2, `bailopan.net/csdm` | `csdm_amxx_i386.so` + plugins, incl. `csdm_ffa`; per-map spawn/item configs |
| Metamod | Metamod-R 1.3.0.149, then Metamod-P 1.21p37 | see failure below |

Wiring: `modules.ini` (fun, cstrike, csx, engine, fakemeta, hamsandwich, csdm),
`csdm.cfg` with `[ffa] enabled = 1`, metamod `plugins.ini` → AMX Mod X, and
`liblist.gam` `gamedll_linux` → Metamod. The image **builds cleanly** and this
config is correct — the assembly is not the problem.

## ~~The blocker: the base image won't load Metamod~~ (RETRACTED — see the box above)

The cs16 base is **`jives/hlds:cstrike-v1.6.5`** (JamesIves/hlds-docker). Its custom
HLDS build **refuses to load a replacement game DLL** via `liblist.gam`. The moment
`gamedll_linux` points at anything but the stock `dlls/cs.so`, HLDS reads a
**garbled/uninitialized gamedll path** and dies *before Metamod prints its banner*:

```
LoadLibrary failed on <garbage>: cannot open shared object file: No such file or directory
Host_Error: Couldn't get DLL API from <garbage>!
FATAL ERROR (shutting down)
```

Every standard fix produced the **identical** failure, which is what pins it on the
engine rather than the mod:

| Attempt | Result |
|---------|--------|
| Metamod-R 1.3.0.149 (built for ReHLDS) | garbage gamedll → crash |
| Metamod-P 1.21p37 (classic, vanilla-HLDS) | identical crash |
| `config.ini` explicit `gamedll dlls/cs.so` | identical |
| `+localinfo mm_gamedll dlls/cs.so` (Metamod's own documented override) | identical |

Ruled out along the way: the Metamod `.so` is a valid 32-bit ELF with all `ldd`
deps satisfied; the real `dlls/cs.so` (9.9 MB) is present; `liblist.gam` is clean
(no CRLF); `debug.log` carries no reason beyond the crash line. Vanilla
`gamedll_linux "dlls/cs.so"` works — only the swap breaks it.

## Conclusion & recommendation

The stock `jives/hlds` HLDS binary doesn't support the Metamod game-DLL swap that
every AMXX server relies on. **The FFA variant needs a different, mod-capable base**
— most likely a **ReHLDS** image (the modern community HLDS that fully supports
Metamod-R + AMX Mod X + CSDM). Vanilla cs16 stays on `jives/hlds`; only the FFA
image changes base. The AMX Mod X + CSDM assembly and wiring above can be reused
verbatim once Metamod loads.

**Two variants on two different base images is a solved shape here** — `apps/ut99` already
does exactly that (`ut99` = roemer image, `ut99-vanilla` = bymatej image), which is the
precedent to copy. The base-image swap this attempt needs is no longer a structural
problem; it is now a one-directory change.

## How to land it (the drop-in, once Metamod loads)

Everything below is additive. `variants/vanilla` and the live `cs16` service are never
touched, so a failed FFA build cannot take vanilla down.

1. **Create `apps/cs16/variants/ffa/`** with four files:
   - `.env.example` (tracked) and `.env` (gitignored) — start from `variants/vanilla/.env.example`
     and change the identity + image deltas:
     ```
     SERVICE_NAME=cs16-ffa                       # suffix — the bare name is vanilla's
     SERVICE_DISPLAY_NAME="Counter-Strike 1.6 — FFA Deathmatch"
     CONTAINER_COMMAND=+log on +maxplayers 16 +map de_dust2 +sv_lan 0
     SECRET_REFS=RCON_PASSWORD=sm:respawn/cs16-ffa/rcon    # its OWN secret path
     GAME_ENV_SERVERNAME="Respawn CS 1.6 FFA"
     ```
     Shared knobs (ports, CPU, idle, `RCON_PROTOCOL=goldsrc`, AWS) are inherited from
     `apps/cs16/.env` — do **not** repeat them.
   - `Dockerfile` — `FROM` a **ReHLDS** base, then the AMX Mod X + CSDM assembly from the
     table above. Build context is the **repo root**, so `COPY apps/cs16/...` paths (the
     shim is shared: `COPY apps/cs16/respawn-init.sh`).
   - `rcon-manifest.json` — copy vanilla's and add the CSDM/AMXX commands (`csdm_ffa`,
     `amx_*`). Manifests are bundled into the MCP at build; no game redeploy to change one.
2. **Create the secret before the first deploy** — ECS resolves `secrets:` *before* the
   container starts, and CDK only synthesizes an ARN. A referenced-but-absent secret fails
   the task with `ResourceInitializationError`:
   ```bash
   echo -n "$PW" | pnpm respawn --non-interactive --action secrets --service cs16-ffa --secret RCON_PASSWORD
   ```
3. **Add `cs16-ffa` to the `respawn:*` scripts** in the root `package.json` — they hardcode
   an explicit `--service` list and a missing name is skipped **silently**.
4. **Keep the local-run gate** below: `docker build` + `docker run` and grep the startup log
   for the Metamod → AMX Mod X → CSDM chain *before* pushing to ECR.

## Validation method (why nothing broke)

The image was validated **locally** (`docker build` + `docker run`, grepping startup
logs for the Metamod → AMX Mod X → CSDM load chain). It never passed, so it was
**never pushed to ECR and never deployed** — the live vanilla server was untouched
throughout. Any future attempt should keep this local-run gate before pushing.

> Third-party binaries: AMX Mod X, Metamod, and CSDM are community-distributed native
> `.so` files. Pull them only from their canonical sources (amxmodx.org,
> bailopan.net, the Metamod-P/ReHLDS projects), not arbitrary "server pack" repos.
