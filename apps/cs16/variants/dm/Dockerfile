# HLDS Counter-Strike 1.6 — "dm" variant: free-for-all deathmatch (GoldSrc).
#
# Vanilla CS 1.6 has no deathmatch. This build gets it by replacing Valve's game
# DLL with ReGameDLL_CS, which provides respawn, random spawns and spawn protection
# as NATIVE CVARS — so there is no deathmatch plugin here at all.
#
# WHY NOT CSDM, the usual answer: CSDM 2.1.2 (Oct 2008) is broken on current HLDS
# and cannot be fixed by version juggling. Measured 2026-08-27 on this exact base:
#
#   [CSDM2] ERROR: Sig line 110 (csdm_util.cpp) failed, contact author!
#   [CSDM2] CSDM failed to load, contact author...
#   [AMXX] "csdm_main.amxx" failed: unknown function (name "csdm_respawn")
#
# The module LOADS fine under AMXX 1.10 — it then sigscans cs.so for hardcoded byte
# patterns to hook, and Valve has rebuilt that binary since 2008, so every pattern
# misses and CSDM disables itself. ReGameDLL is the fix for precisely this: a stable
# API instead of sigscanning. See apps/cs16/FFA-DEATHMATCH.md for the earlier attempt.
#
# Build context is the repo root, so COPY paths are repo-relative.

# --- fetch stage -------------------------------------------------------------
# Versions pinned deliberately; a bump changes this file, which changes the image
# content hash and forces exactly one rebuild.
FROM debian:bookworm-slim AS fetch
# Metamod 1.21.1-am ships a correctly-named metamod.so. This is load-bearing: the
# Valve engine truncates gamedll_linux at the first `_` and appends `.so`
# (ValveSoftware/halflife#3399), so a build shipping only `metamod_i386.so` is never
# loaded at all and dies before printing its banner. That cost a previous attempt.
ARG METAMOD_URL=https://www.amxmodx.org/release/metamod-1.21.1-am.zip
# AMX Mod X 1.10.0, NOT 1.8.2: the 2013 build segfaults modern HLDS in a ~12s crash
# loop that presents as "the map keeps reverting to the boot map". 1.10.0 is a
# GitHub PRE-release, so it is not what the API calls "latest" (that is 1.9.0.5303).
ARG AMXX_BASE_URL=https://github.com/alliedmodders/amxmodx/releases/download/1.10.0.5479/amxmodx-1.10.0-git5479-base-linux.tar.gz
ARG AMXX_CSTRIKE_URL=https://github.com/alliedmodders/amxmodx/releases/download/1.10.0.5479/amxmodx-1.10.0-git5479-cstrike-linux.tar.gz
# ReGameDLL_CS — reverse-engineered replacement for cstrike/dlls/cs.so. It is the
# GAME DLL, not the engine; it needs no ReHLDS and runs on stock HLDS (verified).
ARG REGAMEDLL_URL=https://github.com/rehlds/ReGameDLL_CS/releases/download/5.30.0.814/regamedll-bin-5.30.0.814.zip
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /out
RUN set -eux; \
    curl -fsSL -o /tmp/metamod.zip "${METAMOD_URL}"; unzip -q /tmp/metamod.zip -d /out; \
    curl -fsSL -o /tmp/amxx-base.tgz "${AMXX_BASE_URL}"; tar xzf /tmp/amxx-base.tgz -C /out; \
    curl -fsSL -o /tmp/amxx-cs.tgz "${AMXX_CSTRIKE_URL}"; tar xzf /tmp/amxx-cs.tgz -C /out; \
    mkdir -p /rg; curl -fsSL -o /tmp/rg.zip "${REGAMEDLL_URL}"; unzip -qo /tmp/rg.zip -d /rg; \
    test -f /out/addons/metamod/dlls/metamod.so; \
    test -f /out/addons/amxmodx/dlls/amxmodx_mm_i386.so; \
    test -f /out/addons/amxmodx/plugins/mapchooser.amxx; \
    test -f /rg/bin/linux32/cstrike/dlls/cs.so
# Metamod's plugin list — this is what loads AMX Mod X. Without it Metamod loads and
# does nothing, which looks like a healthy server on which no plugin responds.
RUN printf 'linux addons/amxmodx/dlls/amxmodx_mm_i386.so\n' \
      > /out/addons/metamod/plugins.ini

# --- runtime -----------------------------------------------------------------
FROM jives/hlds:cstrike

USER root

# See variants/vanilla/Dockerfile: the image ships /temp/mods and /temp/config empty,
# so the entrypoint's `[ -d ]` guard passes and rsync fails on the unexpanded glob,
# logging two ERROR lines every boot.
RUN for d in /temp/mods /temp/config; do \
      [ -d "$d" ] && rmdir --ignore-fail-on-non-empty "$d" || true; \
    done

# Metamod + AMX Mod X. steam-owned because AMXX writes logs/ and data/ at runtime.
COPY --from=fetch --chown=steam:steam /out/addons /opt/steam/hlds/cstrike/addons

# The one binary swap. game.cfg/game_init.cfg are ReGameDLL's own and are execed by it.
COPY --from=fetch --chown=steam:steam /rg/bin/linux32/cstrike/dlls/cs.so /opt/steam/hlds/cstrike/dlls/cs.so
COPY --from=fetch --chown=steam:steam /rg/bin/linux32/cstrike/game.cfg /opt/steam/hlds/cstrike/game.cfg
COPY --from=fetch --chown=steam:steam /rg/bin/linux32/cstrike/game_init.cfg /opt/steam/hlds/cstrike/game_init.cfg

# Point the engine at Metamod, which chain-loads the real (now ReGameDLL) cs.so.
# Rewrite in place, not append: the engine takes the FIRST gamedll_linux it finds.
RUN sed -i 's|^gamedll_linux .*|gamedll_linux "addons/metamod/dlls/metamod.so"|' \
      /opt/steam/hlds/cstrike/liblist.gam \
 && grep -q 'addons/metamod/dlls/metamod.so' /opt/steam/hlds/cstrike/liblist.gam

# Enable AMXX plugins the distribution ships but leaves commented out. All four have
# their required module present in this image (Fun, CSX), so this is a config change,
# not a download — and nothing third-party is added:
#   miscstats      kill-streak / headshot / event announcements
#   restmenu       weapon restriction menu
#   telemenu       teleport menu (admin can move a player) - needs Fun, present
#   stats_logging  per-weapon stats logging - needs CSX, present
# statsx.amxx (rank/K:D/HUD, "Stats Extended") is already enabled upstream and its CSX
# module ships, so it needs nothing here; verified loading 2026-08-28.
RUN sed -i -E 's#^;(miscstats|restmenu|telemenu|stats_logging)\.amxx#\1.amxx#' \
      /opt/steam/hlds/cstrike/addons/amxmodx/configs/plugins.ini \
 && for p in miscstats restmenu telemenu stats_logging statsx; do \
      grep -qE "^${p}\.amxx" /opt/steam/hlds/cstrike/addons/amxmodx/configs/plugins.ini \
        || { echo "plugin ${p} not enabled"; exit 1; }; \
    done

COPY apps/cs16/variants/dm/respawn-init.sh /respawn-init.sh

USER steam

ENTRYPOINT ["/bin/sh", "/respawn-init.sh"]
