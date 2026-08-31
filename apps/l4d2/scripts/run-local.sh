#!/usr/bin/env bash
# Run a variant's image locally, configured the way ECS would configure it.
#
#   run-local.sh [variant] [--build] [--name <container>]
#
# WHY THIS EXISTS
# "Do the mods work" and "does it run on Fargate" are different questions, and only the
# second one needs AWS. This answers the first in seconds instead of a 16 GB push, using
# the SAME image the deploy builds and the same env the task definition gets — the env
# vars below are the variant's own GAME_ENV_* with the prefix stripped, which is exactly
# what loader.ts does.
#
# IT DELIBERATELY PUBLISHES NO PORT, and that is the whole trick. docker-proxy passes A2S
# and BREAKS the Source connect handshake, so a published port gives a server every health
# check calls healthy and no client can join — measured, and it cost hours. Connect to the
# container's own bridge IP instead, which this script prints. `--network host` is not the
# fix either: the container's Steam collides with the host's and breaks A2S too.
set -euo pipefail

SVC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SVC_DIR/../.." && pwd)"

variant="modded"
name=""
build=0
for arg in "$@"; do
  case "$arg" in
    --build) build=1 ;;
    --name)  name="__NEXT__" ;;
    *) if [ "$name" = "__NEXT__" ]; then name="$arg"; else variant="$arg"; fi ;;
  esac
done
[ "$name" = "__NEXT__" ] && { echo "error: --name needs a value" >&2; exit 1; }

VAR_DIR="$SVC_DIR/variants/$variant"
[ -d "$VAR_DIR" ] || { echo "error: no such variant: $variant" >&2
                       echo "       have: $(ls "$SVC_DIR/variants" | tr '\n' ' ')" >&2; exit 1; }
[ -f "$VAR_DIR/.env" ] || { echo "error: $VAR_DIR/.env is missing (cp .env.example .env)" >&2; exit 1; }

image="l4d2-$variant:local"
name="${name:-l4d2-$variant-local}"

# Read a key from the layered env files, variant winning over the project base — the same
# precedence the loader applies, so a value tested here is the value that deploys.
getenv() {
  local key="$1" val=""
  for f in "$SVC_DIR/.env" "$VAR_DIR/.env"; do
    [ -f "$f" ] || continue
    local v
    v="$(grep -E "^${key}=" "$f" | tail -1 | cut -d= -f2- || true)"
    [ -n "$v" ] && val="$v"
  done
  # dotenv strips an inline comment, and so must this — otherwise a commented value is
  # passed to the game with the comment attached.
  val="${val%%#*}"
  # Strip one layer of surrounding quotes and trailing space.
  val="$(echo "$val" | sed 's/[[:space:]]*$//; s/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/')"
  printf '%s' "$val"
}

if [ "$build" -eq 1 ]; then
  echo "building $image (context is the repo root, as deploy.ts does)..."
  docker build -t "$image" -f "$VAR_DIR/Dockerfile" "$REPO_ROOT"
fi
docker image inspect "$image" >/dev/null 2>&1 || {
  echo "error: $image is not built. Run: $0 $variant --build" >&2; exit 1; }

# The rcon password. NOT read from AWS: this is a throwaway local server and reaching for
# the real credential to run one would put it in a shell history and a container env for
# no benefit. Override with RCON_PASSWORD=... if you are reproducing something specific.
rconpw="${RCON_PASSWORD:-localrcon}"

# +sv_lan 1 so the client connects without a Steam ticket, and it is appended to whatever
# the variant already declares rather than replacing it — sv_allow_lobby_connect_only 0
# lives in EXTRA_ARGS and defaults to 1, which refuses direct `connect` outright.
extra="$(getenv GAME_ENV_EXTRA_ARGS) +sv_lan 1"

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" \
  -e "HOSTNAME=$(getenv GAME_ENV_HOSTNAME) [local]" \
  -e "REGION=$(getenv GAME_ENV_REGION)" \
  -e "MOTD=$(getenv GAME_ENV_MOTD)" \
  -e "DEFAULT_MAP=$(getenv GAME_ENV_DEFAULT_MAP)" \
  -e "DEFAULT_MODE=$(getenv GAME_ENV_DEFAULT_MODE)" \
  -e "GAME_TYPES=$(getenv GAME_ENV_GAME_TYPES)" \
  -e "L4B_ADMINS=$(getenv GAME_ENV_L4B_ADMINS)" \
  -e "EXTRA_ARGS=$extra" \
  -e "RCON_PASSWORD=$rconpw" \
  "$image" >/dev/null

printf 'waiting for the server to answer'
ip=""
for _ in $(seq 1 40); do
  sleep 3; printf '.'
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name" 2>/dev/null || true)"
  [ -n "$ip" ] && [ "$ip" != "invalid IP" ] || continue
  if python3 "$REPO_ROOT/lab/srcds-rcon.py" "$ip" 27015 "$rconpw" status >/dev/null 2>&1; then
    echo; break
  fi
done
echo

if [ -z "$ip" ] || [ "$ip" = "invalid IP" ]; then
  echo "the container is not running — docker logs $name" >&2
  docker logs "$name" 2>&1 | tail -20 >&2
  exit 1
fi

cat <<INFO
  container : $name  ($image)
  connect   : $ip:27015          <- paste into the game console, NOT localhost
  rcon      : python3 lab/srcds-rcon.py $ip 27015 $rconpw "<command>"
  logs      : docker logs -f $name

The connect address is the container's bridge IP on purpose. A published port passes
every health check and refuses every client (docker-proxy breaks the Source handshake).
INFO
