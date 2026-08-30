#!/usr/bin/env bash
# Rebuild a variant's mods/ payload from its tracked mods.txt.
#
#   fetch-mods.sh <variant>
#
# Same relationship maps.txt has with content/ in apps/tfc/variants/modded: the manifest
# is tracked, the payload is gitignored and reproducible from it. Unlike a world save,
# losing mods/ costs nothing.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_world-lib.sh"

resolve_variant "${1:-}"
manifest="$SVC_DIR/mods.txt"
out="$SVC_DIR/mods"
[ -f "$manifest" ] || die "no $manifest"
command -v unzip >/dev/null || die "unzip is required"

# Rebuilt from scratch every time, so REMOVING a line actually removes the plugin. An
# additive fetch would leave a deleted mod in the payload, publish it, and keep loading
# a mod nobody believes is installed — which then writes its prefabs into the world.
rm -rf "$out"
mkdir -p "$out"

count=0
while read -r pkg version flag _rest; do
  case "${pkg:-}" in ''|\#*) continue ;; esac
  [ -n "${version:-}" ] || die "no version for '$pkg' in mods.txt — pin an exact version, or clients cannot match the server"
  ns="${pkg%%/*}"; name="${pkg##*/}"
  [ "$ns" != "$pkg" ] || die "expected <namespace>/<package>, got '$pkg'"

  url="https://thunderstore.io/package/download/$ns/$name/$version/"
  tmp="$(mktemp -d)"
  echo "fetching $ns/$name $version"
  if ! curl -fsSL "$url" -o "$tmp/pkg.zip"; then
    rm -rf "$tmp"
    die "could not download $url
Check the namespace, package name and version against thunderstore.io — a 404 here is
almost always a version that does not exist rather than a network problem."
  fi
  unzip -qo "$tmp/pkg.zip" -d "$tmp/x"
  # Thunderstore packages vary: some put DLLs at the root, some under plugins/. The game
  # only ever loads .dll files from its plugin dir, so collect those wherever they are
  # and ignore the icon/README/manifest that every package ships.
  found=0
  while IFS= read -r dll; do
    cp "$dll" "$out/"
    found=$((found + 1))
    # An operator assertion, not a fact we can derive: nothing in a .dll says whether it
    # writes prefabs. Recorded per file so the sidecar can tell a world-altering plugin
    # from an admin-only one, and so the assertion lands in the world's stamp where a
    # human can audit it later.
    [ "${flag:-}" = "world-safe" ] && basename "$dll" >> "$out/.world-safe"
  done < <(find "$tmp/x" -name '*.dll')
  [ "$found" -gt 0 ] || die "$ns/$name $version contained no .dll — is it a client-only or asset-only package?"
  rm -rf "$tmp"
  count=$((count + 1))
done < "$manifest"

echo
safe=0
[ -f "$out/.world-safe" ] && safe=$(wc -l < "$out/.world-safe")
echo "fetched $count package(s) -> $(find "$out" -name '*.dll' | wc -l) plugin(s) in $out/"
echo "  $safe declared world-safe (admin/UI only, writes no prefabs into the save)"
[ "$count" -eq 0 ] && echo "(mods.txt lists none — BepInEx will load with no plugins, which is a valid state)"
echo "publish with: pnpm valheim:mods:publish $VARIANT"
