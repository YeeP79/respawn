#!/bin/sh
# Write Left4Lib's admin list and the join password, then hand off to the log shipper and
# the real entrypoint.
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

# --- sv_password ----------------------------------------------------------------------
# Written to a cfg file rather than passed on the command line, because argv is readable
# with `ps` inside the container — which is exactly the exposure SECRET_REFS exists to
# close, and which the upstream entrypoint already inflicts on the rcon password.
#
# server.cfg carries a baked `exec respawn_secrets` line (see the Dockerfile) and Source
# re-execs server.cfg on every map change, so this is re-applied all session rather than
# only at boot. The file is truncated and rewritten each start, so it never accumulates.
#
# NOT fail-closed at runtime, deliberately: a server that refuses to boot is worse than one
# that boots. The loud check is at DEPLOY time — JOIN_PASSWORD is in REQUIRED_ENV_VARS, so
# preflight() rejects an absent or placeholder value before anything is created.
SECRETS_CFG=/cfg/respawn_secrets.cfg

if [ -n "${JOIN_PASSWORD:-}" ]; then
  # A cfg value is delimited by double quotes and terminated by a newline, so a password
  # containing either CANNOT be expressed here — and the failure is silent in the worst
  # way. Measured: `p@ss word"tricky` writes
  #
  #   sv_password "p@ss word"tricky"
  #
  # which Source reads as the password `p@ss word`. The server then rejects the password
  # that is actually in Secrets Manager, nobody can join, and no log line anywhere
  # mentions the cvar, the file or the secret.
  #
  # Fail CLOSED here, unlike the unset branch below. The two are not the same mistake: an
  # absent value is caught at deploy time by REQUIRED_ENV_VARS, so reaching runtime unset
  # means somebody removed that requirement on purpose. A malformed value passes every
  # deploy-time check there is and can only be caught here — and a container that refuses
  # to start with a named reason beats a server nobody can get into for reasons nothing
  # reports.
  # Both checks are `if`, not `[ ... ] && x`: set -e is on, and an AND-list whose test is
  # false returns non-zero, so the short form would kill the script on every WELL-FORMED
  # password. Same errexit trap the hlds log-redact shim documents.
  bad=''
  case "$JOIN_PASSWORD" in *'"'*) bad='a double quote' ;; esac
  if [ "$(printf '%s' "$JOIN_PASSWORD" | wc -l)" -ne 0 ]; then bad='a newline'; fi
  if [ -n "$bad" ]; then
    echo "[respawn-init] FATAL JOIN_PASSWORD contains $bad, which cannot be written to a" \
         "Source cfg value. The server would come up with a DIFFERENT password from the" \
         "one in Secrets Manager and nobody could join. Rotate the secret to a value with" \
         "no double quote or newline (respawn/l4d2-modded/join-pw)." >&2
    exit 1
  fi

  # 0600 before the value goes in, not after — the file must never exist world-readable
  # holding the password, however briefly.
  : > "$SECRETS_CFG"
  chmod 600 "$SECRETS_CFG"
  printf 'sv_password "%s"\n' "$JOIN_PASSWORD" >> "$SECRETS_CFG"
  echo "[respawn-init] wrote sv_password to cfg/respawn_secrets.cfg (value not logged)"
else
  # Say the consequence, not just the absence. An unpassworded server in a shared account
  # is the thing this is here to prevent, so it must not read as a routine info line.
  : > "$SECRETS_CFG"
  chmod 600 "$SECRETS_CFG"
  echo "[respawn-init] WARNING JOIN_PASSWORD is unset — THIS SERVER HAS NO JOIN PASSWORD" \
       "and 27015/udp is open to 0.0.0.0/0. Anyone who finds the IP can join."
fi

# --- the coop player cap ---------------------------------------------------------------
# Stock coop is hard-capped at 4. L4DToolZ (engine-plugin layer, addons/l4dtoolz.vdf) adds
# sv_maxplayers, and l4dmultislots plus the repair-tail plugins make 5+ survivors actually
# work. None of it does anything until the cvar is set — S5 measured the whole stack as
# INERT at four players, byte-identical to base.
#
# Driven by MAX_PLAYERS so the number is a task-definition change and a restart, NOT a
# rebuild — the same reasoning that makes tfc's mapcycle selection an env change.
#
# sv_setmax (engine max CLIENTS) is deliberately NOT touched: it defaults to 18, which
# already covers 8 humans plus the survivor bots that fill the empty slots, and it is the
# one cvar whose live-vs-launch-option behaviour lakwsh's README does not agree with S14's
# measurement. Raising MAX_PLAYERS above 18 means setting it too — and setting it past
# sv_setmax advertises slots the engine cannot seat, which surfaces as players failing to
# connect nowhere near the cvar that caused it.
#
# sv_force_unreserved is also left alone: l4d_unreservelobby.smx is already in the stack
# doing that job, and the cvar silently zeroes sv_allow_lobby_connect_only as a side
# effect, which is a joinability trap and not something to trigger twice from two places.
SLOTS_CFG=/cfg/respawn_slots.cfg
: > "$SLOTS_CFG"

if [ -n "${MAX_PLAYERS:-}" ]; then
  # Validated rather than trusted: a non-numeric value writes a garbage cvar argument, the
  # cap silently stays at 4, and the server looks completely healthy. Not fatal, though —
  # unlike a malformed password, the fallback here is a working 4-player server.
  case "$MAX_PLAYERS" in
    ''|*[!0-9]*) ok=no ;;
    *) if [ "$MAX_PLAYERS" -ge 1 ] && [ "$MAX_PLAYERS" -le 31 ]; then ok=yes; else ok=no; fi ;;
  esac
  if [ "$ok" = yes ]; then
    # sv_visiblemaxplayers is the count ADVERTISED to browsers and nothing else, so it is
    # set alongside — without it the server seats 8 and tells the browser 4.
    printf 'sv_maxplayers %s\n'        "$MAX_PLAYERS" >> "$SLOTS_CFG"
    printf 'sv_visiblemaxplayers %s\n' "$MAX_PLAYERS" >> "$SLOTS_CFG"
    echo "[respawn-init] coop cap raised to $MAX_PLAYERS human players (stock is 4)"
  else
    echo "[respawn-init] WARNING MAX_PLAYERS='$MAX_PLAYERS' is not an integer in 1..31 —" \
         "IGNORED, and this server keeps the stock 4-player coop cap. Above 31 crashes" \
         "since The Last Stand, which is why the ceiling is 31 and not 32."
  fi
else
  echo "[respawn-init] MAX_PLAYERS is unset — stock 4-player coop cap. The slot machinery" \
       "is installed and inert; set MAX_PLAYERS to raise it."
fi

exec "$@"
