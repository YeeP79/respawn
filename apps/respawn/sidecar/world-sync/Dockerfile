FROM alpine:3.21

# jq to read and write the provenance stamp — the flavor check is the one guard that
# decides whether a save is installed, so parsing JSON with sed is not acceptable here.
# coreutils for `od -t f8`: busybox's od cannot decode a little-endian double, and
# reading the world clock out of the save header is how this sidecar decides whether
# an incoming world is newer than the one already on the volume.
RUN apk add --no-cache \
    bash \
    aws-cli \
    coreutils \
    jq

COPY sync.sh /usr/local/bin/sync.sh
RUN chmod +x /usr/local/bin/sync.sh

ENTRYPOINT ["/usr/local/bin/sync.sh"]
