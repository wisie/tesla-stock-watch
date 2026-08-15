#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export DEPLOYMENT_MODE="${DEPLOYMENT_MODE:-docker}"
export TESLA_DATA_DIR="${TESLA_DATA_DIR:-/data/tesla-state}"
export CHROME_PATH="${CHROME_PATH:-/usr/bin/google-chrome-stable}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-/data/chrome-profile}"
export REAL_ALERTS_ENABLED="${REAL_ALERTS_ENABLED:-false}"
export CHROME_BACKGROUND_MODE="${CHROME_BACKGROUND_MODE:-visible}"
export LANG="${LANG:-en_AU.UTF-8}"
export LC_ALL="${LC_ALL:-en_AU.UTF-8}"
export TZ="${TZ:-Australia/Melbourne}"
export BROWSER_CHROME_LANG="${BROWSER_CHROME_LANG:-en-AU}"

mkdir -p "$TESLA_DATA_DIR/logs" "$CHROME_USER_DATA_DIR" /tmp/.X11-unix
DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM%%.*}"
XVFB_LOCK="/tmp/.X${DISPLAY_NUM}-lock"
XVFB_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"
XVFB_PID=""
FLUXBOX_PID=""
X11VNC_PID=""
WEBSOCKIFY_PID=""
NODE_PID=""

cleanup() {
  status=$?
  trap - EXIT INT TERM
  for pid in "$NODE_PID" "$WEBSOCKIFY_PID" "$X11VNC_PID" "$FLUXBOX_PID" "$XVFB_PID"; do
    if [ -n "$pid" ]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  for pid in "$NODE_PID" "$WEBSOCKIFY_PID" "$X11VNC_PID" "$FLUXBOX_PID" "$XVFB_PID"; do
    if [ -n "$pid" ]; then
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
  rm -f "$XVFB_LOCK" "$XVFB_SOCKET"
  exit "$status"
}

trap cleanup EXIT INT TERM

# Chrome leaves these profile locks behind if Docker stops the container while
# the browser is still shutting down. In this container there is no pre-existing
# browser process before startup, so removing stale singleton locks is safe.
rm -f \
  "$CHROME_USER_DATA_DIR/SingletonCookie" \
  "$CHROME_USER_DATA_DIR/SingletonLock" \
  "$CHROME_USER_DATA_DIR/SingletonSocket"

# Xvfb can also leave a stale display lock after an abrupt Docker restart.
# The container owns this display namespace, so cleaning the lock before
# starting the virtual desktop is safe.
rm -f "$XVFB_LOCK" "$XVFB_SOCKET"

if [ ! -x "$CHROME_PATH" ]; then
  if command -v google-chrome-stable >/dev/null 2>&1; then
    export CHROME_PATH="$(command -v google-chrome-stable)"
  elif command -v chromium >/dev/null 2>&1; then
    export CHROME_PATH="$(command -v chromium)"
  elif command -v chromium-browser >/dev/null 2>&1; then
    export CHROME_PATH="$(command -v chromium-browser)"
  else
    echo "No Chrome/Chromium binary found for Tesla Stock Watch" >&2
    exit 1
  fi
fi

echo "Tesla Stock Watch Docker production starting with CHROME_PATH=$CHROME_PATH"

XVFB_WHD="${XVFB_WHD:-1280x900x24}"
Xvfb "$DISPLAY" -screen 0 "$XVFB_WHD" -nolisten tcp &
XVFB_PID=$!

sleep 1
if ! kill -0 "$XVFB_PID" >/dev/null 2>&1; then
  echo "Xvfb failed to start for display $DISPLAY" >&2
  exit 1
fi
fluxbox >/tmp/fluxbox.log 2>&1 &
FLUXBOX_PID=$!
x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -nopw -quiet >/tmp/x11vnc.log 2>&1 &
X11VNC_PID=$!
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
WEBSOCKIFY_PID=$!

node server.js &
NODE_PID=$!
wait "$NODE_PID"
