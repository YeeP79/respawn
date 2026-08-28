#!/usr/bin/env bash
# Mirror the map payload to an S3 bucket for GoldSrc FastDL, or clear it again.
#
#   publish-fastdl.sh <bucket> [profile]            upload
#   publish-fastdl.sh <bucket> [profile] --clear    remove everything under tfc/
#
# Why this exists: HLDS throttles its OWN file transfer to 8 kB/s, so a client joining
# fresh would pull ~49 MB at that rate and time out rather than join. The bucket must
# mirror the tfc/ tree exactly (maps/foo.bsp, foo.wad, sound/...), because the client
# requests the same relative path it would otherwise have downloaded from the server.
#
# This is a PRE-PLAY step, not a runtime dependency. The server never reads the bucket
# — only players do — so an empty or stale bucket makes joins slow but cannot stop the
# server starting. Do not move this into the boot path: that trades a safe failure mode
# for an unsafe one.
set -euo pipefail

bucket="${1:?usage: publish-fastdl.sh <bucket-name> [aws-profile] [--clear]}"
profile=""
clear_mode=0
for arg in "${@:2}"; do
  case "$arg" in
    --clear) clear_mode=1 ;;
    *) profile="$arg" ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
content="$here/content/tfc"

args=()
[ -n "$profile" ] && args+=(--profile "$profile")

if [ "$clear_mode" -eq 1 ]; then
  # Deliberate teardown after a session: the bucket prefix is PUBLIC-READ (GoldSrc
  # clients send no credentials), so content left there stays openly downloadable.
  echo "About to DELETE everything under s3://$bucket/tfc/"
  aws s3 ls "s3://$bucket/tfc/" --recursive "${args[@]}" | tail -5
  printf 'Type the bucket name to confirm: '
  read -r confirm
  [ "$confirm" = "$bucket" ] || { echo "aborted (got '$confirm')" >&2; exit 1; }
  aws s3 rm "s3://$bucket/tfc" --recursive "${args[@]}"
  echo "cleared. Unset GAME_ENV_FASTDL_URL, or joiners fall back to the 8 kB/s path."
  exit 0
fi

[ -d "$content" ] || { echo "no content/ - run fetch-content.sh first" >&2; exit 1; }

# Only what a CLIENT needs. .res/.txt are server-side; info/ is documentation.
aws s3 sync "$content" "s3://$bucket/tfc" \
  --exclude '*.txt' --exclude 'info/*' "${args[@]}"

published=$(find "$content/maps" -name '*.bsp' | wc -l)
cat <<EOF

Published $published maps to s3://$bucket/tfc

  GAME_ENV_FASTDL_URL=https://$bucket.s3.amazonaws.com/tfc

REMINDER - this is only the CLIENT half. The SERVER needs the same maps baked into
its image: they are COPYed from content/ and covered by the image content hash, so
if you added a map since the last deploy you must also rebuild and deploy, or
'changelevel <map>' will fail however complete this bucket is. Add it to mapcycle.txt
too, or the vote will never offer it.

The tfc/ prefix is PUBLIC-READ by necessity. Run with --clear after a session to take
the content down again.
EOF
