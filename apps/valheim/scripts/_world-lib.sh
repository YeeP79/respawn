#!/usr/bin/env bash
# Shared helpers for the world-save scripts. Sourced, never run.
#
# A world save is the one artifact in this repo that cannot be regenerated — there is no
# manifest to refetch it from, unlike apps/*/variants/*/content/. Every script here is
# therefore built to refuse rather than guess, and the local library under worlds/ is a
# master copy that needs its own backup.

# The world's file name may contain spaces ("Respawn World"), so every path here is quoted
# and no unquoted expansion is allowed anywhere in these scripts.

# Every script takes the VARIANT as its first argument: worlds, the S3 prefix and the
# flavor are all per-variant, and defaulting it would silently pick one server's library
# while talking about the other's bucket.
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_variant() {
  local v="${1:-}"
  [ -n "$v" ] || die "usage: <script> <variant> [args]   (variant: $(list_variants))"
  SVC_DIR="$PROJECT_DIR/variants/$v"
  [ -d "$SVC_DIR" ] || die "no variant '$v' — have: $(list_variants)"
  WORLDS_DIR="$SVC_DIR/worlds"
  ENV_FILE="$SVC_DIR/.env"
  VARIANT="$v"
}

list_variants() {
  ls -1 "$PROJECT_DIR/variants" 2>/dev/null | tr '\n' ' '
}

die() { echo "$*" >&2; exit 1; }

# The provenance stamp travels with the save as <world>.respawn.json. See sync.sh for
# why the world clock cannot answer this question.
STAMP_EXT="respawn.json"

# What flavor this variant's server is, from its own .env.
variant_flavor() {
  [ -f "$ENV_FILE" ] || return 1
  grep -E '^WORLD_FLAVOR=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\042\047'
}

# The flavor a save carries, or empty if unstamped.
world_flavor() {
  local f="$1"
  [ -f "$f" ] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -r '.flavor // empty' "$f" 2>/dev/null
  else
    # jq is not guaranteed on a developer laptop, and refusing to run over a missing
    # pretty-printer would be worse than a narrow regex on a file we write ourselves.
    sed -n 's/.*"flavor"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1
  fi
}

# The one-way rule: a save that has run modded can never go back to a vanilla server.
# Mod-added objects are ZDOs carrying the mod's prefab hashes; loaded without the mod
# those hashes do not resolve and Valheim destroys the objects, rewriting a continuous
# object stream that frequently cannot be repaired afterwards.
assert_flavor_compatible() {
  local stamp="$1" target="$2" allow_unstamped="${3:-0}"
  local carried
  carried="$(world_flavor "$stamp" 2>/dev/null)" || carried=""

  if [ "$carried" = "modded" ] && [ "$target" = "vanilla" ]; then
    die "REFUSING: this world is stamped MODDED and '$VARIANT' is a vanilla server.
Loading it there would permanently destroy every object its mods created.
Publish it to the modded variant instead."
  fi
  if [ -z "$carried" ] && [ "$target" = "vanilla" ] && [ "$allow_unstamped" -eq 0 ]; then
    die "REFUSING: this world carries no provenance stamp, so nothing here knows whether
it has ever run with mods — and running a modded save on vanilla destroys its
mod-created objects. Re-run with --assume-vanilla if you know it is unmodded."
  fi
}

# The same destruction as above, between two MODDED variants — which the flavor check
# cannot see, because both sides say `modded`. A world climbing from the QoL set to the
# overhaul set is safe (the target has every plugin the save has met); the same move in
# reverse deletes every object those plugins created, because Valheim drops objects whose
# prefab it cannot resolve and rewrites the object stream without them.
#
# The sidecar makes this comparison again at seed time and is the side that cannot be
# bypassed by copying files into the bucket. This one exists so the operator finds out at
# the keyboard rather than in a log after the fact.
assert_plugins_compatible() {
  local stamp="$1" payload="$SVC_DIR/mods" missing="" dll
  [ -f "$stamp" ] || return 0

  # Unknown is reported, not assumed safe either way: refusing would block a legitimate
  # publish on a payload nobody needs locally, and staying silent would imply a check ran.
  if [ ! -d "$payload" ]; then
    echo "NOTE: $payload does not exist, so '$VARIANT' plugin set could not be compared here." >&2
    echo "      Run 'pnpm valheim:mods:fetch $VARIANT' to check it now; the sidecar checks" >&2
    echo "      again at seed time regardless." >&2
    return 0
  fi

  # world_flavor falls back to a regex when jq is absent, which works for a scalar and
  # does not for an array. Saying the check did not run beats a silent pass: an empty
  # result here is indistinguishable from "nothing world-altering ever ran".
  if ! command -v jq >/dev/null 2>&1; then
    echo "NOTE: jq is not installed, so the plugin comparison was skipped." >&2
    echo "      The sidecar makes the same check at seed time and will refuse there." >&2
    return 0
  fi

  while IFS= read -r dll; do
    [ -n "$dll" ] || continue
    [ -f "$payload/$dll" ] || missing="$missing  $dll
"
  done < <(jq -r '.mods_world_altering[]? // empty' "$stamp" 2>/dev/null)

  [ -z "$missing" ] || die "REFUSING: this world has run with world-altering plugins that '$VARIANT' does not carry:
$missing
Every object those plugins created would be deleted the first time it loads there, and
Valheim stores objects as a continuous stream, so that damage is usually unrepairable.
Publish it to a variant whose mod set includes them, or add them to '$VARIANT'."
}



# S3 prefix from the service's own .env, so the scripts and the deployed sidecar cannot
# disagree about where worlds live. Reading it rather than duplicating it is the point.
world_s3_prefix() {
  [ -f "$ENV_FILE" ] || die "no $ENV_FILE — copy .env.example to .env first"
  local p
  p="$(grep -E '^WORLD_SYNC_S3_PREFIX=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\042\047')"
  [ -n "$p" ] || die "WORLD_SYNC_S3_PREFIX is not set in $ENV_FILE"
  echo "${p%/}"
}

# Default world name from the service's .env, so `pnpm valheim:world:publish` with no
# argument does the obvious thing rather than making the operator retype a name with a
# space in it.
default_world_name() {
  [ -f "$ENV_FILE" ] || return 1
  grep -E '^GAME_ENV_WORLD_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\042\047'
}

# In-game seconds elapsed, from the save header: int32 worldVersion then a little-endian
# float64 netTime. Valheim only advances this while a player is connected, so it measures
# PLAY, not wall-clock — which is why it, and not mtime, decides which copy is ahead.
# A file copied or re-uploaded keeps its clock; its mtime does not survive either.
world_clock() {
  local f="$1"
  [ -f "$f" ] || return 1
  [ "$(stat -c%s "$f" 2>/dev/null || echo 0)" -ge 12 ] || return 1
  od -An -j4 -N8 -t f8 -- "$f" 2>/dev/null | tr -d ' \n'
}

# Human-readable in-game days. 1800s is a Valheim day.
clock_days() { awk -v s="$1" 'BEGIN { printf "%.1f", s / 1800 }'; }

# True when $1 is strictly behind $2. Float compare, so awk rather than shell arithmetic.
clock_behind() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'; }

# Both halves or neither. A .db without its .fwl will not load, and a mismatched pair
# boots the wrong terrain under the right name — worse than a clean failure.
require_local_pair() {
  local dir="$1" name="$2"
  [ -f "$dir/$name.db" ]  || die "no '$dir/$name.db'"
  [ -f "$dir/$name.fwl" ] || die "no '$dir/$name.fwl' — a .db alone will not load"
}
