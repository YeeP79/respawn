#!/bin/sh
# Put the rcon password into the rcon plugin's BepInEx config, in the ONE place and at
# the ONE moment where that works.
#
# WHY THIS EXISTS AT ALL. ValheimRcon is config-FILE driven, so its password cannot be a
# GAME_ENV_ value — that lands in the ECS task definition in plaintext, which is the
# thing SECRET_REFS exists to prevent. It has to be written into a file, from a secret,
# inside the container.
#
# WHY NOT THE world-sync SIDECAR, WHICH ALREADY HAD THE SECRET AND A VOLUME. Measured on
# the first real deploy: the sidecar wrote /config/bepinex/config/org.tristan.rcon.cfg at
# 23:21:39, the image performed a "Fresh BepInEx install" into /opt/valheim/bepinex at
# 23:23:57, and the plugin loaded at 23:24:15 reading the /opt tree — never the volume.
# It logged "Password is empty. Plugin will not work." and then, crucially, KEPT
# LISTENING: an empty password does not disable the listener, it makes it reject every
# auth. So the failure presented as "rcon password rejected", which reads like a wrong
# credential rather than a config that was never read.
#
# The volume is not reachable from where the plugin reads, and /opt is not reachable from
# the sidecar. Only the game container has both the secret and the live BepInEx tree —
# hence a shim, which is also what CLAUDE.md prescribes for a config-file-driven upstream.
#
# TIMING IS THE WHOLE POINT. Wired to PRE_SERVER_RUN_HOOK, which fires after the updater
# has installed/merged BepInEx and before the server process starts. Earlier (bootstrap,
# POST_BEPINEX_CONFIG_HOOK) is too early: the fresh install lands on top. The plugin's own
# config descriptions say "[Server restart required for update]", so being late is not
# recoverable within a run either.
set -u

log() { echo "[respawn-rcon-config] $*"; }

if [ -z "${RCON_PASSWORD:-}" ]; then
  # Not fatal: a modded server with no rcon is still a working game server, and refusing
  # to boot over an admin channel would be a worse trade.
  log "no RCON_PASSWORD injected — leaving rcon config alone (plugin stays disabled)"
  exit 0
fi

# Where BepInEx actually reads config. Located rather than hardcoded: the install path is
# the image's business and has moved before. The fallback search is bounded to the install
# root so it cannot wander into the game's own data.
CONFIG_DIR=""
for candidate in \
  "${BEPINEX_CONFIG_DIR:-}" \
  /opt/valheim/bepinex/BepInEx/config \
  /opt/valheim/server/BepInEx/config
do
  [ -n "$candidate" ] && [ -d "$candidate" ] && { CONFIG_DIR="$candidate"; break; }
done

if [ -z "$CONFIG_DIR" ]; then
  CONFIG_DIR="$(find /opt/valheim -maxdepth 5 -type d -path '*/BepInEx/config' 2>/dev/null | head -1)"
fi

if [ -z "$CONFIG_DIR" ]; then
  log "could not find a BepInEx config directory under /opt/valheim — rcon will stay disabled"
  log "  (looked for */BepInEx/config; set BEPINEX_CONFIG_DIR to override)"
  exit 0
fi

CFG="$CONFIG_DIR/org.tristan.rcon.cfg"
PORT="${RCON_CONFIG_PORT:-2458}"
SECTION="${RCON_CONFIG_SECTION:-1. Rcon}"

if [ -f "$CFG" ]; then
  # Patch the two keys we own and leave the rest of the plugin's file alone. Deliberately
  # section-agnostic: matching on the key lines means this keeps working if the plugin
  # renames or reorders its sections, which a generated file would not.
  TMP="$CFG.respawn"
  awk -v pw="$RCON_PASSWORD" -v port="$PORT" '
    /^[[:space:]]*Password[[:space:]]*=/ { print "Password = " pw; next }
    /^[[:space:]]*Port[[:space:]]*=/     { print "Port = " port; next }
    { print }
  ' "$CFG" > "$TMP" && mv "$TMP" "$CFG"
  if grep -q '^[[:space:]]*Password[[:space:]]*=' "$CFG"; then
    log "patched $CFG (port $PORT)"
  else
    log "WARNING $CFG has no Password key to patch — rcon will stay disabled"
  fi
else
  # First run before the plugin has written its defaults. The section header is the one
  # thing that cannot be derived from an absent file; "1. Rcon" is read out of the shipped
  # assembly's string table, not guessed. A wrong section fails safe — the plugin finds no
  # password and refuses to authenticate anyone.
  mkdir -p "$CONFIG_DIR"
  {
    echo "[$SECTION]"
    echo "Port = $PORT"
    echo "Password = $RCON_PASSWORD"
  } > "$CFG"
  log "wrote a new $CFG under [$SECTION] (port $PORT)"
fi

exit 0
