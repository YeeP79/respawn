# cs16 FFA Deathmatch — modding attempt (not shipped)

This documents an attempt to build a **separate** free-for-all deathmatch image for
cs16 (Metamod + AMX Mod X + CSDM), kept apart from the vanilla server. It is **not
shipped** — it hit a base-image incompatibility. Written up so the next attempt
starts from the conclusion, not from scratch.

## Goal

A second cs16 image, stored under its own tag in the same ECR repo, that runs CSDM
free-for-all (respawns, per-map spawns, `csdm_ffa`). Vanilla cs16 unchanged; switch
the running service to the FFA tag when wanted, switch back to go vanilla. Vanilla
CS 1.6 has **no native deathmatch** — it requires the AMX Mod X + CSDM plugin stack.

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

## The blocker: the base image won't load Metamod

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

## Validation method (why nothing broke)

The image was validated **locally** (`docker build` + `docker run`, grepping startup
logs for the Metamod → AMX Mod X → CSDM load chain). It never passed, so it was
**never pushed to ECR and never deployed** — the live vanilla server was untouched
throughout. Any future attempt should keep this local-run gate before pushing.

> Third-party binaries: AMX Mod X, Metamod, and CSDM are community-distributed native
> `.so` files. Pull them only from their canonical sources (amxmodx.org,
> bailopan.net, the Metamod-P/ReHLDS projects), not arbitrary "server pack" repos.
