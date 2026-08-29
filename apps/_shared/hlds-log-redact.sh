#!/bin/sh
# Runs a GoldSrc server with its stdout filtered so the rcon password never reaches
# the log driver.
#
# WHY THIS EXISTS
# HLDS echoes every rcon request to the console verbatim, password included, in two
# shapes:
#
#   rcon 711248148 "<password>" sv_airaccelerate
#   L 08/28/2026 - 22:59:08: Rcon: "rcon 711248148 "<password>" sv_airaccelerate
#
# Container stdout goes straight to CloudWatch, so every command the rcon-control
# sidecar issues wrote the password into the log group — which defeats the point of
# SECRET_REFS, whose whole job is keeping credentials out of anything readable with
# ordinary infrastructure access. It is engine behaviour with no cvar to disable it,
# and rotating does not help: the next rcon call logs the new value.
#
# Redaction rather than suppression, because the line is also the only audit trail of
# who ran what over rcon. A failed attempt logs the same shape ("Bad Rcon:"), so a
# password guessed at by a stranger is covered too.
#
# WHY A SUPERVISOR AND NOT `exec hlds | sed`
# Two things have to survive the wrapper, and the obvious forms each lose one.
#
# `hlds | sed` makes the shell PID 1 and hands the container sed's exit status, not the
# game's. server_health reads that status to tell a normal stop ("SIGKILL after ECS
# asked it to stop — the game ignores SIGTERM") from an OOM kill, so masking it breaks
# the one diagnosis that separates them.
#
# `exec hlds > fifo` with sed in the background keeps the game as PID 1 and its exit
# status — but the container is torn down the moment PID 1 exits, which kills sed with
# the pipe undrained. MEASURED: of five lines written immediately before exit, one
# reached the log. Those are the lines a crash is diagnosed from, so that trade is the
# wrong way round.
#
# So the shell stays PID 1 and supervises: it forwards SIGTERM to the game, waits for
# the game, then waits for sed to drain the FIFO before exiting with the game's own
# status. The game's exit code is reproduced rather than replaced, and no output is
# dropped on the way down.
#
# Usage:  exec /bin/sh /hlds-log-redact.sh <command> [args...]
set -e

# An owner-only directory, so the unredacted stream passing through the FIFO is not
# readable by anything else that happens to run in the container.
DIR="$(mktemp -d "${TMPDIR:-/tmp}/respawn-redact.XXXXXX")"
chmod 700 "${DIR}"
FIFO="${DIR}/stdout"
mkfifo -m 600 "${FIFO}"

# -u because sed would otherwise buffer, and a game server's log is only useful live.
# Opening for read blocks until the writer below opens its end; both then proceed.
sed -u -E 's/(rcon[[:space:]]+[0-9]+[[:space:]]+)"[^"]*"/\1"[REDACTED]"/g' < "${FIFO}" &
REDACTOR=$!

"$@" > "${FIFO}" 2>&1 &
GAME=$!

# ECS signals PID 1, which is this shell; pass it on to the game so its shutdown is
# exactly what it would be without the wrapper. (HLDS ignores SIGTERM and is SIGKILLed
# at the stop timeout, which is why a game-server SIGKILL is a normal stop here.)
trap 'kill -TERM "${GAME}" 2>/dev/null' TERM INT

# errexit OFF from here down. `wait` reports the GAME's exit status, so a server that
# exits non-zero — a crash, or the SIGKILL that ends every normal stop here — would
# otherwise terminate this shell on the spot, tearing the container down before sed has
# drained the FIFO. MEASURED: with errexit left on, a server exiting 42 delivered its
# log 1 run in 5, and the faster it died the less survived. That inverts the whole
# point, since a fast crash is when the log matters most.
set +e

# A trap firing makes wait return early, so keep waiting until the game is really gone.
while :; do
  wait "${GAME}"; rc=$?
  kill -0 "${GAME}" 2>/dev/null || break
done

# The game held the only write end, so its exit closes the FIFO and sed sees EOF. This
# wait is what stops the container tearing down mid-flush.
wait "${REDACTOR}" 2>/dev/null || true
exit "${rc}"
