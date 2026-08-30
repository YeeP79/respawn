#!/usr/bin/env bash
# Shared bits for the Workshop vendoring scripts. Sourced, never run.
#
# One place to parse vendor/workshop.txt so the three scripts cannot disagree about what
# the pin says — the failure that shape produces is a publish and a fetch that quietly
# reference different objects.

SVC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SVC_DIR/../.." && pwd)"
MANIFEST="$SVC_DIR/vendor/workshop.txt"
PAYLOAD="$SVC_DIR/vendor/vpk"

# The prefix is fixed rather than derived from SERVICE_NAME: these VPKs are shared by
# every l4d2 variant, and keying them per service would mean N copies of a 60 MB file
# that are required by construction to be identical.
S3_PREFIX="l4d2/workshop"

die() { echo "error: $*" >&2; exit 1; }

# Populates the parallel arrays WS_ID / WS_SHA / WS_SIZE / WS_NAME.
read_manifest() {
  [ -f "$MANIFEST" ] || die "no manifest at $MANIFEST"
  WS_ID=(); WS_SHA=(); WS_SIZE=(); WS_NAME=()
  local line id sha size captured name
  while IFS= read -r line; do
    # Strip comments and blanks. A trailing `# name` is documentation, not data — but it
    # is the only human-readable label these ids have, so it is kept.
    name="${line#*#}"
    [ "$name" = "$line" ] && name=""
    line="${line%%#*}"
    # shellcheck disable=SC2086
    set -- $line
    [ "$#" -eq 0 ] && continue
    [ "$#" -eq 4 ] || die "malformed manifest line (want: id sha256 bytes captured): $*"
    id="$1"; sha="$2"; size="$3"; captured="$4"
    case "$id" in ''|*[!0-9]*) die "workshop id is not numeric: $id" ;; esac
    # Length alone is not enough: a 64-character string that is not lowercase hex builds
    # a key that can never match an uploaded object, and the failure surfaces as
    # "not in the bucket" — which reads as a missing upload rather than a bad manifest.
    case "$sha" in
      *[!0-9a-f]* | "") die "sha256 for $id is not 64 lowercase hex chars: $sha" ;;
    esac
    [ "${#sha}" -eq 64 ] || die "sha256 for $id is not 64 lowercase hex chars: $sha"
    case "$size" in ''|*[!0-9]*) die "size for $id is not numeric: $size" ;; esac
    WS_ID+=("$id"); WS_SHA+=("$sha"); WS_SIZE+=("$size")
    WS_NAME+=("$(echo "$name" | sed 's/^ *//; s/ *$//')")
  done < "$MANIFEST"
  [ "${#WS_ID[@]}" -gt 0 ] || die "manifest is empty"
}

# The object key carries the content hash, so a re-snapshot never overwrites the bytes an
# older commit still fetches. See the header of vendor/workshop.txt.
s3_key() { echo "$S3_PREFIX/$1-$2.vpk"; }

# Local file name matches what the Dockerfile COPYs and what a server expects in addons/.
local_vpk() { echo "$PAYLOAD/$1.vpk"; }

resolve_bucket() {
  local arg="${1:-}"
  [ -n "$arg" ] || die "usage: $(basename "$0") <state-bucket|s3://bucket/prefix> [aws-profile]"
  case "$arg" in
    s3://*) echo "${arg%/}" ;;
    *)      echo "s3://$arg" ;;
  esac
}
