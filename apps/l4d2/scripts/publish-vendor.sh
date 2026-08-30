#!/usr/bin/env bash
# Upload the vendored Workshop VPKs to the state bucket.
#
#   publish-vendor.sh <state-bucket> [aws-profile]
#
# Use the PRIVATE state bucket (respawn-state-*), never the public FastDL one. These are
# other people's published work and the point of mirroring them is a reproducible build,
# not redistribution — a public-read bucket turns one into the other.
#
# Uploads are content-addressed and therefore idempotent: an object whose key already
# exists holds the same bytes by construction, so it is skipped rather than re-sent.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_vendor-lib.sh"

bucket="$(resolve_bucket "${1:-}")"
profile="${2:-}"
declare -a AWS=(aws)
[ -n "$profile" ] && AWS+=(--profile "$profile")

command -v aws >/dev/null || die "the aws CLI is required"
read_manifest

for i in "${!WS_ID[@]}"; do
  id="${WS_ID[$i]}"; sha="${WS_SHA[$i]}"; name="${WS_NAME[$i]}"
  src="$(local_vpk "$id")"
  printf '  %-12s %-46s ' "$id" "${name:0:46}"

  [ -f "$src" ] || die "no local copy at ${src#"$REPO_ROOT"/} — run scripts/snapshot-workshop.sh first"

  # Verify BEFORE uploading. Publishing bytes that do not match the manifest would put an
  # object in the bucket that every later fetch rejects, and the failure would surface far
  # from here.
  got="$(sha256sum "$src" | cut -d' ' -f1)"
  [ "$got" = "$sha" ] || die "local $id does not match the manifest (expected $sha, got $got)"

  key="$(s3_key "$id" "$sha")"
  if "${AWS[@]}" s3api head-object --bucket "${bucket#s3://}" --key "$key" >/dev/null 2>&1; then
    echo "ok (already published)"
    continue
  fi
  "${AWS[@]}" s3 cp "$src" "$bucket/$key" --only-show-errors
  echo "uploaded"
done
echo
echo "published to $bucket/$S3_PREFIX/"
