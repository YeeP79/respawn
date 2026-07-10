# HLDS Counter-Strike 1.6 server (GoldSrc).
# The upstream image passes CONTAINER_COMMAND straight to hlds_run without eval,
# so a secret cannot be referenced on the command line. We layer a shim that
# writes cstrike/server.cfg from Respawn's injected env vars/secrets before
# handing off to the upstream entrypoint. Build context is the repo root.
#
# No `RUN chmod +x`: this image's USER is `steam`, so a RUN could not chmod a
# root-owned COPY. Invoking via `/bin/sh` makes the exec bit unnecessary.
FROM jives/hlds:cstrike

# The upstream entrypoint guards its mod/config copy with `[ -d /temp/mods ]`, then
# runs `rsync /temp/mods/*`. The image ships both directories *empty*, so the guard
# passes, the glob does not expand, and rsync fails on the literal `/temp/mods/*`
# every boot:
#
#   rsync: [sender] link_stat "/temp/mods/*" failed: No such file or directory (2)
#   rsync error: some files/attrs were not transferred (code 23)
#
# Harmless — that entrypoint has no `set -e` — but it lands two ERROR lines in
# CloudWatch on every start, which is two false positives in any log search. Drop the
# empty dirs so the guard correctly skips. A bind mount at either path recreates it,
# so mounting mods still works; `--ignore-fail-on-non-empty` means an upstream that
# starts shipping real mods keeps them.
USER root
RUN for d in /temp/mods /temp/config; do \
      [ -d "$d" ] && rmdir --ignore-fail-on-non-empty "$d" || true; \
    done
USER steam

COPY apps/cs16/respawn-init.sh /respawn-init.sh

ENTRYPOINT ["/bin/sh", "/respawn-init.sh"]
