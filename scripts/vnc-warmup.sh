#!/usr/bin/env bash
set -euo pipefail

# Manual VNC/X11 warmup helper for the persistent headed Chrome session.
# Disabled by default. It sends only benign local X11 input events and never
# clicks challenge/CAPTCHA UI or form controls.

if [ "${VNC_WARMUP_ENABLED:-false}" != "true" ]; then
  echo "VNC warmup disabled. Set VNC_WARMUP_ENABLED=true to run manually." >&2
  exit 2
fi

DISPLAY="${DISPLAY:-:99}"
HEALTH_URL="${VNC_WARMUP_HEALTH_URL:-http://localhost:3000/api/health}"
ON_BLOCK_ONLY="${VNC_WARMUP_ON_BLOCK_ONLY:-true}"

if ! command -v xdotool >/dev/null 2>&1; then
  echo "xdotool is not installed in this container." >&2
  exit 3
fi

health_json="$(curl -fsS "$HEALTH_URL")"

read_health_field() {
  node -e "const h=JSON.parse(process.argv[1]); const v=h[process.argv[2]]; if (v === undefined || v === null) process.exit(1); process.stdout.write(String(v));" "$health_json" "$1"
}

polling_active="$(read_health_field pollingActive 2>/dev/null || echo false)"
block_remaining="$(read_health_field teslaBlockCooldownRemainingMs 2>/dev/null || echo 0)"
watcher_stale="$(read_health_field watcherStale 2>/dev/null || echo false)"

if [ "$polling_active" = "true" ]; then
  echo "Inventory poll is active; refusing VNC warmup." >&2
  exit 4
fi

if [ "$ON_BLOCK_ONLY" = "true" ] && [ "$block_remaining" = "0" ] && [ "$watcher_stale" != "true" ]; then
  echo "Watcher is not blocked/stale; warmup not needed." >&2
  exit 0
fi

export DISPLAY

window_id="$(xdotool search --onlyvisible --class "google-chrome" 2>/dev/null | head -1 || true)"
if [ -z "$window_id" ]; then
  window_id="$(xdotool search --class "google-chrome" 2>/dev/null | head -1 || true)"
fi

if [ -z "$window_id" ]; then
  echo "No Chrome window found on DISPLAY=$DISPLAY." >&2
  exit 5
fi

xdotool windowactivate "$window_id" >/dev/null 2>&1 || true
sleep 1

xdotool mousemove --window "$window_id" 320 260
sleep 1
xdotool mousemove --window "$window_id" 480 360
sleep 1
xdotool key --clearmodifiers Page_Down
sleep 2
xdotool mousemove --window "$window_id" 560 420
sleep 1
xdotool key --clearmodifiers Page_Up
sleep 2
xdotool mousemove --window "$window_id" 380 300

echo "VNC warmup completed against Chrome window $window_id."
