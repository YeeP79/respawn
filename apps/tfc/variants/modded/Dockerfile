# HLDS Team Fortress Classic — "modded" variant (GoldSrc).
#
# Adds three things the vanilla variant does not have:
#   1. 20 custom skill maps (conc + rocket jump) with their wads/models/sounds
#   2. Metamod + AMX Mod X, which is what provides in-game map VOTING (mapchooser)
#   3. A mapcycle the vote draws from
#
# Build context is the repo root, so COPY paths are repo-relative.

# --- fetch stage -------------------------------------------------------------
# jives/hlds ships no curl/unzip and we do not want them in the runtime image.
# Versions are pinned here rather than floating: this is the only record of what
# the image contains, and a bumped version changes this file, which changes the
# image content hash and forces exactly one rebuild.
FROM debian:bookworm-slim AS fetch
ARG METAMOD_URL=https://www.amxmodx.org/release/metamod-1.21.1-am.zip
# AMX Mod X 1.10.0. NOT 1.8.2: that build is from Feb 2013 and segfaults this HLDS
# (exe build Oct 2024, 10211) a few seconds after AMXX finishes loading — measured
# 2026-08-27 as a crash loop restarting every ~12s, which presents as "the map keeps
# reverting to the boot map" rather than as an obvious crash. 1.10.0 is a pre-release
# tag on GitHub, so it is NOT what the API calls "latest" (that is still 1.9.0.5303);
# pin the build number explicitly.
ARG AMXX_BASE_URL=https://github.com/alliedmodders/amxmodx/releases/download/1.10.0.5479/amxmodx-1.10.0-git5479-base-linux.tar.gz
ARG AMXX_TFC_URL=https://github.com/alliedmodders/amxmodx/releases/download/1.10.0.5479/amxmodx-1.10.0-git5479-tfc-linux.tar.gz
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /out
RUN set -eux; \
    curl -fsSL -o /tmp/metamod.zip "${METAMOD_URL}"; \
    unzip -q /tmp/metamod.zip -d /out; \
    curl -fsSL -o /tmp/amxx-base.tgz "${AMXX_BASE_URL}"; \
    tar xzf /tmp/amxx-base.tgz -C /out; \
    curl -fsSL -o /tmp/amxx-tfc.tgz "${AMXX_TFC_URL}"; \
    tar xzf /tmp/amxx-tfc.tgz -C /out; \
    test -f /out/addons/metamod/dlls/metamod.so; \
    test -f /out/addons/amxmodx/dlls/amxmodx_mm_i386.so; \
    test -f /out/addons/amxmodx/plugins/mapchooser.amxx
# Metamod's own plugin list — this is what actually loads AMX Mod X. Without it
# Metamod loads and does nothing, which looks identical to a working server until
# you notice no plugin responds.
RUN printf 'linux addons/amxmodx/dlls/amxmodx_mm_i386.so\n' \
      > /out/addons/metamod/plugins.ini

# --- runtime -----------------------------------------------------------------
FROM jives/hlds:tfc

USER root

# See apps/tfc/variants/vanilla/Dockerfile: jives/hlds ships /temp/mods and
# /temp/config empty, so the entrypoint's `[ -d ]` guard passes and the rsync of
# an unexpanded glob logs two ERROR lines on every boot.
RUN for d in /temp/mods /temp/config; do \
      [ -d "$d" ] && rmdir --ignore-fail-on-non-empty "$d" || true; \
    done

# Metamod + AMX Mod X. Owned by steam because AMXX writes to logs/ and data/ at
# runtime; a root-owned tree makes the server start and then fail on first write.
COPY --from=fetch --chown=steam:steam /out/addons /opt/steam/hlds/tfc/addons

# GoldSrc loads Metamod by having liblist.gam point at it instead of the game dll.
# Metamod then chain-loads the real tfc.so itself. Rewriting the line in place (not
# appending) matters: the engine takes the FIRST gamedll_linux it finds.
RUN sed -i 's|^gamedll_linux .*|gamedll_linux "addons/metamod/dlls/metamod.so"|' \
      /opt/steam/hlds/tfc/liblist.gam \
 && grep -q 'addons/metamod/dlls/metamod.so' /opt/steam/hlds/tfc/liblist.gam

# Enable AMXX plugins the distribution ships but leaves commented out. Each has its
# required module present in this image (TfcX, Fun), so this is a config change and
# adds nothing third-party:
#   stats          rank / K:D / per-death stats  - needs the TFC module, present
#   statssounds    precache plugin the stats plugins need to play their sounds
#   stats_logging  per-weapon stats logging      - needs the TFC module, present
#   telemenu       teleport menu, admin can move a player - needs Fun, present
# statssounds must be enabled ALONGSIDE stats, not instead of it: it only precaches.
RUN sed -i -E 's#^;(stats|statssounds|stats_logging|telemenu)\.amxx#\1.amxx#' \
      /opt/steam/hlds/tfc/addons/amxmodx/configs/plugins.ini \
 && for p in stats statssounds stats_logging telemenu; do \
      grep -qE "^${p}\.amxx" /opt/steam/hlds/tfc/addons/amxmodx/configs/plugins.ini \
        || { echo "plugin ${p} not enabled"; exit 1; }; \
    done

# Custom map payload — maps/, the six .wad files, models, sprites, sounds, overviews.
# Gitignored (see .gitignore) but present in the Docker build context, so it is still
# covered by the image content hash. Refresh it with `pnpm tfc:content:fetch`.
COPY --chown=steam:steam apps/tfc/variants/modded/content/tfc/ /opt/steam/hlds/tfc/

# The rotations mapchooser can vote from. Generated from maps.txt by
# scripts/generate-mapcycles.sh and tracked, so the build needs no generator. Which one
# is active is GAME_ENV_MAPCYCLE, an env change rather than a rebuild.
COPY --chown=steam:steam apps/tfc/variants/modded/mapcycles/ /opt/steam/hlds/tfc/mapcycles/

COPY apps/_shared/hlds-log-redact.sh /hlds-log-redact.sh
COPY apps/tfc/variants/modded/respawn-init.sh /respawn-init.sh

USER steam

# No `RUN chmod +x`: this image's USER is steam and could not chmod a root-owned
# COPY. Invoking via /bin/sh makes the exec bit unnecessary.
ENTRYPOINT ["/bin/sh", "/respawn-init.sh"]
