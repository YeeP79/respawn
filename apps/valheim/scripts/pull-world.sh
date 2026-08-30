#!/usr/bin/env bash
# Bring the played world back down from S3 into the local library.
#
#   pull-world.sh [<world-name>] [aws-profile] [--force] [--clear]
#
# This is the half that makes rotation safe. The server's copy under <prefix>/live/ is
# the only one carrying the session's progress — the local library's copy is whatever
# you last published, which is by definition older. Rotating to a different world
# without pulling first discards everything played.
#
# --clear removes the S3 copies afterwards, for the "take it down between sessions"
# cycle. It runs only after a verified download, never before.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_world-lib.sh"

variant=""
world=""
profile=""
force=0
clear_after=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --clear) clear_after=1 ;;
    *) if [ -z "$variant" ]; then variant="$arg";
       elif [ -z "$world" ]; then world="$arg"; else profile="$arg"; fi ;;
  esac
done
resolve_variant "$variant"
[ -n "$world" ] || world="$(default_world_name)" || true
[ -n "$world" ] || die "usage: pull-world.sh <variant> <world-name> [aws-profile] [--force] [--clear]"

prefix="$(world_s3_prefix)"
dir="$WORLDS_DIR/$world"
args=()
[ -n "$profile" ] && args+=(--profile "$profile")

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if ! aws s3 cp "$prefix/live/$world.db"  "$tmp/$world.db"  --only-show-errors "${args[@]}" 2>/dev/null ||
   ! aws s3 cp "$prefix/live/$world.fwl" "$tmp/$world.fwl" --only-show-errors "${args[@]}" 2>/dev/null; then
  die "no complete world at $prefix/live/$world.{db,fwl}
The sidecar mirrors there on an interval and on shutdown, so this is empty until the
server has run at least once with ENABLE_WORLD_SYNC=true. Check with:
  pnpm valheim:world:check $variant${profile:+ $profile}"
fi

remote_clock="$(world_clock "$tmp/$world.db")" || die "downloaded world has no readable header — not overwriting anything"

# Refuse to overwrite a local copy that is AHEAD of the server's. That happens after a
# rollback, or when someone published a newer world that the server has not booted yet.
if local_clock="$(world_clock "$dir/$world.db" 2>/dev/null)" && [ -n "$local_clock" ]; then
  if clock_behind "$remote_clock" "$local_clock"; then
    echo "REFUSING to overwrite the local copy."
    echo "  server $(clock_days "$remote_clock") in-game days"
    echo "  local  $(clock_days "$local_clock") in-game days  <- ahead of the server's"
    echo
    echo "Your local copy has more play than the server's. Pass --force to replace it"
    echo "with the server's anyway."
    [ "$force" -eq 0 ] && exit 1
    echo "--force given; overwriting."
  fi
fi

mkdir -p "$dir"
# Keep the copy being replaced. It is irreplaceable state and this is the only script
# that overwrites it; a single stale pull would otherwise be unrecoverable.
if [ -f "$dir/$world.db" ]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$WORLDS_DIR/.previous/$world-$stamp"
  cp -p "$dir/$world.db" "$dir/$world.fwl" "$WORLDS_DIR/.previous/$world-$stamp/" 2>/dev/null || true
  cp -p "$dir/$world.$STAMP_EXT" "$WORLDS_DIR/.previous/$world-$stamp/" 2>/dev/null || true
  echo "previous copy kept at worlds/.previous/$world-$stamp/"
fi

# The stamp comes down too. It is what records that this world has now run modded —
# pulling the save without it would launder a modded world back into one the vanilla
# guard waves through.
if aws s3 cp "$prefix/live/$world.$STAMP_EXT" "$tmp/$world.$STAMP_EXT" --only-show-errors "${args[@]}" 2>/dev/null; then
  mv "$tmp/$world.$STAMP_EXT" "$dir/$world.$STAMP_EXT"
else
  echo "note: the server mirrored no provenance stamp for this world"
fi
mv "$tmp/$world.fwl" "$dir/$world.fwl"
mv "$tmp/$world.db"  "$dir/$world.db"
echo "pulled '$world' ($(clock_days "$remote_clock") in-game days, $(stat -c%s "$dir/$world.db") bytes) to $dir/"

if [ "$clear_after" -eq 1 ]; then
  # Only reached after the download landed and verified, so clearing cannot be the step
  # that loses the world.
  aws s3 rm "$prefix/live/$world.db"  --only-show-errors "${args[@]}" || true
  aws s3 rm "$prefix/live/$world.fwl" --only-show-errors "${args[@]}" || true
  aws s3 rm "$prefix/live/$world.$STAMP_EXT" --only-show-errors "${args[@]}" 2>/dev/null || true
  echo "cleared $prefix/live/$world.{db,fwl}"
  echo
  echo "NOTE the world is still on the server's EFS volume — clearing S3 does not remove"
  echo "it there, and the sidecar will mirror it back at the next interval if the task is"
  echo "still running. Scale to 0 first if you want the bucket to stay empty."
fi
