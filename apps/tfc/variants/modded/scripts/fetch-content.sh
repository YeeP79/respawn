#!/usr/bin/env bash
# Rebuild apps/tfc/variants/modded/content/ from maps.txt.
#
# The payload is ~49 MB of binaries and is gitignored, so a fresh clone has none —
# the same shape as .env. Docker's build context ignores .gitignore, so the files
# are still covered by the image content hash once present.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
content="$here/content"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT

mkdir -p "$content"
# maps.txt is <name> <category> <url>; category drives mapcycle generation, not fetch.
while read -r name category url; do
  case "$name" in ''|\#*) continue ;; esac
  [ -n "${url:-}" ] || { echo "malformed line for ${name}: expected <name> <category> <url>" >&2; exit 1; }
  echo "  fetching $name"
  curl -fsSL -m 120 -o "$work/$name.zip" \
    -H "Referer: https://tfcmaps.net/" \
    -H "User-Agent: Mozilla/5.0" "$url"
  unzip -qo "$work/$name.zip" -d "$content"
done < "$here/maps.txt"

# GoldSrc on Linux is case-sensitive; changelevel takes the lowercase name.
find "$content/tfc/maps" -maxdepth 1 -name '*[A-Z]*' -type f | while read -r f; do
  lc="$(dirname "$f")/$(basename "$f" | tr 'A-Z' 'a-z')"
  [ "$f" != "$lc" ] && mv -- "$f" "$lc" && echo "  lowercased $(basename "$f")"
done

echo "content ready: $(find "$content" -name '*.bsp' | wc -l) maps, $(du -sh "$content" | cut -f1)"
