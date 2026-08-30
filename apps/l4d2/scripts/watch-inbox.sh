#!/usr/bin/env bash
# Emit one line per player message addressed to the bots.
#
#   watch-inbox.sh <host> <port> <rcon-password> [poll-seconds]
#
# Written for the agent's Monitor tool: stdout is an EVENT STREAM, one notification
# per line, so this prints ONLY real messages. The polling happens here rather than in
# the agent's context — idle time costs nothing, which is the entire point. Polling
# from the agent side burns a round trip per check whether or not anybody said
# anything.
#
# respawn_director owns the inbox and drains it on read (at-most-once), so a message
# is emitted exactly once and cannot be re-delivered by a second watcher. Do not run
# two of these against one server.
set -uo pipefail   # NOT -e: a transient rcon failure must not end the watch

HOST="${1:?usage: watch-inbox.sh <host> <port> <password> [poll-seconds]}"
PORT="${2:?}"
PASS="${3:?}"
POLL="${4:-2}"

RCON="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/lab/srcds-rcon.py"

while true; do
  # `|| true` so a server restart, a dropped connection or a hibernating server is a
  # pause rather than the end of the watch. Silence here is normal.
  status="$(python3 "$RCON" "$HOST" "$PORT" "$PASS" sm_rd_status 2>/dev/null || true)"
  n="$(printf '%s' "$status" | grep -oE 'inbox=[0-9]+' | cut -d= -f2 | head -1)"

  if [ -n "${n:-}" ] && [ "$n" -gt 0 ] 2>/dev/null; then
    # Emit only MSG lines. INBOX|n, banners and rcon chatter are not events.
    python3 "$RCON" "$HOST" "$PORT" "$PASS" sm_rd_inbox 2>/dev/null \
      | grep '^MSG|' || true
  fi

  sleep "$POLL"
done
