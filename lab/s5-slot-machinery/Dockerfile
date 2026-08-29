# S5 — is the slot machinery inert at four players?
#
# The S1 base plus L4DToolz ONLY. Everything else is held constant so any
# behavioural difference at 4 players is attributable to this one addition.
# See docs/spikes/S5.md.
#
# L4DToolz is the load-bearing piece: Left4DHooks' own thread routes slot changes
# to it ("Player slots is unsupported. Use the L4DToolZ Metamod plugin"), so
# there is no alternative implementation to compare against.

FROM debian:bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /out
# The "oldlinux" asset, NOT "linux". The plain linux build is compiled against a
# newer glibc than this image carries, and MetaMod refuses it at load:
#   [META] Failed to load plugin addons/l4dtoolz/l4dtoolz_mm:
#     /lib/libc.so.6: version `GLIBC_2.38' not found
# The failure is loud, but it still leaves a server that boots fine and simply
# has no slot support — which is exactly the shape of bug this spike exists to
# catch, so it is recorded rather than silently fixed.
ARG L4DTOOLZ_TGZ=https://github.com/accelerator74/l4dtoolz/releases/download/2.2.0/l4dtoolz-l4d2-oldlinux-ef2a8df.tar.gz
RUN curl -sfL "${L4DTOOLZ_TGZ}" | tar xz \
 && test -f addons/l4dtoolz/l4dtoolz_mm.so \
 && test -f addons/metamod/l4dtoolz.vdf

FROM l4d2-base-spike:s1
COPY --from=build --chown=louis:louis /out/addons/ /addons/
