#!/usr/bin/env bash
# Pre-launch check: is the pushed image current, and does FastDL have what it needs?
#
#   check-content.sh <bucket> [profile] [--cycle <name>]
#
# Answers the question you cannot answer by looking at the server: the two halves of a
# content change drift independently and BOTH fail silently at launch time —
#
#   image stale     the .bsp is not in the image -> `changelevel <map>` fails outright
#   S3 stale        the map loads, but every joiner pulls it at HLDS's 8 kB/s cap and
#                   times out instead of connecting
#
# Exits non-zero on either, so it is usable as a gate before deploying or scaling up.
set -euo pipefail

bucket="${1:?usage: check-content.sh <bucket> [aws-profile] [--cycle <name>]}"
profile=""; cycle="all"
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --cycle) cycle="$2"; shift 2 ;;
    *) profile="$1"; shift ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
content="$here/content/tfc"
cyclefile="$here/mapcycles/${cycle}.txt"
args=(); [ -n "$profile" ] && args+=(--profile "$profile")
fail=0

[ -d "$content" ]   || { echo "FAIL: no content/ — run fetch-content.sh" >&2; exit 1; }
[ -f "$cyclefile" ] || { echo "FAIL: no such cycle '${cycle}'" >&2; exit 1; }

# --- 1. is the image that would launch built from THIS content? -------------------
# The tag is a content hash over the Dockerfile plus every COPYed file, so if the
# current tree does not correspond to a tag in ECR, the image predates a content edit.
echo "== image freshness =="
tag=$(cd "$here/../../../.." && npx tsx --conditions development -e "
import { collectImageInputs, computeImageTag, parseBaseImage } from './libs/core/src/utils/image-hash.js';
import { resolveBaseImageDigest } from './libs/docker-utils/src/docker.js';
import * as fs from 'node:fs';
const df = 'apps/tfc/variants/modded/Dockerfile';
const base = parseBaseImage(fs.readFileSync(df,'utf-8'));
console.log(computeImageTag(collectImageInputs(df, process.cwd(), await resolveBaseImageDigest(base))));
" 2>/dev/null | tail -1)
if [ -z "$tag" ]; then
  echo "  WARN: could not compute the image tag; skipping this check"
elif aws ecr describe-images --repository-name respawn/tfc --image-ids "imageTag=$tag" \
       --region us-east-1 "${args[@]}" >/dev/null 2>&1; then
  echo "  OK   $tag is in ECR — the image matches the local content"
else
  echo "  FAIL $tag is NOT in ECR — local content changed since the last push."
  echo "       A map added since then is missing from the image: changelevel will fail."
  echo "       Fix: pnpm respawn --action push --service tfc"
  fail=1
fi

# --- 2. does FastDL carry every file a client needs for this cycle? ---------------
echo "== fastdl coverage (cycle: ${cycle}) =="
# Both temps declared before the trap: under `set -u` a trap referencing an unset
# variable aborts the script mid-check, which reads as a passing run.
remote=$(mktemp); want=$(mktemp)
trap 'rm -f "$remote" "$want"' EXIT
# `aws s3 ls` exits 1 on an EMPTY prefix, so under `set -e` this check would die
# precisely in the case it exists to detect — an empty bucket. Swallow the status and
# let the comparison below decide.
aws s3 ls "s3://$bucket/tfc/" --recursive "${args[@]}" 2>/dev/null \
  | awk '{ $1=""; $2=""; $3=""; sub(/^ +/,""); print }' | sort > "$remote" || true

while read -r m; do
  case "$m" in ''|//*) continue ;; esac
  # A stock map ships with the base image; clients already have it.
  [ -f "$content/maps/$m.bsp" ] || continue
  echo "tfc/maps/$m.bsp"
done < "$cyclefile" | sort > "$want"
# Wads are shared across maps and are equally required for a client to render one.
find "$content" -maxdepth 1 -name '*.wad' -printf 'tfc/%f\n' | sort >> "$want"
sort -o "$want" "$want"

missing=$(comm -23 "$want" "$remote" | head -100)
n_want=$(wc -l < "$want"); n_missing=$(printf '%s' "$missing" | grep -c . || true)
if [ "$n_missing" -eq 0 ]; then
  echo "  OK   all $n_want client files present in s3://$bucket/tfc"
else
  echo "  FAIL $n_missing of $n_want client files missing from s3://$bucket/tfc"
  printf '%s\n' "$missing" | head -8 | sed 's/^/         /'
  [ "$n_missing" -gt 8 ] && echo "         … and $((n_missing - 8)) more"
  echo "       Joiners will fall back to HLDS's 8 kB/s transfer and time out."
  echo "       Fix: pnpm tfc:content:publish $bucket ${profile:-<profile>}"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "== ready to launch ==" || echo "== NOT ready — see failures above =="
exit "$fail"
