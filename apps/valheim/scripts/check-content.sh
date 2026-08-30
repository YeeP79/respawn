#!/usr/bin/env bash
# Report where every copy of every world is, and which one is ahead. Read-only.
#
#   check-content.sh [bucket-or-prefix] [aws-profile]
#
# Run this BEFORE a session (is the right world staged?) and BEFORE rotating (has the
# server been played since my local copy?). Both questions fail silently otherwise: the
# server boots whatever the volume already had, and a stale publish reads as success.
#
# The bucket argument exists so the MCP's generic check_content tool can pass one; with
# none, the prefix comes from the service's own .env.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_world-lib.sh"

variant="${1:-}"
bucket_arg="${2:-}"
profile="${3:-}"
resolve_variant "$variant"
flavor="$(variant_flavor)" || flavor="(unset)"
# The MCP appends --cycle for FastDL services; ignore anything it sends that we have no
# use for rather than failing on it.
case "$bucket_arg" in --*) bucket_arg="" ;; esac
case "$profile" in --*) profile="" ;; esac

if [ -n "$bucket_arg" ]; then
  case "$bucket_arg" in
    s3://*) prefix="${bucket_arg%/}" ;;
    # A bare bucket name from the MCP: keep this service's own key prefix.
    *) prefix="s3://$bucket_arg/$(grep -E '^SERVICE_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\042\047')" ;;
  esac
else
  prefix="$(world_s3_prefix)"
fi

args=()
[ -n "$profile" ] && args+=(--profile "$profile")

configured="$(default_world_name || true)"
echo "world-sync status for valheim/$variant  (flavor: $flavor)"
echo "  S3 prefix        $prefix"
echo "  GAME_ENV_WORLD_NAME  ${configured:-(unset)}"
echo

problems=0

echo "LOCAL LIBRARY  $WORLDS_DIR"
if [ -d "$WORLDS_DIR" ] && compgen -G "$WORLDS_DIR/*/*.db" >/dev/null; then
  for db in "$WORLDS_DIR"/*/*.db; do
    name="$(basename "$db" .db)"
    c="$(world_clock "$db")" || c=""
    if [ -z "$c" ]; then
      echo "  ! $name  unreadable header"
      problems=$((problems + 1))
    elif [ ! -f "$(dirname "$db")/$name.fwl" ]; then
      echo "  ! $name  .db with no .fwl — will not load"
      problems=$((problems + 1))
    else
      wf="$(world_flavor "$(dirname "$db")/$name.$STAMP_EXT" 2>/dev/null)" || wf=""
      mark=""
      # The case worth shouting about: a modded save sitting in a vanilla library. It
      # cannot be published (publish refuses), but it can be copied in by hand.
      if [ "$wf" = "modded" ] && [ "$flavor" = "vanilla" ]; then
        mark="  <- MODDED save in a vanilla library; this server will refuse it"
        problems=$((problems + 1))
      fi
      echo "    $name  $(clock_days "$c") in-game days  $(stat -c%s "$db") bytes  [${wf:-unstamped}]$mark"
    fi
  done
else
  echo "    (empty)"
fi
echo

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Whether S3 answered at all. An unreachable bucket and an empty one are opposite facts
# — "nothing is staged" vs "I could not look" — and reporting the second as the first is
# the same mistake the idle watchdog refuses to make when a probe fails (-1, never 0).
s3_ok=1

report_remote() {
  local where="$1" label="$2"
  echo "$label  $prefix/$where/"
  local listing status
  listing="$(aws s3 ls "$prefix/$where/" "${args[@]}" 2>&1)"
  status=$?
  # `aws s3 ls` exits NON-ZERO on a prefix that simply holds nothing — S3 has no
  # directories, so "no objects here" and "I could not look" share an exit code. That is
  # exactly the distinction this function exists to make, so it is decided on OUTPUT, not
  # status: a real failure says why (expired token, denied, no such bucket), while an
  # empty prefix says nothing at all.
  if [ "$status" -ne 0 ] && [ -n "$listing" ]; then
    echo "    ! CANNOT REACH — this is not the same as empty:"
    echo "$listing" | sed 's/^/      /'
    s3_ok=0
    problems=$((problems + 1))
    return
  fi
  if [ -z "$listing" ]; then
    echo "    (empty)"
    return
  fi
  local f n c
  # Process substitution, not a pipe: a `while read` on the right of a pipe runs in a
  # subshell, so every problem it counted was discarded and the script exited 0 while
  # printing failures.
  while read -r f; do
    n="${f%.db}"
    if aws s3 cp "$prefix/$where/$f" "$tmp/probe.db" --only-show-errors "${args[@]}" 2>/dev/null; then
      c="$(world_clock "$tmp/probe.db")" || c=""
      if [ -n "$c" ]; then
        echo "    $n  $(clock_days "$c") in-game days"
      else
        echo "    ! $n  unreadable header"
        problems=$((problems + 1))
      fi
    else
      echo "    ! $n  cannot download"
      problems=$((problems + 1))
    fi
    # NOT `awk '{print $NF}'`: `aws s3 ls` prints "<date> <time> <size> <key>" and a world
    # name legitimately contains spaces ("Respawn World 2024"), so taking the last field keeps
    # only the trailing word — the listing reported a world called "2024" that then could
    # not be downloaded. Strip the three fixed leading columns instead and keep the rest.
  done < <(echo "$listing" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2} +[0-9:]+ +[0-9]+ +//' | grep '\.db$')
}

# inbox/ should normally be EMPTY: the sidecar drains it at boot. A world sitting here
# means either the server has not restarted since the publish, or seeding was refused —
# both of which look exactly like a successful publish from the laptop.
report_remote inbox "STAGED (installed at next task start)"
echo
report_remote live "SERVER MIRROR (pull this back after a session)"
echo

# The comparison the operator actually needs, stated rather than left to be worked out
# from three sets of numbers above.
if [ "$s3_ok" -eq 0 ]; then
  echo "VERDICT UNKNOWN — S3 could not be reached, so nothing above says whether the"
  echo "        server is ahead of your local copy. Do not publish on this reading."
  echo "        Usually an expired session: aws sso login --profile respawn"
elif [ -n "$configured" ]; then
  loc="$(world_clock "$WORLDS_DIR/$configured/$configured.db" 2>/dev/null)" || loc=""
  rem=""
  # A missing object here is a normal state (nothing mirrored yet), not a failure —
  # reachability was already decided above by report_remote.
  if aws s3 cp "$prefix/live/$configured.db" "$tmp/live.db" --only-show-errors "${args[@]}" 2>/dev/null; then
    rem="$(world_clock "$tmp/live.db")" || rem=""
  fi
  if [ -n "$loc" ] && [ -n "$rem" ]; then
    if clock_behind "$loc" "$rem"; then
      echo "VERDICT the server is AHEAD of your local copy by $(awk -v a="$rem" -v b="$loc" 'BEGIN{printf "%.1f", (a-b)/1800}') in-game days."
      echo "        Pull before publishing anything, or that progress is discarded."
      problems=$((problems + 1))
    elif clock_behind "$rem" "$loc"; then
      echo "VERDICT your local copy is ahead of the server's. Publishing will roll the"
      echo "        server back to it, which may be what you want."
    else
      echo "VERDICT local and server copies are at the same point. Safe either way."
    fi
  elif [ -n "$loc" ] && [ -z "$rem" ]; then
    echo "VERDICT nothing mirrored server-side yet. Publish to stage '$configured'."
  elif [ -z "$loc" ]; then
    echo "VERDICT no local copy of '$configured'. Pull one, or the library is missing it."
    problems=$((problems + 1))
  fi
fi

exit $((problems > 0))
