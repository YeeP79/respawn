# S1 — does the full mod stack build and load together?
#
# Builds the proposed L4D2 BASE image: the five components every modded variant
# would share. Not a service — the spike's artifact. See docs/spikes/S1.md.
#
# The base image symlinks left4dead2/addons -> /addons and left4dead2/cfg -> /cfg,
# so every component here simply layers into /addons.

FROM debian:bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /out

# Pinned deliberately. "latest" here would make a failed boot impossible to
# attribute — the whole point of the spike is knowing which versions loaded.
ARG MM_TGZ=https://mms.alliedmods.net/mmsdrop/2.0/mmsource-2.0.0-git1410-linux.tar.gz
ARG SM_TGZ=https://sm.alliedmods.net/smdrop/1.12/sourcemod-1.12.0-git7251-linux.tar.gz
ARG STRIPPER_TGZ=https://www.bailopan.net/stripper/snapshots/1.2/stripper-1.2.2-hg82-linux.tar.gz
# Left4DHooks publishes no releases or tags, so it is pinned by commit. This one
# is dated 2026-06-18, matching the 1.168 post in its AlliedMods thread.
ARG L4DH_SHA=f90ae5e62228e0b7baf12cda922e3fd40db844f4
# All4Dead2 ships as source only; it needs nothing but stock SourceMod includes.
ARG A4D2_SP=https://raw.githubusercontent.com/AtomicStryker/atomicstrykers-codedump/master/customized/all4dead2.sp

# All three tarballs are rooted at addons/, so they layer over each other.
RUN curl -sfL "${MM_TGZ}"       | tar xz \
 && curl -sfL "${SM_TGZ}"       | tar xz \
 && curl -sfL "${STRIPPER_TGZ}" | tar xz

# Left4DHooks: prebuilt .smx plus its gamedata and data files.
RUN curl -sfL "https://github.com/SilvDev/Left4DHooks/archive/${L4DH_SHA}.tar.gz" \
      | tar xz --strip-components=2 -C addons/sourcemod \
        "Left4DHooks-${L4DH_SHA}/sourcemod/plugins" \
        "Left4DHooks-${L4DH_SHA}/sourcemod/gamedata" \
        "Left4DHooks-${L4DH_SHA}/sourcemod/data"

# All4Dead2 is the MCP's entire director surface, so a compile failure must fail
# the build rather than produce an image that is quietly missing it.
RUN curl -sfL "${A4D2_SP}" -o /tmp/all4dead2.sp \
 && addons/sourcemod/scripting/spcomp64 \
      -i addons/sourcemod/scripting/include \
      /tmp/all4dead2.sp \
      -o addons/sourcemod/plugins/all4dead2.smx \
 && test -f addons/sourcemod/plugins/all4dead2.smx

# Two files are removed, both because they produce load errors on this game.
#
# metamod_x64.vdf points the engine at addons/metamod/bin/linux64/server.so, but
# L4D2's srcds is 32-bit — the engine tries it anyway and logs "wrong ELF class:
# ELFCLASS64" followed by "Unable to load plugin". MetaMod still loads via the
# 32-bit metamod.vdf, so this is noise rather than breakage, but it is noise that
# looks exactly like a real failure in a boot log.
#
# nextmap.smx is a stock SourceMod plugin that refuses this game outright:
# "[SM] Failed to load plugin nextmap.smx: Nextmap is incompatible with this
# game." Standard practice on L4D2 is to drop it. L4D2 handles map rotation
# through mission/mapcycle files rather than nextmap.
RUN rm -f addons/metamod_x64.vdf addons/sourcemod/plugins/nextmap.smx

# Fail the build rather than ship a half-assembled stack.
RUN test -f addons/metamod.vdf \
 && test -f addons/metamod/sourcemod.vdf \
 && test -f addons/metamod/stripper.vdf \
 && test -f addons/sourcemod/plugins/left4dhooks.smx \
 && test -f addons/sourcemod/plugins/all4dead2.smx \
 && test -f addons/sourcemod/gamedata/left4dhooks.l4d2.txt

FROM left4devops/l4d2:latest
COPY --from=build --chown=louis:louis /out/addons/ /addons/
