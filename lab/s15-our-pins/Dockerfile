# S15 — does the stack still load with OUR pins instead of the pack's?
#
# S11 proved 49 of 50 plugins co-exist, but the payload was SNWCreations' curated pack,
# so what it proved is that THE PACK'S versions co-exist. Ours are newer everywhere they
# overlap and have never been loaded together:
#
#              pack (S11)          ours (mods-platform.txt)
#   MetaMod    2.0.0-dev+1380      2.0.0-git1410
#   SourceMod  1.12.0.7221         1.12.0-git7251
#   Left4DHooks 1.161              f90ae5e6 (1.168)
#
# The platform is layered OVER the pack's tree rather than the whole stack being rebuilt
# from scratch: half the manifest's 43 entries are AlliedMods forum attachments with no
# stable download URL, so a per-plugin fetcher would fail on the majority (the same
# reason S11 used the pack at all). Layering isolates the variable to the three pieces
# whose versions are actually in question.
#
# Includes the S13 C++ runtime swap, so this measures the image the modded variant will
# actually ship rather than a hypothetical one.
FROM debian:bookworm-slim AS platform
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /out

# Identical pins to lab/s1-modded-image/Dockerfile and apps/l4d2/mods/mods-platform.txt.
ARG MM_TGZ=https://mms.alliedmods.net/mmsdrop/2.0/mmsource-2.0.0-git1410-linux.tar.gz
ARG SM_TGZ=https://sm.alliedmods.net/smdrop/1.12/sourcemod-1.12.0-git7251-linux.tar.gz
ARG L4DH_SHA=f90ae5e62228e0b7baf12cda922e3fd40db844f4

# Both tarballs are rooted at addons/, so they layer over each other and over the pack.
RUN curl -sfL "${MM_TGZ}" | tar xz \
 && curl -sfL "${SM_TGZ}" | tar xz

# scripting/include is not optional decoration: first-party plugins compile against
# left4dhooks.inc, and without it the image can RUN Left4DHooks but not build anything
# that uses it.
RUN curl -sfL "https://github.com/SilvDev/Left4DHooks/archive/${L4DH_SHA}.tar.gz" \
      | tar xz --strip-components=2 -C addons/sourcemod \
        "Left4DHooks-${L4DH_SHA}/sourcemod/plugins" \
        "Left4DHooks-${L4DH_SHA}/sourcemod/gamedata" \
        "Left4DHooks-${L4DH_SHA}/sourcemod/data" \
        "Left4DHooks-${L4DH_SHA}/sourcemod/scripting/include"

# SourceMod's tarball ships its own copies of the stock plugins. The pack's tree has
# them too and its versions are what S11 measured, but a MIXED SourceMod (7251 binaries
# with 7221 stock plugins) is a state nobody tests upstream — so the newer stock set
# wins, which is what layering already does. Recorded because it is not obvious that
# this build changes more than three files.

# ---------------------------------------------------------------------------------
FROM l4d2-acc:s13

COPY --from=platform --chown=louis:louis /out/addons/ /addons/

# Same two removals as S11 and S1, for the same reason: both fail to load on THIS game
# and a boot log full of errors that look real makes a genuine failure impossible to
# spot — which is exactly what this build is trying to measure.
USER root
RUN rm -f /addons/metamod_x64.vdf /addons/metamod_x64.linux.vdf /addons/metamod_x64.win.vdf \
          /addons/sourcemod/plugins/nextmap.smx
USER louis
