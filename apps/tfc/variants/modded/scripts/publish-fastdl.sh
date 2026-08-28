#!/usr/bin/env bash
# Mirror the map payload to an S3 bucket for GoldSrc FastDL, then print the URL to
# put in GAME_ENV_FASTDL_URL.
#
# Why this exists: HLDS throttles its OWN file transfer to 8 kB/s. Without FastDL a
# client joining fresh pulls ~49 MB at that rate and times out instead of joining.
# The bucket must mirror the tfc/ tree exactly (maps/foo.bsp, foo.wad, sound/...),
# because the client requests the same relative path it would have downloaded.
set -euo pipefail
bucket="${1:?usage: publish-fastdl.sh <bucket-name> [aws-profile]}"
profile="${2:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
content="$here/content/tfc"
[ -d "$content" ] || { echo "no content/ - run fetch-content.sh first" >&2; exit 1; }

args=(--exclude '*.txt' --exclude 'info/*')
[ -n "$profile" ] && args+=(--profile "$profile")

# Only the files a CLIENT needs. .res/.txt are server-side; overviews are optional.
aws s3 sync "$content" "s3://$bucket/tfc" "${args[@]}"
echo
echo "Set in apps/tfc/variants/modded/.env:"
echo "  GAME_ENV_FASTDL_URL=https://$bucket.s3.amazonaws.com/tfc"
echo
echo "The bucket must serve these objects publicly over HTTP(S) - GoldSrc clients"
echo "send no credentials. Grant public read on the tfc/ prefix only."
