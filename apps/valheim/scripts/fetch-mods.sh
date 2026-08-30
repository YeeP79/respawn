#!/usr/bin/env bash
# Rebuild a variant's mods/ payload from its tracked mods.txt.
#
#   fetch-mods.sh <variant>
#
# Same relationship maps.txt has with content/ in apps/tfc/variants/modded: the manifest
# is tracked, the payload is gitignored and reproducible from it. Unlike a world save,
# losing mods/ costs nothing.
#
# A manifest may `include` another, so a set shared by several variants — the QoL base,
# the admin base — is declared once and cannot drift between them. The effective flat set
# is written to the variant's tracked mods.lock, which is what a player's modpack has to
# match and where an unintended change shows up as a diff in review.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_world-lib.sh"

resolve_variant "${1:-}"
manifest="$SVC_DIR/mods.txt"
out="$SVC_DIR/mods"
lock="$SVC_DIR/mods.lock"
[ -f "$manifest" ] || die "no $manifest"
command -v unzip >/dev/null || die "unzip is required"
command -v jq >/dev/null || die "jq is required (dependency closure is read from each package's manifest.json)"

# --- pass 1: flatten the manifest and its includes ---------------------------
# Declared order is preserved for readability; correctness does not depend on it, since
# BepInEx loads plugins from one flat directory and decides its own order.
declare -A SEEN_FILE=() VER=() SAFE=() FROM=()
declare -a ORDER=()

merge_line() {
  local pkg="$1" ver="$2" flag="$3" src="$4"
  [ -n "$ver" ] || die "no version for '$pkg' in $src
Pin an exact version, or clients cannot match the server."
  case "$pkg" in */*) ;; *) die "expected <namespace>/<package>, got '$pkg' in $src" ;; esac

  if [ -n "${VER[$pkg]:-}" ]; then
    # Two manifests reaching the same package must agree. Silently keeping one version
    # would mean the lockfile and half the includes describe different servers.
    [ "${VER[$pkg]}" = "$ver" ] || die "version conflict for $pkg:
  ${VER[$pkg]}  (${FROM[$pkg]})
  $ver  ($src)
Pin both to the same version."
    # Unflagged anywhere means unflagged: world-safe is an assertion about the whole run,
    # and one manifest declining to make it is the conservative answer.
    [ "$flag" = "world-safe" ] || SAFE[$pkg]=""
    return 0
  fi

  VER[$pkg]="$ver"; FROM[$pkg]="$src"; ORDER+=("$pkg")
  if [ "$flag" = "world-safe" ]; then SAFE[$pkg]=1; else SAFE[$pkg]=""; fi
}

flatten() {
  local file="$1" dir abs a b c _rest
  dir="$(cd "$(dirname "$file")" 2>/dev/null && pwd)" || die "no such manifest: $file"
  abs="$dir/$(basename "$file")"
  [ -f "$abs" ] || die "no such manifest: $file"
  # A manifest reached twice contributes once. This is what makes the lattice expressible:
  # variants/overhaul includes both loot and build, and both include the QoL base.
  if [ -n "${SEEN_FILE[$abs]:-}" ]; then return 0; fi
  SEEN_FILE[$abs]=1

  while read -r a b c _rest || [ -n "${a:-}" ]; do
    case "${a:-}" in ''|\#*) continue ;; esac
    if [ "$a" = "include" ]; then
      [ -n "${b:-}" ] || die "'include' with no path in $abs"
      flatten "$dir/$b"
      continue
    fi
    merge_line "$a" "${b:-}" "${c:-}" "$abs"
  done < "$abs"
}

flatten "$manifest"

# --- pass 2: fetch every declared package ------------------------------------
# Built in a temp dir and moved into place only once the whole set is good. A partial
# payload is worse than none: publish-mods.sh would upload it and the server would come
# up missing plugins, which BepInEx logs and otherwise survives.
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/out" "$staging/meta"

count=0
for pkg in ${ORDER[@]+"${ORDER[@]}"}; do
  version="${VER[$pkg]}"
  ns="${pkg%%/*}"; name="${pkg##*/}"
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

  # Kept for pass 3. Thunderstore's manifest.json is the only place a package states what
  # it needs, and it is discarded with the rest of the archive otherwise.
  if [ -f "$tmp/x/manifest.json" ]; then
    cp "$tmp/x/manifest.json" "$staging/meta/$ns.$name.json"
  fi

  # A BepInEx PATCHER is not a plugin and cannot be delivered by this pipeline. Patchers
  # run in the preloader phase from BepInEx/patchers/, and the upstream image's
  # write_bepinex_config syncs exactly one directory — $config_path/plugins/ -> the live
  # plugin dir — with no patcher equivalent anywhere. So a patcher DLL flattened in with
  # the plugins is installed to a directory nothing reads it from: it never runs, the mod
  # that needed it fails to load, and BepInEx logs that and carries on. Refusing is the
  # only honest outcome; delivering patchers would need a second prefix, a second sidecar
  # sync, and the PRE_SERVER_RUN_HOOK shim to place them inside /opt.
  if find "$tmp/x" -path '*/patchers/*' -name '*.dll' | grep -q .; then
    rm -rf "$tmp"
    die "$ns/$name $version is (or contains) a BepInEx PATCHER, which this pipeline cannot install.

Patchers load from BepInEx/patchers/ during the preloader phase. The upstream image only
ever syncs plugins/, so a patcher would be copied somewhere nothing reads and the mod
depending on it would fail to load — silently, in a server that otherwise looks healthy.

Drop the mod that requires it, or add patcher delivery (a second published prefix, a
second sidecar sync, and a copy into /opt from the PRE_SERVER_RUN_HOOK shim)."
  fi

  # Thunderstore packages vary: some put DLLs at the root, some under plugins/. The game
  # only ever loads .dll files from its plugin dir, so collect those wherever they are
  # and ignore the icon/README/manifest that every package ships.
  found=0
  while IFS= read -r dll; do
    cp "$dll" "$staging/out/"
    found=$((found + 1))
    # An operator assertion, not a fact we can derive: nothing in a .dll says whether it
    # writes prefabs. Recorded per file so the sidecar can tell a world-altering plugin
    # from an admin-only one, and so the assertion lands in the world's stamp where a
    # human can audit it later.
    if [ -n "${SAFE[$pkg]:-}" ]; then basename "$dll" >> "$staging/out/.world-safe"; fi
  done < <(find "$tmp/x" -name '*.dll')
  [ "$found" -gt 0 ] || die "$ns/$name $version contained no .dll — is it a client-only or asset-only package?"
  rm -rf "$tmp"
  count=$((count + 1))
done

# --- pass 3: verify the dependency closure -----------------------------------
# Thunderstore dependencies are NOT fetched automatically, on purpose. A plugin that
# nobody declared is a plugin nobody assessed: world-safe is an operator assertion, and
# auto-fetching would silently add packages with no assertion attached — the default
# being unsafe, one of them would quietly make every world here world-altering. So the
# closure is checked and the missing lines are printed for a human to add.
#
# Neither a Thunderstore owner nor a package name may contain '-', so the first '-'
# separates them and the last separates the version.
missing=""
for f in "$staging"/meta/*.json; do
  [ -e "$f" ] || continue
  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    rest="${dep%-*}"; dver="${dep##*-}"
    dns="${rest%%-*}"; dname="${rest#*-}"
    # The image installs BepInExPack itself when GAME_ENV_BEPINEX=true and would fight a
    # second copy dropped into plugins/.
    if [ "$dname" = "BepInExPack_Valheim" ]; then continue; fi
    if [ -n "${VER[$dns/$dname]:-}" ]; then continue; fi
    case "$missing" in *"$dns/$dname $dver"*) continue ;; esac
    missing="$missing$dns/$dname $dver
"
  done < <(jq -r '.dependencies[]?' "$f")
done

if [ -n "$missing" ]; then
  die "mods.txt is missing packages that the declared set depends on:

$(printf '%s' "$missing" | sed 's/^/  /')
Add each to a manifest, with a world-safe flag ONLY if you are asserting it writes no
prefabs into the save. Nothing here is fetched for you: an undeclared plugin carries no
assertion, and the default is unsafe."
fi

# --- pass 4: swap the payload in and write the lockfile ----------------------
rm -rf "$out"
mv "$staging/out" "$out"

{
  echo "# GENERATED by fetch-mods.sh from mods.txt (and everything it includes)."
  echo "# Tracked so the effective set is reviewable and so a player's modpack has one"
  echo "# authoritative list to match. Do not hand-edit — edit a mods.txt and re-run:"
  echo "#   pnpm valheim:mods:fetch $VARIANT"
  echo "#"
  echo "# <namespace>/<package> <version> [world-safe]"
  for pkg in ${ORDER[@]+"${ORDER[@]}"}; do
    if [ -n "${SAFE[$pkg]:-}" ]; then echo "$pkg ${VER[$pkg]} world-safe"; else echo "$pkg ${VER[$pkg]}"; fi
  done | sort
} > "$lock"

echo
safe=0
if [ -f "$out/.world-safe" ]; then safe=$(wc -l < "$out/.world-safe"); fi
echo "fetched $count package(s) -> $(find "$out" -name '*.dll' | wc -l) plugin(s) in $out/"
echo "  $safe declared world-safe (admin/UI only, writes no prefabs into the save)"
if [ "$count" -eq 0 ]; then
  echo "(the manifest lists none — BepInEx will load with no plugins, which is a valid state)"
elif [ "$safe" -eq "$(find "$out" -name '*.dll' | wc -l)" ]; then
  echo "  every plugin is world-safe, so worlds run here stay stamped 'vanilla' and can"
  echo "  still go back to a vanilla server"
else
  echo "  ONE-WAY: worlds run here are stamped 'modded' and a vanilla server will refuse"
  echo "  them for ever. Snapshot a world under a new name before its first run."
fi
echo "wrote $lock"
echo "publish with: pnpm valheim:mods:publish $VARIANT"
