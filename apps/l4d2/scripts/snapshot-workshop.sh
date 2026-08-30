#!/usr/bin/env bash
# Take a FRESH snapshot of the pinned Workshop items and rewrite their hashes.
#
#   snapshot-workshop.sh [workshop-id ...]      (default: every id in the manifest)
#
# THIS IS THE RE-PIN, and it is deliberately a separate script from the fetch. Running it
# changes what every future build gets; the diff it leaves in vendor/workshop.txt is the
# review, and nothing else in this repo will silently move those bytes.
#
# steamcmd needs no account for this: `+login anonymous` is enough, which is also the only
# reliable way to obtain a Workshop file for a machine that is not running the game —
# Steam RESTORES files you "unsubscribe" by itself, with the game closed, so copying one
# out of a local install is not a repeatable capture (see HANDOFF/testing traps).
#
# The download lands as `<id>_legacy.bin`, which IS the VPK.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_vendor-lib.sh"

command -v steamcmd >/dev/null || die "steamcmd is required (it is the only repeatable way to fetch a Workshop item)"
read_manifest
mkdir -p "$PAYLOAD"

declare -a want=("$@")
[ "${#want[@]}" -gt 0 ] || want=("${WS_ID[@]}")

APPID=550
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

changed=0
for id in "${want[@]}"; do
  # Only ids already in the manifest: adding a new mod is a manifest edit with a comment
  # saying why, not a side effect of running a fetcher.
  idx=-1
  for i in "${!WS_ID[@]}"; do [ "${WS_ID[$i]}" = "$id" ] && idx="$i"; done
  [ "$idx" -ge 0 ] || die "$id is not in $MANIFEST — add it there first, with a line saying what it is"

  echo "  $id  ${WS_NAME[$idx]}"
  steamcmd +force_install_dir "$workdir" +login anonymous \
           +workshop_download_item "$APPID" "$id" +quit >/dev/null

  src="$(find "$workdir" -name "${id}_legacy.bin" -o -name "${id}.vpk" 2>/dev/null | head -1)"
  [ -n "$src" ] || die "steamcmd produced no file for $id (looked for ${id}_legacy.bin)"

  new="$(sha256sum "$src" | cut -d' ' -f1)"
  size="$(stat -c%s "$src")"
  cp -f "$src" "$(local_vpk "$id")"

  if [ "$new" = "${WS_SHA[$idx]}" ]; then
    echo "      unchanged ($new)"
    continue
  fi
  echo "      CHANGED  was ${WS_SHA[$idx]}"
  echo "               now $new"
  # Rewrite in place, preserving the comment. sed on the id anchored at line start, so a
  # hash that happens to contain the digits of another id cannot be hit.
  today="$(date -u +%F)"
  sed -i -E "s|^($id)[[:space:]]+[0-9a-f]{64}[[:space:]]+[0-9]+[[:space:]]+[0-9-]+|\\1  $new  $size  $today|" "$MANIFEST"
  changed=1
done

echo
if [ "$changed" -eq 1 ]; then
  echo "vendor/workshop.txt was rewritten. Review the diff, then:"
  echo "  scripts/publish-vendor.sh <state-bucket> <profile>"
  echo
  echo "The old objects stay in the bucket under their own hashes, so an older commit of"
  echo "this repo still fetches exactly what it was built and tested against."
else
  echo "no hashes changed; nothing to publish"
fi
