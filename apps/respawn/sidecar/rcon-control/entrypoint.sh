#!/bin/sh
#
# The control sidecar does no work on its own: it exists so an operator (or an
# MCP client) can `aws ecs execute-command` into the task and run rcon.py against
# the game container over loopback. No inbound port is opened.
set -eu

echo "[rcon-control] service=${SERVICE_NAME:-?} protocol=${RCON_PROTOCOL:-goldsrc} target=${RCON_HOST:-127.0.0.1}:${RCON_PORT:-27015}"
if [ -z "${RCON_PASSWORD:-}" ]; then
  echo "[rcon-control] WARNING: RCON_PASSWORD is not set; rcon.py will refuse to run" >&2
fi
echo "[rcon-control] ready; exec into this container to run: python3 /usr/local/bin/rcon.py --command '<cmd>'"

# Idle until the task stops. `wait` lets SIGTERM through promptly.
trap 'echo "[rcon-control] shutting down"; exit 0' TERM INT
while true; do
  sleep 3600 &
  wait $! || true
done
