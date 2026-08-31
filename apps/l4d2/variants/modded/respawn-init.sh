#!/bin/sh
# Write Left4Lib's admin list, then hand off to the log shipper and the real entrypoint.
#
# WHY THIS EXISTS
# Left4Lib gates its CHAT-command path behind a user level and auto-promotes to Admin only
# when Director.IsSinglePlayerGame() — i.e. on a listen server. On a dedicated server every
# player is level 0 and every typed order is dropped with NO message, NO log line and no
# other signal: chat still works, bots are still tracked, the debug HUD still renders, only
# the orders vanish (S10, and it cost hours).
#
# The agent does NOT need this — respawn_director v3 calls Left4Bots.BotOrderAdd through
# VScript, which is not behind that gate (S12, measured with no admins file present). This
# is for the HUMAN: the direct binds in client/respawn.cfg (F11/F12/\) are
# `scripted_user_func l4b,...`, which is the gated path. Without this file those keys are
# silently inert, which is the worst way for a control to fail.
#
# Left4Lib creates ems/left4lib/cfg/settings.txt on first run and does NOT create
# admins.txt, so nothing else will ever write it.
#
# It is read at init, so it must exist BEFORE the server starts — which is the only reason
# this is a shim rather than something set over rcon.
set -e

ADMINS_FILE=/home/louis/l4d2/left4dead2/ems/left4lib/cfg/admins.txt

if [ -n "${L4B_ADMINS:-}" ]; then
  mkdir -p "$(dirname "$ADMINS_FILE")"
  : > "$ADMINS_FILE"
  # Entries are comma-separated in the env var, one per line in the file. The parser
  # splits each line on "//" and REJECTS a line that has no comment half, so the label is
  # mandatory rather than decoration — an id written without one is dropped with a warning
  # nobody reads. A missing label is filled in rather than left to be discarded.
  echo "$L4B_ADMINS" | tr ',' '\n' | while IFS= read -r entry; do
    entry="$(echo "$entry" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "$entry" ] && continue
    case "$entry" in
      *//*) echo "$entry" >> "$ADMINS_FILE" ;;
      *)    echo "$entry //admin" >> "$ADMINS_FILE" ;;
    esac
  done
  echo "[respawn-init] wrote $(wc -l < "$ADMINS_FILE") admin(s) to ems/left4lib/cfg/admins.txt"
else
  # Not fatal. The agent works without it; only the human's direct binds do not. Say which,
  # so a missing value is diagnosable from the log instead of presenting as dead keys.
  echo "[respawn-init] L4B_ADMINS is unset — the agent is unaffected, but a player's" \
       "direct l4b binds (F11/F12/\\ in client/respawn.cfg) will be silently ignored"
fi

exec "$@"
