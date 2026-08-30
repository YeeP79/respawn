#!/usr/bin/env bash
#
# Round-trip a Valheim world between the task's EFS volume and S3, so worlds can be
# rotated from a laptop that cannot reach the volume.
#
# WHY THIS IS NOT mysql-backup. That sidecar restores from S3 unconditionally, which is
# correct there because a Fargate task has no volume: S3 holds the only copy, so it is
# always the freshest one. Here EFS *is* the live copy and it outlives the task, so an
# unconditional restore is the one thing that must never happen — it would replay a
# stale world over a played one and silently discard the session. Two rules follow:
#
#   1. The volume is authoritative. Nothing is written to it unless a world was
#      explicitly placed in the inbox for that purpose.
#   2. An inbox world is refused if the volume's world has a HIGHER world clock, which
#      is the machine-checkable form of "you are about to overwrite newer progress".
#      WORLD_SEED_FORCE=true overrides, for a deliberate roll-back.
#
# S3 LAYOUT, under WORLD_S3_PREFIX:
#   inbox/<world>.{db,fwl}   pushed from a laptop; installed ONCE then deleted, so a
#                            task that restarts mid-session does not re-seed over play.
#   live/<world>.{db,fwl}    this sidecar's mirror of the volume; what you pull back
#                            down after a session. Never read at boot.
#
# The interval mirror is the load-bearing one, not the shutdown one: a task can die
# without ever delivering SIGTERM (spot reclaim, OOM, crash), and relying on shutdown
# alone would lose the whole session. Same reasoning as sidecar/mysql-backup/backup.sh.
set -uo pipefail

: "${WORLD_S3_PREFIX:?WORLD_S3_PREFIX is required, e.g. s3://bucket/valheim}"
: "${WORLD_NAME:?WORLD_NAME is required, and must match the WORLD_NAME the game is given}"
WORLD_DIR="${WORLD_DIR:-/config/worlds_local}"
SYNC_INTERVAL_SECONDS="${SYNC_INTERVAL_SECONDS:-300}"
WORLD_SEED_FORCE="${WORLD_SEED_FORCE:-false}"
# Whether the game may GENERATE the named world when no save by that name exists.
WORLD_ALLOW_CREATE="${WORLD_ALLOW_CREATE:-false}"
: "${WORLD_FLAVOR:?WORLD_FLAVOR is required and must be vanilla or modded}"
SERVICE_NAME="${SERVICE_NAME:-unknown}"
# Empty means this server runs no mods and syncs no plugins.
PLUGIN_SOURCE="${WORLD_SYNC_PLUGIN_SOURCE:-}"
PLUGIN_DIR="${PLUGIN_DIR:-/config/bepinex/plugins}"

# NOTE this sidecar deliberately does NOT write the rcon plugin's config, though it holds
# the secret and a volume. Measured: the plugin reads from the BepInEx install tree under
# /opt, which no sidecar mounts, so a config written to /config was never read and the
# plugin ran with an empty password — listening and rejecting every auth. That job moved
# to the game container's PRE_SERVER_RUN_HOOK, which is the only place with both halves.
# See apps/valheim/variants/modded/respawn-rcon-config.sh.

# Trailing slash is a per-caller coin flip and doubles into an empty S3 key segment.
PREFIX="${WORLD_S3_PREFIX%/}"
INBOX="$PREFIX/inbox"
LIVE="$PREFIX/live"

# The game container waits on this file via a health check, so it cannot open the world
# before seeding has settled. See world-sync.ts.
READY=/tmp/world-sync-ready

log() { echo "[world-sync] $*"; }

# In-game seconds elapsed, read from the save header: int32 worldVersion then a
# little-endian float64 netTime. Valheim only advances this while a player is connected,
# so it measures play, not wall-clock — which is exactly the comparison wanted here.
# Prints nothing when the file is missing or too short to hold a header.
world_clock() {
  local f="$1"
  [ -f "$f" ] || return 1
  [ "$(stat -c%s "$f")" -ge 12 ] 2>/dev/null || return 1
  od -An -j4 -N8 -t f8 -- "$f" 2>/dev/null | tr -d ' \n'
}

# A world is a .db AND its .fwl; a .db alone will not load, and installing half a pair
# leaves the volume in a state the server cannot boot from.
have_pair_s3() {
  aws s3 ls "$1/$WORLD_NAME.db"  >/dev/null 2>&1 &&
  aws s3 ls "$1/$WORLD_NAME.fwl" >/dev/null 2>&1
}

# The provenance stamp travels with the save as <world>.respawn.json.
#
# It exists because the world clock cannot answer the question that matters here. The
# clock says how much a save has been PLAYED; it says nothing about whether a mod wrote
# prefabs into it. A mod-damaged save has a HIGHER clock than the clean one it came
# from, so every guard built on the clock waves it straight through.
STAMP_EXT="respawn.json"
stamp_path() { echo "$WORLD_DIR/$WORLD_NAME.$STAMP_EXT"; }

# The flavor a save is stamped with, or empty when it carries no stamp.
stamp_flavor() {
  local f="$1"
  [ -f "$f" ] || return 1
  jq -r '.flavor // empty' "$f" 2>/dev/null
}

# Plugin file names, so removing a mod later is visible in the record rather than
# inferred from a world that has started behaving strangely.
plugin_list_json() {
  if [ -n "$PLUGIN_SOURCE" ] && [ -d "$PLUGIN_DIR" ]; then
    # NOT -printf: this image's `find` is busybox (coreutils supplies od/stat, not find),
    # which does not support it and prints nothing — so the stamp recorded an EMPTY mod
    # list while plugins were demonstrably installed. Measured in production. The safety
    # decision in plugins_world_safe_only was unaffected (it basenames in the loop), but
    # the stamp is the AUDIT TRAIL for a world-safe assertion, and an empty one records
    # that nothing ran.
    find "$PLUGIN_DIR" -maxdepth 1 -name '*.dll' 2>/dev/null | sed 's|.*/||' | jq -R . | jq -s .
  else
    echo '[]'
  fi
}

# Plugins are part of the SERVER definition, not the save, so they are mirrored one way
# only — S3 to the volume — and never written back. Runs before the ready flag, so the
# set is settled by the time BepInEx scans the directory.
sync_plugins() {
  [ -n "$PLUGIN_SOURCE" ] || return 0
  mkdir -p "$PLUGIN_DIR"
  # --delete so REMOVING a mod from the published set actually removes it here. Without
  # it a plugin would linger on the volume for ever and the server would keep loading a
  # mod nobody thinks is installed — which then writes its prefabs into the world.
  if aws s3 sync "$PREFIX/$PLUGIN_SOURCE" "$PLUGIN_DIR" --delete --only-show-errors; then
    log "synced $(find "$PLUGIN_DIR" -maxdepth 1 -name '*.dll' | wc -l) plugin(s) into $PLUGIN_DIR"
  else
    # Booting a MODDED server with the wrong plugin set is worse than not booting: the
    # world gets played, and whatever the mods do or fail to do is written into it.
    log "ERROR could not sync plugins from $PREFIX/$PLUGIN_SOURCE"
    return 1
  fi
}

plugins_world_safe_only() {
  [ -n "$PLUGIN_SOURCE" ] || return 0            # no mods at all
  [ -d "$PLUGIN_DIR" ] || return 0
  local dll
  while IFS= read -r dll; do
    plugin_is_world_safe "$dll" || return 1
  done < <(find "$PLUGIN_DIR" -maxdepth 1 -name '*.dll' 2>/dev/null)
  return 0
}

# One plugin's declaration, from the .world-safe manifest published alongside it.
plugin_is_world_safe() {
  local name manifest
  name="$(basename "$1")"
  manifest="$PLUGIN_DIR/.world-safe"
  [ -f "$manifest" ] && grep -Fxq "$name" "$manifest"
}

# The plugins present, split by whether each may write prefabs into the save.
#
# The flat list said WHAT ran; this says which of those threaten a later vanilla load.
# Without the split, a reader of the stamp has to hold the .world-safe manifest in their
# head to interpret the very field that is supposed to make the assertion auditable — and
# that manifest lives on a server, not next to the save.
plugin_split_json() {
  local which="$1" dll name out
  out=""
  if [ -n "$PLUGIN_SOURCE" ] && [ -d "$PLUGIN_DIR" ]; then
    while IFS= read -r dll; do
      name="$(basename "$dll")"
      if plugin_is_world_safe "$dll"; then
        [ "$which" = "safe" ] && out="$out$name\n"
      else
        [ "$which" = "altering" ] && out="$out$name\n"
      fi
    done < <(find "$PLUGIN_DIR" -maxdepth 1 -name '*.dll' 2>/dev/null)
  fi
  printf '%b' "$out" | jq -R . | jq -s 'map(select(. != ""))'
}

# Append this run to the save's stamp, creating it when absent. Flavor is one-way: once
# a save has run with a world-altering mod it stays modded for ever, because the ZDOs that
# mod wrote are in the file and no later vanilla run removes them.
write_stamp() {
  local f now prior flavor existing mods safe_mods altering_mods
  f="$(stamp_path)"
  # The world directory may not exist yet: on a first-ever boot the volume is empty and
  # the game has not created it. Only the install path used to mkdir it, so a boot that
  # seeded nothing could not write the stamp at all — measured on the first real deploy,
  # where the provenance record silently failed on the one boot that establishes it.
  mkdir -p "$(dirname "$f")"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  prior=""
  if [ -f "$f" ]; then
    prior="$(stamp_flavor "$f")" || prior=""
  fi

  # The server kind is the ceiling, not the verdict. A modded server running only
  # world-safe plugins leaves a vanilla world behind, so it must not stamp one as modded.
  local safe_only=0
  flavor="$WORLD_FLAVOR"
  if [ "$WORLD_FLAVOR" = "modded" ] && plugins_world_safe_only; then
    flavor="vanilla"
    safe_only=1
  fi
  # But modded is one-way once it has genuinely happened.
  [ "$prior" = "modded" ] && flavor="modded"

  existing='{"history":[]}'
  if [ -f "$f" ]; then
    local current
    current="$(cat "$f" 2>/dev/null)" || current=""
    # Only trust it if it parses. A truncated stamp must not take the run history with it,
    # but it must also not abort the boot — the save is fine either way.
    if [ -n "$current" ] && echo "$current" | jq -e . >/dev/null 2>&1; then
      existing="$current"
    else
      log "WARNING existing stamp is unreadable; starting a fresh history"
    fi
  fi

  mods="$(plugin_list_json)"
  safe_mods="$(plugin_split_json safe)"
  altering_mods="$(plugin_split_json altering)"

  if ! printf '%s' "$existing" | jq \
        --arg world "$WORLD_NAME" \
        --arg flavor "$flavor" \
        --arg svc "$SERVICE_NAME" \
        --arg at "$now" \
        --arg server "$WORLD_FLAVOR" \
        --argjson mods "$mods" \
        --argjson safe_mods "$safe_mods" \
        --argjson altering_mods "$altering_mods" \
        --argjson safe "$( [ "$safe_only" -eq 1 ] && echo true || echo false )" \
        '{
           world: $world,
           flavor: $flavor,
           mods: $mods,
           mods_world_safe: $safe_mods,
           mods_world_altering: $altering_mods,
           history: ((.history // []) + [{
             service: $svc,
             server_flavor: $server,
             flavor: $flavor,
             world_safe_only: $safe,
             at: $at,
             mods: $mods
           }])
         }' > "$f.tmp" 2>/dev/null; then
    log "WARNING could not write the provenance stamp"
    rm -f "$f.tmp"
    return 0
  fi
  mv "$f.tmp" "$f"
  local note=""
  [ "$safe_only" -eq 1 ] && note=" (all world-safe, so the save stays vanilla)"
  log "stamped '$WORLD_NAME' as $flavor with $(printf '%s' "$mods" | jq -r 'length') plugin(s)$note"
}

seed_from_inbox() {
  if ! have_pair_s3 "$INBOX"; then
    log "no world in $INBOX/ — keeping whatever is on the volume"
    return 0
  fi

  local tmp=/tmp/seed
  mkdir -p "$tmp"
  if ! aws s3 cp "$INBOX/$WORLD_NAME.db"  "$tmp/$WORLD_NAME.db"  --only-show-errors ||
     ! aws s3 cp "$INBOX/$WORLD_NAME.fwl" "$tmp/$WORLD_NAME.fwl" --only-show-errors; then
    # Do NOT abort: a half-uploaded seed must not stop the server booting on the world
    # it already has. A session on the old world beats no session.
    log "WARNING could not download the inbox world — leaving the volume untouched"
    rm -rf "$tmp"
    return 0
  fi

  local incoming current
  incoming="$(world_clock "$tmp/$WORLD_NAME.db")"
  if [ -z "$incoming" ]; then
    log "WARNING inbox world has no readable header — refusing to install it"
    rm -rf "$tmp"
    return 0
  fi

  current="$(world_clock "$WORLD_DIR/$WORLD_NAME.db")" || current=""
  if [ -n "$current" ] && [ "$WORLD_SEED_FORCE" != "true" ]; then
    if awk -v a="$incoming" -v b="$current" 'BEGIN { exit !(a < b) }'; then
      log "REFUSING to seed: inbox clock ${incoming}s is BEHIND the volume's ${current}s."
      log "  That would discard progress. Pull the volume's world down first, or set"
      log "  WORLD_SEED_FORCE=true if rolling back on purpose."
      rm -rf "$tmp"
      return 0
    fi
  fi

  # Provenance gate. Unlike the clock guard above this is not about losing progress, it
  # is about destroying content: a save carrying mod prefabs, loaded without the mods,
  # has those objects deleted on load. Checked here as well as at publish time because
  # this is the side that cannot be bypassed by copying files around.
  local inbox_stamp="/tmp/seed/$WORLD_NAME.$STAMP_EXT"
  if aws s3 cp "$INBOX/$WORLD_NAME.$STAMP_EXT" "$inbox_stamp" --only-show-errors 2>/dev/null; then
    local incoming_flavor
    incoming_flavor="$(stamp_flavor "$inbox_stamp")"
    if [ "$incoming_flavor" = "modded" ] && [ "$WORLD_FLAVOR" = "vanilla" ]; then
      log "REFUSING to seed: '$WORLD_NAME' is stamped MODDED and this is a vanilla server."
      log "  Loading it here would destroy every object its mods created, permanently."
      log "  Deploy it to the modded service instead."
      rm -rf "$tmp"
      return 0
    fi
  elif [ "$WORLD_FLAVOR" = "vanilla" ]; then
    # No stamp means unknown provenance, and the unsafe direction is the one that runs a
    # secretly-modded save on vanilla. publish-world.sh makes the operator assert this,
    # so reaching here unstamped means somebody put the file in the bucket by hand.
    log "WARNING '$WORLD_NAME' carries no provenance stamp; assuming vanilla."
  fi

  # Keep what is being replaced. The volume's copy may be the only one, and the operator
  # who pushed the inbox world is not necessarily the one who last played.
  if [ -n "$current" ]; then
    aws s3 cp "$WORLD_DIR/$WORLD_NAME.db"  "$LIVE/$WORLD_NAME.db"  --only-show-errors &&
    aws s3 cp "$WORLD_DIR/$WORLD_NAME.fwl" "$LIVE/$WORLD_NAME.fwl" --only-show-errors &&
    log "mirrored the outgoing world (clock ${current}s) to $LIVE/ before replacing it"
  fi

  mkdir -p "$WORLD_DIR"
  # .fwl first, then .db: if the task dies between the two, a new .fwl beside an old .db
  # is a mismatched pair the server rejects loudly, whereas the reverse boots the new
  # terrain under the old world's identity.
  if mv "$tmp/$WORLD_NAME.fwl" "$WORLD_DIR/$WORLD_NAME.fwl" &&
     mv "$tmp/$WORLD_NAME.db"  "$WORLD_DIR/$WORLD_NAME.db"; then
    log "installed '$WORLD_NAME' from the inbox (clock ${incoming}s)"
    # One-shot. A task that restarts mid-session must not re-seed over live play, and
    # this delete is what makes the inbox a handoff rather than standing configuration.
    [ -f "$inbox_stamp" ] && mv "$inbox_stamp" "$(stamp_path)"
    aws s3 rm "$INBOX/$WORLD_NAME.db"  --only-show-errors
    aws s3 rm "$INBOX/$WORLD_NAME.fwl" --only-show-errors
    aws s3 rm "$INBOX/$WORLD_NAME.$STAMP_EXT" --only-show-errors 2>/dev/null
    log "cleared the inbox — this world is now the volume's"
  else
    log "WARNING install failed; the volume is unchanged"
  fi
  rm -rf "$tmp"
}

mirror_to_live() {
  local reason="$1"
  [ -f "$WORLD_DIR/$WORLD_NAME.db" ] || { log "nothing to mirror yet ($reason)"; return 0; }

  # Valheim saves by writing a temp file and renaming over the target, and rename is
  # atomic on EFS as on any POSIX filesystem — so an open fd keeps pointing at a whole
  # file even if the game saves mid-upload. No quiescing needed.
  if aws s3 cp "$WORLD_DIR/$WORLD_NAME.db"  "$LIVE/$WORLD_NAME.db"  --only-show-errors &&
     aws s3 cp "$WORLD_DIR/$WORLD_NAME.fwl" "$LIVE/$WORLD_NAME.fwl" --only-show-errors; then
    # The stamp travels with the save. A world pulled down without it looks unstamped,
    # and an unstamped modded world is exactly what the vanilla guard cannot catch.
    [ -f "$(stamp_path)" ] && aws s3 cp "$(stamp_path)" "$LIVE/$WORLD_NAME.$STAMP_EXT" --only-show-errors
    log "mirrored $(stat -c%s "$WORLD_DIR/$WORLD_NAME.db") bytes to $LIVE/ ($reason)"
  else
    log "WARNING mirror failed ($reason)"
  fi
}

on_term() {
  log "SIGTERM — final mirror before shutdown"
  mirror_to_live "shutdown"
  exit 0
}
trap on_term TERM INT

log "world '$WORLD_NAME' on $WORLD_DIR, S3 at $PREFIX, flavor $WORLD_FLAVOR"
if ! sync_plugins; then
  # Deliberately never touches the ready flag: the game container's dependency holds it
  # back for ever rather than letting a modded server come up unmodded and write an
  # unmodded state into a world whose players expect the mods to be running.
  log "not signalling ready — the game will not start"
  while true; do sleep 3600 & wait $!; done
fi
seed_from_inbox

# The save must EXIST before the game is allowed to open it.
#
# Valheim does not error on an unknown world name — it generates a brand-new empty world
# under that name and runs it happily. So a deploy naming a world nobody staged does not
# fail, it fabricates: a convincing empty world wearing a real world's name, which this
# sidecar then mirrors to S3 where it can later be pulled down and mistaken for the real
# thing. Measured twice before this guard existed, including 325 KB of junk mirrored
# under a name that mattered.
#
# Refusing to signal ready is what makes launching a specific world an explicit act. The
# game container's dependency holds it back, so nothing is created and nothing is
# mirrored. Starting a genuinely NEW world is then a decision (WORLD_ALLOW_CREATE=true)
# rather than the silent outcome of a typo or an unstaged save.
if [ ! -f "$WORLD_DIR/$WORLD_NAME.db" ] && [ "$WORLD_ALLOW_CREATE" != "true" ]; then
  log "REFUSING to start: no save named '$WORLD_NAME' on the volume, and none was staged."
  log "  Valheim would CREATE an empty world under that name rather than fail, so the game"
  log "  is being held back instead. Either publish the world to $INBOX/ and restart, or"
  log "  set WORLD_ALLOW_CREATE=true to start a genuinely new world on purpose."
  log "not signalling ready — the game will not start"
  while true; do sleep 3600 & wait $!; done
fi

write_stamp

# Only now may the game open the world. Until this exists the health check fails and the
# game container's dependency holds it back.
touch "$READY"

log "mirroring every ${SYNC_INTERVAL_SECONDS}s"
while true; do
  # `sleep &` + wait so SIGTERM interrupts the sleep instead of waiting it out —
  # otherwise the final mirror misses the ECS stop timeout and is killed.
  sleep "$SYNC_INTERVAL_SECONDS" & wait $!
  mirror_to_live "interval"
done
