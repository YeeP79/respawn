#!/usr/bin/env bash
set -euo pipefail

# --- Configuration from environment ---
IDLE_TIMEOUT_SECONDS=$(( ${IDLE_TIMEOUT_MINUTES:-30} * 60 ))
CHECK_INTERVAL=${IDLE_CHECK_INTERVAL_SECONDS:-60}
CHECK_METHOD=${IDLE_CHECK_METHOD:-netstat}
STATUS_ENDPOINT=${IDLE_STATUS_ENDPOINT:-}
PORT=${CONTAINER_PORT:-7777}
EXTRA_PORTS=${ADDITIONAL_PORTS:-}

idle_seconds=0
running=true

cleanup() {
  echo "[watchdog] Received signal, shutting down."
  running=false
}
trap cleanup SIGTERM SIGINT

echo "[watchdog] Starting idle-shutdown watchdog"
echo "[watchdog] Timeout: ${IDLE_TIMEOUT_SECONDS}s, Interval: ${CHECK_INTERVAL}s, Method: ${CHECK_METHOD}, Port: ${PORT}"
if [ -n "$EXTRA_PORTS" ]; then
  echo "[watchdog] Additional ports: ${EXTRA_PORTS}"
fi

get_connection_count() {
  if [ "$CHECK_METHOD" = "http" ]; then
    if [ -z "$STATUS_ENDPOINT" ]; then
      echo "[watchdog] ERROR: IDLE_STATUS_ENDPOINT is required for http check method" >&2
      echo "0"
      return
    fi
    local response
    response=$(curl -s --max-time 5 "$STATUS_ENDPOINT" 2>/dev/null || echo '{}')
    # Try "connections" first, then "players"
    local count
    count=$(echo "$response" | jq -r '.connections // .players // 0' 2>/dev/null || echo "0")
    echo "$count"
  else
    # netstat mode: count established connections on all game ports
    local count=0
    local c
    c=$(ss -tun state established "sport = :${PORT}" 2>/dev/null | tail -n +2 | wc -l)
    count=$((count + c))
    if [ -n "$EXTRA_PORTS" ]; then
      IFS=',' read -ra PORTS <<< "$EXTRA_PORTS"
      for p in "${PORTS[@]}"; do
        c=$(ss -tun state established "sport = :${p}" 2>/dev/null | tail -n +2 | wc -l)
        count=$((count + c))
      done
    fi
    echo "$count"
  fi
}

discover_service_info() {
  local metadata_uri="${ECS_CONTAINER_METADATA_URI_V4:-}"
  if [ -z "$metadata_uri" ]; then
    echo "[watchdog] WARNING: ECS_CONTAINER_METADATA_URI_V4 not available" >&2
    return 1
  fi

  local task_meta
  task_meta=$(curl -s --max-time 5 "${metadata_uri}/task" 2>/dev/null)
  CLUSTER=$(echo "$task_meta" | jq -r '.Cluster' 2>/dev/null)
  TASK_ARN=$(echo "$task_meta" | jq -r '.TaskARN' 2>/dev/null)

  if [ -z "$CLUSTER" ] || [ "$CLUSTER" = "null" ]; then
    echo "[watchdog] WARNING: Could not discover cluster info" >&2
    return 1
  fi

  # Discover service name from task tags or task group
  local task_group
  task_group=$(echo "$task_meta" | jq -r '.TaskGroup // ""' 2>/dev/null || echo "")
  # Task group is typically "service:<service-name>"
  SERVICE_NAME="${task_group#service:}"

  echo "[watchdog] Discovered cluster=${CLUSTER}, service=${SERVICE_NAME}"
  return 0
}

scale_to_zero() {
  echo "[watchdog] Idle timeout reached (${IDLE_TIMEOUT_SECONDS}s). Scaling service to 0."

  if [ -z "${CLUSTER:-}" ] || [ -z "${SERVICE_NAME:-}" ]; then
    echo "[watchdog] Cannot scale: service info not discovered." >&2
    return 1
  fi

  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE_NAME" \
    --desired-count 0 \
    --no-cli-pager \
    2>&1 || echo "[watchdog] Failed to scale service to 0"

  echo "[watchdog] Scale-to-zero command sent."
}

# Wait a bit for the service to start before discovering metadata
sleep 10

CLUSTER=""
SERVICE_NAME=""
TASK_ARN=""
discover_service_info || echo "[watchdog] Will retry service discovery later."

while $running; do
  connections=$(get_connection_count)

  if [ "$connections" -gt 0 ] 2>/dev/null; then
    if [ "$idle_seconds" -gt 0 ]; then
      echo "[watchdog] Activity detected (${connections} connections). Resetting idle timer."
    fi
    idle_seconds=0
  else
    idle_seconds=$((idle_seconds + CHECK_INTERVAL))
    echo "[watchdog] No connections. Idle for ${idle_seconds}/${IDLE_TIMEOUT_SECONDS}s"
  fi

  if [ "$idle_seconds" -ge "$IDLE_TIMEOUT_SECONDS" ]; then
    # Retry service discovery if we haven't succeeded yet
    if [ -z "${CLUSTER:-}" ]; then
      discover_service_info || true
    fi
    scale_to_zero
    break
  fi

  sleep "$CHECK_INTERVAL" &
  wait $! 2>/dev/null || true
done

echo "[watchdog] Exiting."
