# S11 — does the full 40+ plugin stack load together?
#
# S1 proved five components co-exist (MetaMod, SourceMod, Left4DHooks, Stripper,
# All4Dead2). The mod manifest in apps/l4d2/mods/ catalogues 43, and the gap between
# "catalogued" and "proven" is the whole question here.
#
# The payload is SNWCreations/l4d2-modded-server's assembled tree — the curated pack
# most of our manifest was derived from — plus the three VScript VPKs and our own
# respawn_director. Using the pack rather than fetching 40 plugins individually is
# deliberate: half the manifest's entries are AlliedMods forum attachments with no
# stable download URL, so a per-plugin fetcher would fail on the majority of them.
# The pack is second-hand and its pins are older than ours; that is a known trade and
# is recorded in apps/l4d2/mods/README.md.
FROM left4devops/l4d2:latest

# The base image symlinks left4dead2/addons -> /addons and left4dead2/cfg -> /cfg.
COPY --chown=louis:louis payload/addons/ /addons/
COPY --chown=louis:louis payload/cfg/    /cfg/

# S1 measured both of these failing to load on THIS game, and the pack ships them
# anyway. Removed for the same reason S1 removed them: a boot log full of errors that
# look real but are not makes a genuine failure impossible to spot, which is the exact
# thing this build is trying to measure.
#
#   metamod_x64*.vdf  -> "wrong ELF class: ELFCLASS64" (L4D2's srcds is 32-bit)
#   nextmap.smx       -> "Nextmap is incompatible with this game"
USER root
RUN rm -f /addons/metamod_x64.vdf /addons/metamod_x64.linux.vdf /addons/metamod_x64.win.vdf \
          /addons/sourcemod/plugins/nextmap.smx
USER louis
