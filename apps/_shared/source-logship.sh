#!/bin/sh
# Ship a Source server's on-disk logs to stdout, then exec the real entrypoint.
#
#   source-logship.sh <gamedir> <command> [args...]
#
# WHY
# Fargate captures container stdout and nothing else, so anything a Source server
# writes to a FILE is invisible to `server_logs` and dies with the task. That covers
# the diagnostics you actually need when a modded server misbehaves:
#
#   addons/sourcemod/logs/L<date>.log   plugin load failures, SM errors, plugin output
#   logs/L<date>.log                    game events (needs `log on`)
#
# WHAT THIS DOES AND DOES NOT FIX
# The SourceMod side is the reason to run this: it has no console path at all, so
# without shipping it those lines exist only in a file that dies with the task.
#
# The GAME log is shipped too, but srcds BUFFERS it — measured 2026-08-30 as a file
# created and left at 0 bytes while the server ran. So do not rely on this alone for
# game events; set `sv_logecho 1` as well, which echoes them to the console and
# therefore to stdout directly. Belt and braces, because the two fail differently:
# the file buffers, and sv_logecho was observed to stop echoing mid-session.
#
# Measured 2026-08-30: SourceMod had written 394 bytes of its own log while ZERO
# SourceMod lines had reached stdout. On a 43-plugin stack that is the difference
# between "a plugin failed to load" and "the server seems fine but something is
# missing" — SourceMod logs the failure and carries on, so nothing else reports it.
#
# EXIT STATUS IS LOAD-BEARING — do not restructure this into a pipeline.
# `exec` at the end means the game becomes PID 1 and the container reports the GAME's
# exit status. `game | sed` would make the shell PID 1 and hand the container sed's
# status instead, and `server_health` reads that status to tell a normal stop
# (SIGKILL after ECS asked it to stop) from an OOM kill. This is the same trap
# apps/_shared/hlds-log-redact.sh documents for GoldSrc.
set -u

GAMEDIR="${1:?usage: source-logship.sh <gamedir> <command> [args...]}"
shift

# Tail every .log in a directory, picking up files that appear later. Source rotates
# by DATE (L20260830.log), so a plain `tail -F <name>` stops being right at midnight
# and a glob expands only once — hence the rescan loop.
ship_dir() {
  _prefix="$1"
  _dir="$2"
  _seen=""
  while true; do
    for _f in "$_dir"/*.log; do
      [ -e "$_f" ] || continue
      case " $_seen " in *" $_f "*) continue ;; esac
      _seen="$_seen $_f"
      # -n +1 so a file that already has content is shipped in full, not just new
      # lines: the interesting failures happen during startup, before this runs.
      #
      # `sed -u` is NOT optional. Container stdout is a pipe, so sed BLOCK-buffers by
      # default and lines sit unflushed until ~4KB accumulates — measured here as a
      # log that was being read correctly and never arrived. A log shipper that
      # delivers in 4KB bursts is worse than none: it is silent for exactly as long as
      # the server is quiet, which is when you are trying to work out why.
      tail -n +1 -F "$_f" 2>/dev/null | sed -u "s/^/[$_prefix] /" &
    done
    sleep 15
  done
}

mkdir -p "$GAMEDIR/addons/sourcemod/logs" "$GAMEDIR/logs" 2>/dev/null || true

ship_dir sm   "$GAMEDIR/addons/sourcemod/logs" &
ship_dir game "$GAMEDIR/logs" &

echo "[logship] shipping sourcemod + game logs to stdout"
exec "$@"
