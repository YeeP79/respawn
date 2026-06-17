# LinuxGSM Garry's Mod server (Source/srcds, Steam app ID 4020).
# The upstream image is config-file driven and has no env vars for game settings,
# so we layer a shim that writes gmodserver.cfg from Respawn's env vars/secrets
# before handing off to the upstream entrypoint. Build context is the repo root.
FROM gameservermanagers/gameserver:gmod

COPY apps/gmod/respawn-init.sh /app/respawn-init.sh
RUN chmod +x /app/respawn-init.sh

ENTRYPOINT ["/bin/bash", "/app/respawn-init.sh"]
