#!/usr/bin/env bash
# Push a world from the local library to S3 so the server picks it up on next start.
#
#   publish-world.sh [<world-name>] [aws-profile] [--force]
#
# The world lands in <prefix>/inbox/, which the world-sync sidecar drains ONCE at boot
# and then deletes. It is a handoff, not standing configuration: a task that restarts
# mid-session must not re-seed over live play.
#
# This is a PRE-SESSION step. Unlike tfc's FastDL publish it is NOT one-way — the server
# will keep playing this world and mirror it back to <prefix>/live/, and that mirror is
# what you pull down afterwards. Publishing without ever pulling back loses every
# session's progress.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_world-lib.sh"

variant=""
world=""
profile=""
force=0
assume_vanilla=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --assume-vanilla) assume_vanilla=1 ;;
    *) if [ -z "$variant" ]; then variant="$arg";
       elif [ -z "$world" ]; then world="$arg"; else profile="$arg"; fi ;;
  esac
done
resolve_variant "$variant"
[ -n "$world" ] || world="$(default_world_name)" || true
[ -n "$world" ] || die "usage: publish-world.sh <variant> <world-name> [aws-profile] [--force]"

target_flavor="$(variant_flavor)" || die "no WORLD_FLAVOR in $ENV_FILE"

prefix="$(world_s3_prefix)"
dir="$WORLDS_DIR/$world"
args=()
[ -n "$profile" ] && args+=(--profile "$profile")

require_local_pair "$dir" "$world"
# Provenance before anything else: this check prevents DESTROYING content, as against
# the clock check below which only prevents losing progress.
assert_flavor_compatible "$dir/$world.$STAMP_EXT" "$target_flavor" "$assume_vanilla"
assert_plugins_compatible "$dir/$world.$STAMP_EXT"
local_clock="$(world_clock "$dir/$world.db")" || die "'$dir/$world.db' has no readable header"

# Refuse to push over a session that has been played since this copy was taken. The
# sidecar makes the same check server-side; doing it here too means the operator finds
# out now, at the keyboard, rather than from a container log after the server has
# quietly booted the wrong world.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if aws s3 cp "$prefix/live/$world.db" "$tmp/live.db" --only-show-errors "${args[@]}" 2>/dev/null; then
  live_clock="$(world_clock "$tmp/live.db")" || live_clock=""
  if [ -n "$live_clock" ] && clock_behind "$local_clock" "$live_clock"; then
    echo "REFUSING to publish."
    echo "  local  $(clock_days "$local_clock") in-game days"
    echo "  server $(clock_days "$live_clock") in-game days  <- ahead of your copy"
    echo
    echo "The server has been played since this copy was taken. Publishing would discard"
    echo "that progress. Pull it down first:"
    echo "  pnpm valheim:world:pull $variant '$world'${profile:+ $profile}"
    echo "Or pass --force to roll back to the local copy on purpose."
    [ "$force" -eq 0 ] && exit 1
    echo "--force given; publishing the older world anyway."
  fi
fi

aws s3 cp "$dir/$world.fwl" "$prefix/inbox/$world.fwl" --only-show-errors "${args[@]}"
aws s3 cp "$dir/$world.db"  "$prefix/inbox/$world.db"  --only-show-errors "${args[@]}"
# The stamp must travel with the save. Without it the server sees an unstamped world and
# falls back to assuming vanilla — exactly the case the stamp exists to close.
[ -f "$dir/$world.$STAMP_EXT" ] &&
  aws s3 cp "$dir/$world.$STAMP_EXT" "$prefix/inbox/$world.$STAMP_EXT" --only-show-errors "${args[@]}"

cat <<EOF

Published '$world' ($(clock_days "$local_clock") in-game days, $(stat -c%s "$dir/$world.db") bytes)
to $prefix/inbox/  [variant: $variant, flavor: $target_flavor]

The sidecar installs it at the next task start and then clears the inbox. If the server
is already running, restart it or it will keep playing the world it booted on:
  pnpm respawn  ->  Scale  ->  valheim  ->  0, then 1

GAME_ENV_WORLD_NAME must be "$world" or the server will not open this file.
AFTER the session, pull the played world back down — the server's copy is the only one
that has your progress:
  pnpm valheim:world:pull $variant '$world'${profile:+ $profile}
EOF
