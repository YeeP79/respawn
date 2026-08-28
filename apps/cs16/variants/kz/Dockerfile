# HLDS Counter-Strike 1.6 — "kz" variant: Kreedz climbing / bhop (GoldSrc).
#
# A climbing server: players race timed obstacle courses. Shares the modded stack with
# variants/dm (Metamod + AMX Mod X + ReGameDLL) but configures the opposite game — no
# deathmatch respawn, no round end, movement tuned for jumping.
#
# Adds two modules over the dm variant, both verified loading on this stack 2026-08-28:
#   ReAPI          the stable ReGameDLL API. KZ timers hook movement and teleport
#                  players precisely; the alternative is sigscanning, which is exactly
#                  what killed CSDM (see apps/cs16/FFA-DEATHMATCH.md).
#   AmxxEasyHttp   HTTP from inside a plugin — how a timer posts records to a global
#                  leaderboard rather than only a local one.
# NOTE ReAPI needs ReGameDLL only, NOT ReHLDS. That was worth testing: ReSemiclip, from
# the same org, refuses to attach here because it does want ReHLDS.
#
# Build context is the repo root, so COPY paths are repo-relative.

FROM debian:bookworm-slim AS fetch
# Metamod 1.21.1-am ships a correctly-named metamod.so. Load-bearing: the Valve engine
# truncates gamedll_linux at the first `_` (ValveSoftware/halflife#3399), so a build
# shipping only metamod_i386.so is never loaded and dies before printing a banner.
ARG METAMOD_URL=https://www.amxmodx.org/release/metamod-1.21.1-am.zip
# 1.10.0, NOT 1.8.2 — the 2013 build segfaults this HLDS in a ~12s crash loop that
# presents as "the map keeps reverting to the boot map". 1.10.0 is a GitHub PRE-release,
# so it is not what the API calls "latest".
ARG AMXX_BASE_URL=https://github.com/alliedmodders/amxmodx/releases/download/1.10.0.5479/amxmodx-1.10.0-git5479-base-linux.tar.gz
ARG AMXX_CSTRIKE_URL=https://github.com/alliedmodders/amxmodx/releases/download/1.10.0.5479/amxmodx-1.10.0-git5479-cstrike-linux.tar.gz
ARG REGAMEDLL_URL=https://github.com/rehlds/ReGameDLL_CS/releases/download/5.30.0.814/regamedll-bin-5.30.0.814.zip
ARG REAPI_URL=https://github.com/rehlds/ReAPI/releases/download/5.29.0.358/reapi-bin-5.29.0.358.zip
ARG EASYHTTP_URL=https://github.com/Next21Team/AmxxEasyHttp/releases/download/1.5.0/AmxxEasyHttp-1.5.0-linux-i386.zip
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /out
RUN set -eux; \
    curl -fsSL -o /tmp/mm.zip   "${METAMOD_URL}";       unzip -q /tmp/mm.zip -d /out; \
    curl -fsSL -o /tmp/b.tgz    "${AMXX_BASE_URL}";     tar xzf /tmp/b.tgz -C /out; \
    curl -fsSL -o /tmp/c.tgz    "${AMXX_CSTRIKE_URL}";  tar xzf /tmp/c.tgz -C /out; \
    curl -fsSL -o /tmp/re.zip   "${REAPI_URL}";         unzip -qo /tmp/re.zip -d /out; \
    curl -fsSL -o /tmp/eh.zip   "${EASYHTTP_URL}";      unzip -qo /tmp/eh.zip -d /out; \
    mkdir -p /rg; curl -fsSL -o /tmp/rg.zip "${REGAMEDLL_URL}"; unzip -qo /tmp/rg.zip -d /rg; \
    test -f /out/addons/metamod/dlls/metamod.so; \
    test -f /out/addons/amxmodx/dlls/amxmodx_mm_i386.so; \
    test -f /out/addons/amxmodx/modules/reapi_amxx_i386.so; \
    test -f /out/addons/amxmodx/modules/easy_http_amxx_i386.so; \
    test -f /rg/bin/linux32/cstrike/dlls/cs.so
RUN printf 'linux addons/amxmodx/dlls/amxmodx_mm_i386.so\n' > /out/addons/metamod/plugins.ini

FROM jives/hlds:cstrike
USER root

# See variants/vanilla/Dockerfile: the image ships /temp/mods and /temp/config empty, so
# the entrypoint's `[ -d ]` guard passes and rsync fails on the unexpanded glob.
RUN for d in /temp/mods /temp/config; do \
      [ -d "$d" ] && rmdir --ignore-fail-on-non-empty "$d" || true; \
    done

COPY --from=fetch --chown=steam:steam /out/addons /opt/steam/hlds/cstrike/addons
COPY --from=fetch --chown=steam:steam /rg/bin/linux32/cstrike/dlls/cs.so /opt/steam/hlds/cstrike/dlls/cs.so
COPY --from=fetch --chown=steam:steam /rg/bin/linux32/cstrike/game.cfg /opt/steam/hlds/cstrike/game.cfg
COPY --from=fetch --chown=steam:steam /rg/bin/linux32/cstrike/game_init.cfg /opt/steam/hlds/cstrike/game_init.cfg

RUN sed -i 's|^gamedll_linux .*|gamedll_linux "addons/metamod/dlls/metamod.so"|' \
      /opt/steam/hlds/cstrike/liblist.gam \
 && grep -q 'addons/metamod/dlls/metamod.so' /opt/steam/hlds/cstrike/liblist.gam

# Force-load both new modules. AMXX only loads a module some plugin requires, so
# without this they sit on disk unused until the timer plugin lands — and a module that
# silently never loads is indistinguishable from one that cannot.
RUN printf 'reapi\neasy_http\n' >> /opt/steam/hlds/cstrike/addons/amxmodx/configs/modules.ini

# Shipped-but-disabled AMXX plugins whose module is present in this image.
RUN sed -i -E 's#^;(miscstats|telemenu|stats_logging)\.amxx#\1.amxx#' \
      /opt/steam/hlds/cstrike/addons/amxmodx/configs/plugins.ini \
 && for p in miscstats telemenu stats_logging statsx; do \
      grep -qE "^${p}\.amxx" /opt/steam/hlds/cstrike/addons/amxmodx/configs/plugins.ini \
        || { echo "plugin ${p} not enabled"; exit 1; }; \
    done

# Map payload. NOTE these archives are CONTENT-rooted (maps/, sprites/, gfx/, models/,
# sound/), unlike tfc's which are tfc/-rooted — so the target is the game dir itself.
# They ship no .wad: KZ maps use stock CS textures.
COPY --chown=steam:steam apps/cs16/variants/kz/content/ /opt/steam/hlds/cstrike/
COPY --chown=steam:steam apps/cs16/variants/kz/mapcycles/ /opt/steam/hlds/cstrike/mapcycles/
COPY apps/cs16/variants/kz/respawn-init.sh /respawn-init.sh

USER steam
ENTRYPOINT ["/bin/sh", "/respawn-init.sh"]
