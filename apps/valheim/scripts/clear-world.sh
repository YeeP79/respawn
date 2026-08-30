#!/usr/bin/env bash
# Take a world's S3 copies down after a session.
#
#   clear-world.sh [<world-name>] [aws-profile] [--yes]
#
# The bucket is private, so this is housekeeping rather than an exposure fix — unlike
# tfc's FastDL clear, where content left behind stays openly downloadable. What it is
# really protecting against is a stale live/ mirror being pulled down months later and
# treated as current.
#
# It refuses unless the local library already holds a copy at least as new, because the
# server's mirror is otherwise the only record of the session.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_world-lib.sh"

variant=""
world=""
profile=""
assume_yes=0
for arg in "$@"; do
  case "$arg" in
    # For non-interactive callers that have already confirmed. Without it the prompt
    # below reads EOF from a closed stdin and aborts — safe, but nothing would work.
    --yes) assume_yes=1 ;;
    *) if [ -z "$variant" ]; then variant="$arg";
       elif [ -z "$world" ]; then world="$arg"; else profile="$arg"; fi ;;
  esac
done
resolve_variant "$variant"
[ -n "$world" ] || world="$(default_world_name)" || true
[ -n "$world" ] || die "usage: clear-world.sh <variant> <world-name> [aws-profile] [--yes]"

prefix="$(world_s3_prefix)"
args=()
[ -n "$profile" ] && args+=(--profile "$profile")

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if aws s3 cp "$prefix/live/$world.db" "$tmp/live.db" --only-show-errors "${args[@]}" 2>/dev/null; then
  remote_clock="$(world_clock "$tmp/live.db")" || remote_clock=""
  local_clock="$(world_clock "$WORLDS_DIR/$world/$world.db" 2>/dev/null)" || local_clock=""
  if [ -z "$local_clock" ]; then
    die "REFUSING: the local library has no copy of '$world', so $prefix/live/ is the only
one that exists. Pull it first:
  pnpm valheim:world:pull $variant '$world'${profile:+ $profile}"
  fi
  if [ -n "$remote_clock" ] && clock_behind "$local_clock" "$remote_clock"; then
    die "REFUSING: the server's copy ($(clock_days "$remote_clock") in-game days) is ahead of your
local one ($(clock_days "$local_clock")). Deleting it would discard that progress. Pull it first:
  pnpm valheim:world:pull $variant '$world'${profile:+ $profile}"
  fi
fi

echo "About to DELETE '$world' from $prefix/{inbox,live}/"
aws s3 ls "$prefix/inbox/" "${args[@]}" 2>/dev/null | grep -F "$world" || true
aws s3 ls "$prefix/live/"  "${args[@]}" 2>/dev/null | grep -F "$world" || true
if [ "$assume_yes" -eq 0 ]; then
  printf "Type the world name to confirm: "
  read -r confirm
  [ "$confirm" = "$world" ] || die "aborted (got '$confirm')"
fi

for where in inbox live; do
  for ext in db fwl "$STAMP_EXT"; do
    aws s3 rm "$prefix/$where/$world.$ext" --only-show-errors "${args[@]}" 2>/dev/null || true
  done
done

cat <<EOF
cleared '$world' from $prefix/{inbox,live}/

The world is STILL on the server's EFS volume — this removes only the S3 copies. A
running task mirrors it back at the next interval, so scale to 0 first if the bucket
should stay empty.
EOF
