#!/usr/bin/env bash
#
# Persist a task-local database across the scale-to-zero cycle by round-tripping a
# dump through S3.
#
# WHY THIS EXISTS. A Fargate task has no volume, so a sidecar database loses everything
# when the task stops — and these servers are *designed* to stop, idling to zero after
# 30 minutes. For the CS 1.6 KZ timer that means every record, personal best and saved
# run disappears between sessions, which removes the point of a timer.
#
# WHY NOT THE OBVIOUS ALTERNATIVES.
#   EFS at /var/lib/mysql   MySQL/MariaDB on NFS is not supported by either project:
#                           it relies on POSIX locking and fsync semantics NFS does not
#                           reliably provide, and the documented failure is silent table
#                           corruption rather than an error. Not worth it for scores.
#   RDS                     Correct and durable, but always-on cost for a server that
#                           exists to be off.
#
# So: restore on start, dump periodically, dump again on the way down. The periodic dump
# is the load-bearing one — a task can die without ever delivering SIGTERM (spot
# reclaim, OOM, a crash), and relying on shutdown alone would lose the whole session.
set -uo pipefail

: "${BACKUP_S3_URI:?BACKUP_S3_URI is required, e.g. s3://bucket/cs16-kz/kreedz.sql.gz}"
: "${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD is required}"
MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_DATABASE="${MYSQL_DATABASE:-kreedz}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-300}"
DUMP=/tmp/dump.sql.gz

log() { echo "[mysql-backup] $*"; }

wait_for_db() {
  local tries=0
  until mariadb -h "$MYSQL_HOST" -uroot -p"$MYSQL_ROOT_PASSWORD" -e 'SELECT 1' >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -ge 60 ] && { log "database never became reachable"; return 1; }
    sleep 2
  done
  return 0
}

restore() {
  if ! aws s3 cp "$BACKUP_S3_URI" "$DUMP" --only-show-errors 2>/dev/null; then
    log "no existing backup at $BACKUP_S3_URI — starting empty (first run)"
    return 0
  fi
  # The timer creates its own schema on load, so a restore only has to bring back rows.
  # Restoring INTO a live database is safe here because this runs before players join.
  if gunzip -c "$DUMP" | mariadb -h "$MYSQL_HOST" -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"; then
    log "restored $(stat -c%s "$DUMP") bytes from $BACKUP_S3_URI"
  else
    # Do NOT abort: a corrupt or half-written backup must not stop the server booting.
    # A session with no history beats no session.
    log "WARNING restore failed — continuing with an empty database"
  fi
}

dump() {
  local reason="$1"
  if ! mariadb-dump -h "$MYSQL_HOST" -uroot -p"$MYSQL_ROOT_PASSWORD" \
        --single-transaction --skip-lock-tables "$MYSQL_DATABASE" 2>/dev/null | gzip -c > "$DUMP"; then
    log "WARNING dump failed ($reason)"
    return 1
  fi
  # Write to a .tmp key first, then copy into place: a dump interrupted mid-upload
  # would otherwise replace a good backup with a truncated one.
  if aws s3 cp "$DUMP" "${BACKUP_S3_URI}.tmp" --only-show-errors \
     && aws s3 mv "${BACKUP_S3_URI}.tmp" "$BACKUP_S3_URI" --only-show-errors; then
    log "saved $(stat -c%s "$DUMP") bytes to $BACKUP_S3_URI ($reason)"
  else
    log "WARNING upload failed ($reason)"
  fi
}

on_term() {
  log "SIGTERM — final dump before shutdown"
  dump "shutdown"
  exit 0
}
trap on_term TERM INT

log "waiting for ${MYSQL_HOST}/${MYSQL_DATABASE}"
if wait_for_db; then
  restore
  log "backing up every ${BACKUP_INTERVAL_SECONDS}s"
  while true; do
    # `sleep &` + wait so SIGTERM interrupts the sleep instead of waiting it out —
    # otherwise the final dump misses the ECS stop timeout and is killed.
    sleep "$BACKUP_INTERVAL_SECONDS" & wait $!
    dump "interval"
  done
else
  # Stay alive rather than exiting: a restart loop next to a healthy game server is
  # noise, and the game is playable without persistence.
  log "giving up on backups; sleeping"
  while true; do sleep 3600 & wait $!; done
fi
