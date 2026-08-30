# --- Respawn: Left 4 Dead 2 — MODDED variant -----------------------------------
#
# The build S15 measured, assembled in one file. Everything here was run before it was
# written down; the spike each fact came from is named beside it.
#
# BUILD CONTEXT IS THE REPO ROOT (deploy.ts passes workspaceRoot), so every COPY path is
# repo-relative.
#
# Four things layer onto the upstream image, in this order, because each one's failure
# has to be attributable to itself:
#
#   1. the C++ runtime swap        so the crash reporter can load at all     (S13)
#   2. our platform pins           MetaMod/SourceMod/Left4DHooks              (S15)
#   3. the curated plugin pack     the other ~40 entries                      (S11)
#   4. our own content             the VScript VPKs and respawn_director      (S10, S12)
#
# The pack goes on AFTER the runtime and BEFORE our platform, so a pack that ships an
# older SourceMod cannot overwrite the pins we chose.

# ============================================================================
# stage: platform — our pins, not the pack's
# ============================================================================
FROM debian:bookworm-slim AS platform
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /out

# Pinned deliberately and identically to apps/l4d2/mods/mods-platform.txt. "latest" here
# would make a failed boot impossible to attribute, which is the whole reason S1 existed.
ARG MM_TGZ=https://mms.alliedmods.net/mmsdrop/2.0/mmsource-2.0.0-git1410-linux.tar.gz
ARG SM_TGZ=https://sm.alliedmods.net/smdrop/1.12/sourcemod-1.12.0-git7251-linux.tar.gz
ARG STRIPPER_TGZ=https://www.bailopan.net/stripper/snapshots/1.2/stripper-1.2.2-hg82-linux.tar.gz
# Left4DHooks publishes no releases or tags, so it is pinned by commit. Dated 2026-06-18,
# matching the 1.168 post in its AlliedMods thread; verified live as left4dhooks_version 1.168.
ARG L4DH_SHA=f90ae5e62228e0b7baf12cda922e3fd40db844f4

# All three tarballs are rooted at addons/, so they layer over each other.
RUN curl -sfL "${MM_TGZ}"       | tar xz \
 && curl -sfL "${SM_TGZ}"       | tar xz \
 && curl -sfL "${STRIPPER_TGZ}" | tar xz

# scripting/include is NOT optional decoration: respawn_director compiles against
# left4dhooks.inc, and without it this image can RUN Left4DHooks but not build the plugin
# that uses it. Found the hard way in S1.
RUN curl -sfL "https://github.com/SilvDev/Left4DHooks/archive/${L4DH_SHA}.tar.gz" \
      | tar xz --strip-components=2 -C addons/sourcemod \
        "Left4DHooks-${L4DH_SHA}/sourcemod/plugins" \
        "Left4DHooks-${L4DH_SHA}/sourcemod/gamedata" \
        "Left4DHooks-${L4DH_SHA}/sourcemod/data" \
        "Left4DHooks-${L4DH_SHA}/sourcemod/scripting/include"

# ============================================================================
# stage: pack — the ~40 plugins nobody can fetch individually
# ============================================================================
# Second-hand and knowingly so. Half of apps/l4d2/mods/'s entries are AlliedMods forum
# attachments with no stable download URL, so a per-plugin fetcher would fail on the
# majority of them (S11). PINNED TO A COMMIT rather than cloned from a branch — an
# unpinned pack is exactly the moving target the Workshop vendoring exists to remove.
FROM debian:bookworm-slim AS pack
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /out
ARG PACK_SHA=cc640c67a4cf9bb95c389582ec5cdce60c4bcea3
# The tarball roots at <repo>-<sha>/left4dead2/, so two components come off and only that
# subtree is taken — the repo also carries a Dockerfile, compose file and installer
# scripts that have nothing to do with what a server loads.
RUN curl -sfL "https://github.com/SNWCreations/l4d2-modded-server/archive/${PACK_SHA}.tar.gz" \
      | tar xz --strip-components=2 "l4d2-modded-server-${PACK_SHA}/left4dead2" \
 && test -d addons/sourcemod/plugins \
 && test -d cfg

# ============================================================================
# stage: runtime — the game, with a C++ runtime new enough for Accelerator
# ============================================================================
FROM left4devops/l4d2:latest

USER root

# --- 1. the C++ runtime swap (S13) ------------------------------------------
#
# Accelerator is the crash reporter and it does not load on the stock image:
#   [SM] Unable to load extension "accelerator.ext":
#        bin/libstdc++.so.6: version `GLIBCXX_3.4.21' not found
# SourceMod carries on, so the server looks healthy while the one component whose job is
# explaining an unexplained death is silently absent.
#
# It needs GLIBCXX_3.4.29 (GCC 11); the game bundles GLIBCXX <= 3.4.16 (GCC 4.7). No
# older Accelerator build closes thirteen minor versions, so the library is replaced.
#
# THE PAIRING IS NOT ARBITRARY AND MUST NOT BE "SIMPLIFIED" TO ONE DISTRO:
#   - Rocky 9's libstdc++ 11.5.0 fits (GLIBCXX_3.4.29, GLIBC <= 2.34)
#   - Rocky 9's own libgcc.i686 DOES NOT WORK ON ROCKY 9 — baseos ships exactly one, and
#     it references _dl_find_object@GLIBC_2.35 while RHEL 9 is pinned at glibc 2.34.
#     Debian bookworm's libgcc has the same floor. Both were measured; both fail before
#     the game starts.
#   - Debian bullseye's libgcc-s1 10.2.1 is the one that works: new enough for GCC_7.0.0
#     (which the replacement libstdc++ needs — Accelerator itself only wants GCC_3.0),
#     old enough to predate glibc 2.35.
#
# Both originals are kept as *.valve, so if the swap is ever implicated in a crash the
# rollback is one `mv` and does not need this image rebuilt.
ARG LIBGCC_URL=http://deb.debian.org/debian/pool/main/g/gcc-10/libgcc-s1_10.2.1-6_i386.deb
ARG LIBGCC_SHA256=0a52edec5d626f8d9acf1998248d276760aff3950f44a308d27d4a2a488fe18d
RUN set -eux; \
    microdnf install -y --nodocs cpio binutils tar xz; \
    cd /tmp; \
    microdnf download libstdc++.i686; \
    mkdir -p /tmp/x /tmp/d; \
    rpm2cpio /tmp/libstdc++-*.i686.rpm | (cd /tmp/x && cpio -idm); \
    test -e /tmp/x/usr/lib/libstdc++.so.6; \
    curl -fsSLo /tmp/libgcc.deb "$LIBGCC_URL"; \
    echo "$LIBGCC_SHA256  /tmp/libgcc.deb" | sha256sum -c -; \
    (cd /tmp/d && ar x /tmp/libgcc.deb && tar -xf data.tar.*); \
    test -e /tmp/d/lib/i386-linux-gnu/libgcc_s.so.1; \
    for f in libstdc++.so.6 libgcc_s.so.1; do \
      mv "/home/louis/l4d2/bin/$f" "/home/louis/l4d2/bin/$f.valve"; \
    done; \
    cp -a  /tmp/x/usr/lib/libstdc++.so.6* /home/louis/l4d2/bin/; \
    cp -aL /tmp/d/lib/i386-linux-gnu/libgcc_s.so.1 /home/louis/l4d2/bin/libgcc_s.so.1; \
    rm -rf /tmp/x /tmp/d /tmp/*.rpm /tmp/*.deb; \
    microdnf clean all

# --- 2. the pack, then 3. our platform over it ------------------------------
# The base image symlinks left4dead2/addons -> /addons and left4dead2/cfg -> /cfg.
COPY --from=pack     /out/addons/ /addons/
COPY --from=pack     /out/cfg/    /cfg/
COPY --from=platform /out/addons/ /addons/

# S1 measured both of these failing to load on THIS game, and the pack ships them anyway.
# A boot log full of errors that look real makes a genuine failure impossible to spot,
# which matters more here than the two plugins do.
#   metamod_x64*.vdf  -> "wrong ELF class: ELFCLASS64" (L4D2's srcds is 32-bit)
#   nextmap.smx       -> "Nextmap is incompatible with this game"
RUN rm -f /addons/metamod_x64.vdf /addons/metamod_x64.linux.vdf /addons/metamod_x64.win.vdf \
          /addons/sourcemod/plugins/nextmap.smx

# --- 4. our own content -----------------------------------------------------
#
# The three VScript VPKs, vendored and hash-pinned. The Workshop has no version concept
# and an author can republish under the same id with no signal, so the bytes live in the
# private state bucket and vendor/workshop.txt is the pin. Rebuild the payload with:
#     apps/l4d2/scripts/fetch-vendor.sh <state-bucket> <profile>
# A missing payload fails the build here rather than producing a server whose bots
# silently do nothing.
COPY apps/l4d2/vendor/vpk/ /addons/
RUN test -e /addons/3022416274.vpk \
 && test -e /addons/2634208272.vpk \
 && test -e /addons/3226661388.vpk

# All4Dead2 — the director surface the MCP drives. Built from source and pinned, and it
# REPLACES the pack's copy, which is a different plugin wearing the same file name.
#
# S11 diffed them live: the pack ships fbef0102's "All4Dead" 3.9 with 7 usable commands,
# AtomicStryker's has 12. The five missing ones are force_tank, force_witch, add_zombies,
# continuous_bosses and — the one that matters — reset_to_defaults, the single-call undo
# for the two commands S2 marked dangerous. Popularity and commit count are not a command
# surface; the only way to know was to diff them.
#
# Pinned to the last commit that touched THIS FILE rather than repo HEAD: it lives in
# atomicstrykers-codedump, a dump repo that churns constantly for unrelated plugins.
# Measured 2026-08-30 — exactly one commit has ever touched it, in 2011.
ARG A4D2_SHA=507cd07f8ea2d5ff7145ac03ce64287d0cdd08a3
ARG A4D2_SHA256=f83c7e3691f9a4eac72ab269c3a6c4e026e09aa37cb532f64595457d2f8055fc
# The chat prefix players see on every director event. Upstream is "[A4D] ", which names
# a plugin nobody on the server has heard of; these events are driven by the agent, so
# the agent is the honest author. One #define, patched before compiling because the
# plugin ships as source anyway — there is no upstream artifact to diverge from.
ARG A4D2_TAG="[Claude] "
RUN set -eux; \
    curl -sfL "https://raw.githubusercontent.com/AtomicStryker/atomicstrykers-codedump/${A4D2_SHA}/customized/all4dead2.sp" \
      -o /tmp/all4dead2.sp; \
    echo "${A4D2_SHA256}  /tmp/all4dead2.sp" | sha256sum -c -; \
    sed -i "s|#define PLUGIN_TAG.*|#define PLUGIN_TAG \t\t\t\t\t\"${A4D2_TAG}\"|" /tmp/all4dead2.sp; \
    grep -qF "\"${A4D2_TAG}\"" /tmp/all4dead2.sp; \
    cd /home/louis/l4d2/left4dead2/addons/sourcemod/scripting; \
    chmod +x ./spcomp64; \
    ./spcomp64 -i include /tmp/all4dead2.sp -o /addons/sourcemod/plugins/all4dead2.smx; \
    test -f /addons/sourcemod/plugins/all4dead2.smx; \
    rm -f /tmp/all4dead2.sp

# respawn_director — the agent's bridge. Compiled HERE, against this image's own
# spcomp64 and include tree, so the compiler and the includes are the same ones the
# server runs. A plugin built against a different SourceMod can load and then misbehave
# in ways nothing reports.
#
# A compile failure must fail the build: this plugin is the entire agent surface, and an
# image quietly missing it is a server that answers every order with "Unknown command".
COPY apps/l4d2/plugins/respawn_director.sp /tmp/respawn_director.sp
RUN cd /home/louis/l4d2/left4dead2/addons/sourcemod/scripting \
 && chmod +x ./spcomp64 \
 && ./spcomp64 -i include /tmp/respawn_director.sp \
      -o /addons/sourcemod/plugins/respawn_director.smx \
 && test -f /addons/sourcemod/plugins/respawn_director.smx \
 && rm -f /tmp/respawn_director.sp

# Ship the game logs and SourceMod's own log to stdout, so CloudWatch carries them.
# SourceMod logs a failed extension to a FILE and carries on — without this the S13
# failure, and every one like it, is invisible on a healthy-looking server.
COPY apps/_shared/source-logship.sh /logship.sh

RUN chown -R louis:louis /addons /cfg /home/louis/l4d2/bin && chmod +x /logship.sh
USER louis

# The upstream entrypoint takes its configuration from env vars; the shipper wraps it
# rather than replacing it. It must NOT be `exec srcds | sed`: that makes the shell PID 1
# and hands the container sed's exit status, and server_health reads that status to tell
# a normal stop from an OOM kill.
ENTRYPOINT ["/bin/sh", "/logship.sh", "/home/louis/l4d2/left4dead2", "./entrypoint.sh"]
