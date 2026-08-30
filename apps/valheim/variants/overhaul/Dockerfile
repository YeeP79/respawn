# Modded Valheim — upstream image plus an rcon config shim.
#
# BYTE-IDENTICAL IN EVERY MODDED VARIANT, ON PURPOSE. Variants differ in their MOD SET,
# which is published to S3 and synced onto the volume at boot; none of that is baked into
# an image. What IS baked in is the one setting the upstream image cannot express, and it
# is the same setting for all of them.
#
# That setting is the rcon plugin's password. The plugin is config-FILE driven, so the
# password cannot ride in a GAME_ENV_ value (plaintext in the task definition), and the
# file lives in the BepInEx install tree under /opt — which no sidecar mounts. Only this
# container has both the injected secret and that tree. See respawn-rcon-config.sh for the
# measurement that established this; the earlier sidecar-writes-the-volume approach was
# tried and failed.
#
# Everything else still comes from upstream: SteamCMD updates, the BepInEx installer,
# supervisord, the status endpoint, world backups. Nothing here forks their machinery.
#
# Identical content means an identical image content hash, so all five build to the same
# `sha-` tag — but ECR repositories are per service, so each still builds and pushes into
# its own. The tag dedupes within a repository, not across them.
FROM ghcr.io/lloesche/valheim-server:latest

# Build context is the REPO ROOT (deploy.ts passes workspaceRoot), so this path is
# repo-relative, not relative to this file. The shim is shared at the PROJECT level
# rather than copied per variant: five copies is four chances to fix a bug in one of them.
COPY apps/valheim/respawn-rcon-config.sh /respawn-rcon-config.sh

# Root in this image (it chowns /config and runs supervisord as uid 0), so chmod is fine
# here — unlike the LinuxGSM and HLDS images, which run unprivileged and cannot chmod a
# root-owned COPY.
RUN chmod +x /respawn-rcon-config.sh

# Fires after the updater has installed and merged BepInEx, and before the server process
# starts. That window is the whole point: the bootstrap and POST_BEPINEX_CONFIG_HOOK both
# run BEFORE a fresh BepInEx install, which then lands on top of anything they wrote — the
# exact failure this shim replaces. Set here rather than in .env so no shell quoting has to
# survive a dotenv value and an ECS task definition.
ENV PRE_SERVER_RUN_HOOK=/respawn-rcon-config.sh
