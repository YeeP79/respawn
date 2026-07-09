# Control sidecar: reachable only via ECS Exec (SSM), never an inbound port.
#
# Debian-slim, NOT Alpine: the SSM agent that ECS Exec bind-mounts into the
# container is glibc-linked, and exec into a musl image is a known failure mode.
# python3 is already present in this base, so nothing needs installing.
FROM python:3.12-slim

COPY apps/respawn/sidecar/rcon-control/rcon.py /usr/local/bin/rcon.py
COPY apps/respawn/sidecar/rcon-control/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/rcon.py /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
