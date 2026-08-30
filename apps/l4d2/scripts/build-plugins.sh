#!/usr/bin/env bash
# Compile this service's first-party SourceMod plugins.
#
#   build-plugins.sh [plugin-name ...]      (default: all of them)
#
# The compiler is SourceMod's own spcomp64, which already lives in the L4D2 base image
# alongside the include tree the plugins compile against. Using it from the image rather
# than installing a toolchain locally means the compiler and the includes are the SAME
# ONES THE SERVER RUNS — a plugin built against a different SourceMod version can load
# and then misbehave in ways nothing reports.
#
# Output lands in a gitignored build/ dir: the .sp is tracked, the .smx is not, exactly
# as content/ is to maps.txt. The image build compiles from source too (see the variant
# Dockerfile), so this script is for the local test loop, not the deploy path — nothing
# shipped depends on an artifact somebody built by hand.
set -euo pipefail

SVC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SVC_DIR/../.." && pwd)"
SRC_DIR="$SVC_DIR/plugins"
OUT_DIR="$SVC_DIR/plugins/build"

# The image carrying spcomp64 and the SourceMod includes. Overridable so a variant with
# a different SourceMod pin builds against ITS compiler rather than this default.
IMAGE="${L4D2_BUILD_IMAGE:-l4d2-base-spike:s1}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "error: build image '$IMAGE' not present locally." >&2
  # Name the DEFAULT image in the hint, not $IMAGE — if someone overrode it to
  # something that does not exist, telling them to build that name is wrong advice.
  echo "       build the default:  docker build -f lab/s1-modded-image/Dockerfile -t l4d2-base-spike:s1 lab/s1-modded-image" >&2
  echo "       or point elsewhere:  L4D2_BUILD_IMAGE=<image> $0" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# Which plugins? Named ones, or everything tracked.
declare -a plugins=()
if [ "$#" -gt 0 ]; then
  for name in "$@"; do
    f="$SRC_DIR/${name%.sp}.sp"
    [ -f "$f" ] || { echo "error: no such plugin source: $f" >&2; exit 1; }
    plugins+=("$(basename "$f")")
  done
else
  while IFS= read -r f; do plugins+=("$(basename "$f")"); done \
    < <(find "$SRC_DIR" -maxdepth 1 -name '*.sp' | sort)
fi

[ "${#plugins[@]}" -gt 0 ] || { echo "no .sp files in $SRC_DIR"; exit 0; }

echo "compiler image: $IMAGE"
failed=0
for p in "${plugins[@]}"; do
  printf '  %-32s ' "$p"
  # spcomp64 exits 0 on warnings, so the .smx is checked for separately — the same
  # `test -f` gate the image build uses, for the same reason.
  out="$(docker run --rm \
      -v "$SRC_DIR:/src:ro" -v "$OUT_DIR:/out" \
      --entrypoint /bin/bash "$IMAGE" -c \
      "cd /addons/sourcemod/scripting && ./spcomp64 -i include /src/$p -o /out/${p%.sp}.smx 2>&1" || true)"
  if [ -f "$OUT_DIR/${p%.sp}.smx" ]; then
    echo "ok  ($(stat -c%s "$OUT_DIR/${p%.sp}.smx") bytes)"
    # Warnings compile fine and are still worth seeing.
    echo "$out" | grep -iE 'warning' | sed 's/^/      /' || true
  else
    echo "FAILED"
    echo "$out" | sed 's/^/      /'
    failed=1
  fi
done

[ "$failed" -eq 0 ] || { echo; echo "one or more plugins failed to compile" >&2; exit 1; }
echo
echo "output: ${OUT_DIR#"$REPO_ROOT"/}"
