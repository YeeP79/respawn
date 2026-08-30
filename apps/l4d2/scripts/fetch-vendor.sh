#!/usr/bin/env bash
# Rebuild vendor/vpk/ from the state bucket, checking every hash.
#
#   fetch-vendor.sh <state-bucket> [aws-profile]
#
# The payload is gitignored and this is how it comes back — the same relationship
# maps.txt has with content/ in apps/tfc/variants/modded, with one difference that
# matters: a Workshop VPK is NOT reproducible from upstream, because the Workshop has no
# version concept and an author can republish under the same id. The bucket copy IS the
# artifact. Losing both the bucket and every local copy means the pin can never be
# honoured again, only replaced with a fresh snapshot under a new hash.
#
# A hash mismatch is a hard failure. Warning and continuing would defeat the entire
# purpose: the bytes not matching the manifest is precisely the event being guarded
# against, and it is indistinguishable from a truncated download.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_vendor-lib.sh"

bucket="$(resolve_bucket "${1:-}")"
profile="${2:-}"
declare -a AWS=(aws)
[ -n "$profile" ] && AWS+=(--profile "$profile")

command -v aws >/dev/null || die "the aws CLI is required"
read_manifest
mkdir -p "$PAYLOAD"

failed=0
for i in "${!WS_ID[@]}"; do
  id="${WS_ID[$i]}"; sha="${WS_SHA[$i]}"; name="${WS_NAME[$i]}"
  dest="$(local_vpk "$id")"
  printf '  %-12s %-46s ' "$id" "${name:0:46}"

  # Already correct? Re-downloading 60 MB to prove nothing is the common case here, since
  # NavFixes alone is most of the payload.
  if [ -f "$dest" ] && [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$sha" ]; then
    echo "ok (cached)"
    continue
  fi

  key="$(s3_key "$id" "$sha")"
  if ! "${AWS[@]}" s3 cp "$bucket/$key" "$dest.part" --only-show-errors 2>/dev/null; then
    echo "MISSING"
    echo "      not in the bucket: $bucket/$key" >&2
    echo "      publish it with:   scripts/publish-vendor.sh ${bucket#s3://} ${profile:-<profile>}" >&2
    rm -f "$dest.part"
    failed=1
    continue
  fi

  got="$(sha256sum "$dest.part" | cut -d' ' -f1)"
  if [ "$got" != "$sha" ]; then
    echo "HASH MISMATCH"
    echo "      expected $sha" >&2
    echo "      got      $got" >&2
    echo "      the object at $key is not what vendor/workshop.txt pins. Nothing is" >&2
    echo "      written; do not 'fix' this by editing the manifest to match." >&2
    rm -f "$dest.part"
    failed=1
    continue
  fi
  mv "$dest.part" "$dest"
  echo "ok ($(stat -c%s "$dest") bytes)"
done

[ "$failed" -eq 0 ] || { echo; echo "one or more VPKs could not be fetched" >&2; exit 1; }
echo
echo "payload: ${PAYLOAD#"$REPO_ROOT"/}"
