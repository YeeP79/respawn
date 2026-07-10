# HLDS Team Fortress Classic server (GoldSrc).
# The upstream image passes CONTAINER_COMMAND straight to hlds_run without eval,
# so a secret cannot be referenced on the command line. We layer a shim that
# writes tfc/server.cfg from Respawn's injected env vars/secrets before handing
# off to the upstream entrypoint. Build context is the repo root.
#
# No `RUN chmod +x`: this image's USER is `steam`, so a RUN could not chmod a
# root-owned COPY. Invoking via `/bin/sh` makes the exec bit unnecessary.
FROM jives/hlds:tfc

# See apps/cs16/Dockerfile: jives/hlds ships /temp/mods and /temp/config empty, so the
# entrypoint's `[ -d ]` guard passes and `rsync /temp/mods/*` fails on the unexpanded
# glob, logging two ERROR lines on every boot. Dropping the empty dirs makes the guard
# skip. A bind mount recreates the path, so mounting mods still works.
USER root
RUN for d in /temp/mods /temp/config; do \
      [ -d "$d" ] && rmdir --ignore-fail-on-non-empty "$d" || true; \
    done
USER steam

COPY apps/tfc/respawn-init.sh /respawn-init.sh

ENTRYPOINT ["/bin/sh", "/respawn-init.sh"]
