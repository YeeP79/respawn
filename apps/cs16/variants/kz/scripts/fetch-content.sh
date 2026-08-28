#!/usr/bin/env bash
# Rebuild apps/cs16/variants/kz/content/ from maps.txt.
#
# The payload is gitignored (see .gitignore), so a fresh clone has none — the same
# shape as .env. Docker's build context ignores .gitignore, so the files are still
# covered by the image content hash once present.
#
# kreedz.com serves each map from GET /api/map/<name> as an attachment; the zip
# contains a cstrike/-rooted tree (maps/, plus any wads/models the map needs).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
content="$here/content"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$content"

# kreedz.com rate-limits downloads and answers 429 after a few rapid requests
# (measured: it cut us off after 4). This is a volunteer-run community archive, so
# throttle deliberately and back off rather than hammering it. Override with
# KZ_FETCH_DELAY if you are re-running a small number of maps.
delay="${KZ_FETCH_DELAY:-4}"

fetch_one() { # fetch_one <url> <dest> — retries on 429 with growing backoff
  local url="$1" dest="$2" attempt=1 wait=10
  while [ "$attempt" -le 5 ]; do
    local code
    code=$(curl -sSL -m 180 -o "$dest" -w '%{http_code}' \
      -H "Referer: https://kreedz.com/" -H "User-Agent: Mozilla/5.0" "$url" || true)
    case "$code" in
      200) return 0 ;;
      429) echo "    rate-limited (429), waiting ${wait}s (attempt ${attempt}/5)"
           sleep "$wait"; wait=$((wait * 2)); attempt=$((attempt + 1)) ;;
      *)   echo "    HTTP ${code} for ${url}" >&2; return 1 ;;
    esac
  done
  echo "    gave up after 5 attempts: $url" >&2
  return 1
}

n=0; failed=""
while read -r name type difficulty url; do
  case "$name" in ''|\#*) continue ;; esac
  [ -n "${url:-}" ] || { echo "malformed line for ${name}: expected <name> <type> <difficulty> <url>" >&2; exit 1; }
  # Already extracted from a previous (possibly interrupted) run — skip the download.
  if [ -f "$content/maps/$name.bsp" ]; then
    echo "  have $name"; n=$((n+1)); continue
  fi
  echo "  fetching $name ($difficulty)"
  if fetch_one "$url" "$work/$name.zip"; then
    unzip -qo "$work/$name.zip" -d "$content"
    n=$((n+1))
  else
    failed="$failed $name"
  fi
  sleep "$delay"
done < "$here/maps.txt"

[ -n "$failed" ] && echo "FAILED:$failed" >&2

# GoldSrc on Linux is case-sensitive; `changelevel` takes the lowercase name. Archives
# are inconsistent about this, so normalise rather than trusting them.
find "$content" -path '*/maps/*' -name '*[A-Z]*' -type f 2>/dev/null | while read -r f; do
  lc="$(dirname "$f")/$(basename "$f" | tr 'A-Z' 'a-z')"
  [ "$f" != "$lc" ] && mv -- "$f" "$lc" && echo "  lowercased $(basename "$f")"
done

echo "content ready: $(find "$content" -name '*.bsp' | wc -l) maps from $n archives, $(du -sh "$content" | cut -f1)"
