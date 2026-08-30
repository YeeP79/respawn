# Modded Valheim — upstream image plus an rcon config shim.
#
# This build exists ONLY to reach a setting the upstream image cannot express: the rcon
# plugin's password. The plugin is config-FILE driven, so the password cannot ride in a
# GAME_ENV_ value (plaintext in the task definition), and the file lives in the BepInEx
# install tree under /opt — which no sidecar mounts. Only this container has both the
# injected secret and that tree. See respawn-rcon-config.sh for the measurement that
# established this; the earlier sidecar-writes-the-volume approach was tried and failed.
#
# Everything else still comes from upstream: SteamCMD updates, the BepInEx installer,
# supervisord, the status endpoint, world backups. Nothing here forks their machinery.
FROM ghcr.io/lloesche/valheim-server:latest

# Build context is the REPO ROOT (deploy.ts passes workspaceRoot), so this path is
# repo-relative, not relative to this file.
COPY apps/valheim/variants/modded/respawn-rcon-config.sh /respawn-rcon-config.sh

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
