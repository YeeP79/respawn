# LinuxGSM Counter-Strike: Source server (Source/srcds).
# The upstream image is config-file driven and has no env vars for game settings,
# so we layer a shim that writes cssserver.cfg + server.cfg from Respawn's env
# vars/secrets before handing off to the upstream entrypoint. Build context is
# the repo root.
FROM gameservermanagers/gameserver:css

COPY apps/css/respawn-init.sh /app/respawn-init.sh
RUN chmod +x /app/respawn-init.sh

ENTRYPOINT ["/bin/bash", "/app/respawn-init.sh"]
