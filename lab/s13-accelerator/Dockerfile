# S13 — can Accelerator be made to load on this base image?
#
# Accelerator is the crash reporter. On l4d2-full:s11 it fails with
#   [SM] Unable to load extension "accelerator.ext":
#        bin/libstdc++.so.6: version `GLIBCXX_3.4.21' not found
# and SourceMod carries on, so the server looks healthy while the one component whose
# whole job is explaining an unexplained death is silently absent.
#
# THE CHAIN, measured with readelf rather than guessed:
#
#   accelerator.ext.so needs   GLIBCXX_3.4.29 (GCC 11), GLIBC <= 2.34, GCC_3.0
#   game's bin/libstdc++.so.6  provides only GLIBCXX <= 3.4.16  (a 2012 GCC 4.7)
#   base image has NO other 32-bit libstdc++, and LD_LIBRARY_PATH is ".:bin:"
#                              so bin/ always wins
#
# So bin/libstdc++.so.6 has to be replaced. Rocky 9's own libstdc++-11.5.0.i686 is the
# obvious source and it fits: GLIBCXX_3.4.29, GLIBC <= 2.34. But it drags libgcc with it:
#
#   1st attempt, libstdc++ alone:
#     Failed to open dedicated_srv.so
#       (bin/libgcc_s.so.1: version `GCC_7.0.0' not found (required by bin/libstdc++.so.6))
#
#   2nd attempt, + Rocky's libgcc.i686:
#     Failed to open dedicated_srv.so
#       (/lib/libc.so.6: version `GLIBC_2.35' not found (required by bin/libgcc_s.so.1))
#
# ROCKY 9'S OWN i686 MULTILIB PAIR DOES NOT WORK ON ROCKY 9. baseos offers exactly one
# libgcc.i686 (11.5.0-14.el9) and it references `_dl_find_object@GLIBC_2.35` — a symbol
# added in glibc 2.35 for stack unwinding — while RHEL 9 is pinned at glibc 2.34. Every
# libgcc from a distro built on glibc >= 2.35 has the same floor: Debian bookworm's
# 12.2.0 was checked and needs GLIBC_2.35 too.
#
# What Accelerator actually needs from libgcc is only GCC_3.0. The GCC_7.0.0 requirement
# comes from the *replacement libstdc++*, not from Accelerator. So the pair that works is
# a libgcc old enough to predate glibc 2.35 and new enough to carry GCC_7.0.0 — Debian
# bullseye's libgcc-s1 10.2.1 provides GCC_4.5.0/4.7.0/4.8.0/7.0.0 and needs nothing
# above GLIBC_2.2.4.
#
# Mixing a Rocky libstdc++ with a Debian libgcc is unusual, and it is why this is a spike
# rather than a change to the service: it has to be shown that the ENGINE and the whole
# 49-plugin stack still work, not just that Accelerator loads.
#
# The .deb is pinned by version AND sha256. Item 4 of this session is about not shipping
# moving targets, and a pool URL without a hash is exactly that.
FROM l4d2-full:s11

USER root

ARG LIBGCC_DEB=libgcc-s1_10.2.1-6_i386.deb
ARG LIBGCC_URL=http://deb.debian.org/debian/pool/main/g/gcc-10/libgcc-s1_10.2.1-6_i386.deb
ARG LIBGCC_SHA256=0a52edec5d626f8d9acf1998248d276760aff3950f44a308d27d4a2a488fe18d

RUN set -eux; \
    microdnf install -y --nodocs cpio binutils tar xz; \
    cd /tmp; \
    microdnf download libstdc++.i686; \
    mkdir -p /tmp/x; \
    rpm2cpio /tmp/libstdc++-*.i686.rpm | (cd /tmp/x && cpio -idm); \
    test -e /tmp/x/usr/lib/libstdc++.so.6; \
    curl -fsSLo "/tmp/$LIBGCC_DEB" "$LIBGCC_URL"; \
    echo "$LIBGCC_SHA256  /tmp/$LIBGCC_DEB" | sha256sum -c -; \
    mkdir -p /tmp/d; \
    (cd /tmp/d && ar x "/tmp/$LIBGCC_DEB" && tar -xf data.tar.*); \
    test -e /tmp/d/lib/i386-linux-gnu/libgcc_s.so.1; \
    for f in libstdc++.so.6 libgcc_s.so.1; do \
      mv "/home/louis/l4d2/bin/$f" "/home/louis/l4d2/bin/$f.valve"; \
    done; \
    cp -a /tmp/x/usr/lib/libstdc++.so.6* /home/louis/l4d2/bin/; \
    cp -aL /tmp/d/lib/i386-linux-gnu/libgcc_s.so.1 /home/louis/l4d2/bin/libgcc_s.so.1; \
    chown -R louis:louis /home/louis/l4d2/bin/; \
    rm -rf /tmp/x /tmp/d /tmp/*.rpm /tmp/*.deb; \
    microdnf clean all

USER louis
