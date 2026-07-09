# HLDS Team Fortress Classic server (GoldSrc).
# The upstream image passes CONTAINER_COMMAND straight to hlds_run without eval,
# so a secret cannot be referenced on the command line. We layer a shim that
# writes tfc/server.cfg from Respawn's injected env vars/secrets before handing
# off to the upstream entrypoint. Build context is the repo root.
#
# No `RUN chmod +x`: this image's USER is `steam`, so a RUN could not chmod a
# root-owned COPY. Invoking via `/bin/sh` makes the exec bit unnecessary.
FROM jives/hlds:tfc

COPY apps/tfc/respawn-init.sh /respawn-init.sh

ENTRYPOINT ["/bin/sh", "/respawn-init.sh"]
