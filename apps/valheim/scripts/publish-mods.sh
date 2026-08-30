#!/usr/bin/env bash
# Upload a variant's mods/ payload to the plugin prefix its sidecar syncs from.
#
#   publish-mods.sh <variant> [aws-profile]
#
# Plugins belong to the SERVER, not to a world: they are mirrored one way (S3 -> volume)
# and never written back, so unlike a world save this is safe to re-publish at will.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_world-lib.sh"

resolve_variant "${1:-}"
profile="${2:-}"
prefix="$(world_s3_prefix)"
out="$SVC_DIR/mods"

source_key="$(grep -E '^WORLD_SYNC_PLUGIN_SOURCE=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\042\047')"
[ -n "$source_key" ] || die "variant '$VARIANT' sets no WORLD_SYNC_PLUGIN_SOURCE — it runs no mods.
Publishing plugins to a server that never syncs them would look like it worked."

[ -d "$out" ] || die "no $out — run: pnpm valheim:mods:fetch $VARIANT"

args=()
[ -n "$profile" ] && args+=(--profile "$profile")

# --delete so removing a mod from mods.txt actually removes it server-side. The sidecar
# syncs with --delete too; both halves are needed, or a plugin lingers in exactly one of
# the two places and the set silently stops matching the manifest.
# .world-safe rides along: it is what lets the sidecar decide whether a world that ran
# here has actually been altered, or merely administered.
aws s3 sync "$out" "$prefix/$source_key" --delete \
  --exclude '*' --include '*.dll' --include '.world-safe' "${args[@]}"

n=$(find "$out" -name '*.dll' | wc -l)
cat <<EOF

Published $n plugin(s) to $prefix/$source_key

The sidecar syncs these into the game's plugin directory BEFORE the server starts, so
this takes effect on the next task start, not immediately:
  pnpm respawn  ->  Scale  ->  $(grep -E '^SERVICE_NAME=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')  ->  0, then 1

EVERY CLIENT must run this same set at these same versions or they cannot connect.
Export the matching modpack from r2modman and hand players the code.
EOF
