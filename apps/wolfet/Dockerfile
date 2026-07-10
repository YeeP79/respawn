# Wolfenstein: Enemy Territory server on the ET: Legacy engine (idTech3).
#
# The official etlegacy/server image is engine-only: it ships the ET: Legacy engine
# and `legacy` mod but NOT the original W:ET game assets (pak0-2.pk3, mp_bin.pk3), so
# it exits at boot asking for them. W:ET is freeware and the paks are redistributable
# (ET: Legacy's own installer fetches them), so stage one pulls them from the project's
# mirror and stage two lays them into etmain. Fetching in a build container also sidesteps
# the host's outbound-download restriction.
#
# The upstream image is config-file driven, so the rcon password cannot ride the command
# line without landing in the ECS task definition. respawn-init.sh writes it into an
# overlay cfg from Respawn's injected secret. Build context is the repo root.
#
# No `RUN chmod +x`: the image's USER is `legacy` (uid 1000) and cannot chmod a root-owned
# COPY; invoking via `/bin/sh` makes the exec bit unnecessary (see cs16).

FROM curlimages/curl:latest AS assets
ARG ETMAIN_MIRROR=https://mirror.etlegacy.com/etmain
WORKDIR /assets
RUN curl -fsSL -O "${ETMAIN_MIRROR}/pak0.pk3" \
 && curl -fsSL -O "${ETMAIN_MIRROR}/pak1.pk3" \
 && curl -fsSL -O "${ETMAIN_MIRROR}/pak2.pk3" \
 && curl -fsSL -O "${ETMAIN_MIRROR}/mp_bin.pk3" \
 # Integrity guard: pak0.pk3 is 228138631 bytes. A truncated download or an HTML error
 # page would be far smaller, and would otherwise bake a broken server into the image.
 && [ "$(wc -c < pak0.pk3)" = "228138631" ] || { echo "pak0.pk3 wrong size" >&2; exit 1; }

FROM etlegacy/server:latest
COPY --from=assets --chown=legacy:legacy /assets/pak0.pk3 /assets/pak1.pk3 /assets/pak2.pk3 /assets/mp_bin.pk3 /legacy/server/etmain/
COPY apps/wolfet/respawn-init.sh /respawn-init.sh

ENTRYPOINT ["/bin/sh", "/respawn-init.sh"]
