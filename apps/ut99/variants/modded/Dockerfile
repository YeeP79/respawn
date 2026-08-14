# Modded UT99 — upstream image plus a config shim.
#
# This build exists ONLY to reach settings the upstream image cannot express. Its
# /prepare.py maps a fixed set of UT_* env vars onto ini keys; anything outside that
# set (bUseTranslocator, ServerPackages) has no durable home, because an rcon `set`
# writes the in-memory class default and dies with the task. See respawn-init.sh.
#
# Everything else — the mod set, the maps, prepare.py itself — still comes from
# upstream. Pinning a digest is deliberate: `latest` is mutable, and a silent
# republish would swap the whole mod set underneath the manifest that catalogues it.
# The image-hash tag already includes the resolved base digest, so an upstream change
# forces a rebuild rather than reusing a stale image (utils/image-hash.ts).
FROM roemer/ut99-server:latest

# Build context is the REPO ROOT (deploy.ts passes workspaceRoot), so this path is
# repo-relative, not relative to this file.
COPY apps/ut99/variants/modded/respawn-init.sh /respawn-init.sh

# Root in this image (verified: uid 0), so chmod is fine here — unlike the LinuxGSM
# and HLDS images, which run as an unprivileged user and cannot chmod a root-owned COPY.
RUN chmod +x /respawn-init.sh

# Replaces the upstream CMD (/startup.sh). The shim applies its ini edits and then
# execs /startup.sh, so upstream keeps ownership of prepare.py and the server launch.
CMD ["/respawn-init.sh"]
