#!/usr/bin/env bash
# AutoTool launcher (BIOBUZZ, team 19859).
# Normal use: copy this file to the ROBOT repo root and run ./autotool.sh there. The tool repo
# (biobuzz-autotool) is expected as a git submodule at tools/autotool, or set AUTOTOOL_HOME.
# From inside the tool repo you can also run: ./autotool.sh [command] /path/to/robot/repo
#
#   ./autotool.sh          start AutoTool in the background (if it is not running) and open it
#   ./autotool.sh stop     stop it
#   ./autotool.sh status   is it running, and where
#   ./autotool.sh open     open the page
#   ./autotool.sh log      show the server log
#   ./autotool.sh fg       run in this terminal instead (Ctrl+C stops it)
#
# It keeps running after this terminal closes. The page is always http://localhost:4791 (the key is
# saved on this computer, so bookmarks keep working). It checks Node, installs and builds on the first
# run, and listens on 127.0.0.1 only. The API key is never passed here: the server reads it from this
# computer's config folder. Windows: run it from Git Bash or WSL.
set -euo pipefail

CMD="start"
case "${1:-}" in start | stop | status | open | log | fg) CMD="$1"; shift ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HERE/autotool/src/server/main.ts" ]; then
  TOOL="$HERE"
  ROBOT_REPO="${1:-${ROBOT_REPO:-}}"
  [ -n "$ROBOT_REPO" ] || { echo "Usage from the tool repo: ./autotool.sh [start|stop|status|open|log|fg] /path/to/robot/repo"; exit 1; }
else
  ROBOT_REPO="$HERE"
  TOOL="${AUTOTOOL_HOME:-$HERE/tools/autotool}"
  # no submodule: a tool repo checked out next to the robot repo (../BIOBUZZ-AutoTool or ../biobuzz-autotool)
  if [ -z "${AUTOTOOL_HOME:-}" ] && [ ! -f "$TOOL/autotool/src/server/main.ts" ]; then
    for d in "$HERE/../BIOBUZZ-AutoTool" "$HERE/../biobuzz-autotool"; do
      [ -f "$d/autotool/src/server/main.ts" ] && { TOOL="$(cd "$d" && pwd)"; break; }
    done
  fi
fi
APP="$TOOL/autotool"
if [ ! -f "$APP/src/server/main.ts" ]; then
  echo "AutoTool is not at $TOOL."
  echo "  If it is a submodule:  git submodule update --init tools/autotool"
  echo "  Or point at a copy:    AUTOTOOL_HOME=/path/to/biobuzz-autotool ./autotool.sh"
  exit 1
fi
ROBOT_REPO="$(cd "$ROBOT_REPO" && pwd)"

# Node 22.18+ or 23.6+ runs TypeScript directly (no build step for the server)
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 22.18 or newer from https://nodejs.org and run this again."
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>23||(a===23&&b>=6)||(a===22&&b>=18)?0:1)'; then
  echo "Node $(node -v) is too old: AutoTool needs Node 22.18+ or 23.6+ (it runs TypeScript directly)."
  exit 1
fi

# the saved page key, the data folder and this repo's fingerprint (as the server reports it)
LAUNCH="$(node "$APP/src/server/launch.ts" "$ROBOT_REPO")"
TOKEN="$(printf '%s\n' "$LAUNCH" | sed -n 1p)"
DATA="$(printf '%s\n' "$LAUNCH" | sed -n 2p)"
REPO_ID="$(printf '%s\n' "$LAUNCH" | sed -n 3p)"
LOG="$DATA/server.log"
BASE_PORT="${AUTOTOOL_PORT:-4791}"

# what answers on a port: "ours" (AutoTool for this repo), "other-repo", "busy" (something else) or "free"
probe() {
  node -e '
    const port = +process.argv[1], want = process.argv[2];
    const req = require("http").get({ host: "127.0.0.1", port, path: "/api/ping", headers: { host: `127.0.0.1:${port}` }, timeout: 1500 }, (r) => {
      let t = ""; r.on("data", (c) => (t += c)); r.on("end", () => {
        try { const j = JSON.parse(t); if (j.app !== "biobuzz-autotool") return console.log("busy");
          console.log(j.repo === want ? `ours ${j.pid}` : `other-repo ${j.pid}`); } catch { console.log("busy"); }
      });
    });
    req.on("timeout", () => { req.destroy(); console.log("busy"); });
    req.on("error", (e) => console.log(e.code === "ECONNREFUSED" ? "free" : "busy"));
  ' "$1" "$REPO_ID"
}

# the port AutoTool runs on for this repo (or the first free one): sets PORT and STATE
find_port() {
  PORT="$BASE_PORT"
  FIRST=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    STATE="$(probe "$PORT")"
    [ -n "$FIRST" ] || FIRST="$STATE"
    case "$STATE" in ours* | free) return 0 ;; esac
    PORT=$((PORT + 1))
  done
  STATE="none"
}

open_page() {
  local url="http://localhost:$PORT/#t=$TOKEN"
  [ "${AUTOTOOL_NO_BROWSER:-}" = "1" ] && return 0
  case "$(uname -s)" in
    Darwin) open "$url" ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then (command -v wslview >/dev/null && wslview "$url") || cmd.exe /c start "" "$url"
      else xdg-open "$url" >/dev/null 2>&1 || true; fi ;;
    MINGW* | MSYS* | CYGWIN*) start "" "$url" ;;
  esac
}

build_if_needed() {
  # first run: install (needs internet once), then build the UI when its sources are newer than the build
  if [ ! -d "$APP/node_modules/svelte" ] || [ ! -d "$APP/node_modules/@anthropic-ai/sdk" ]; then
    echo "First run: installing AutoTool's packages (about 90 MB, needs internet once)..."
    (cd "$APP" && npm ci --no-audit --no-fund)
  fi
  if [ ! -f "$APP/dist/index.html" ] || [ -n "$(find "$APP/src/ui" "$APP/src/shared" -newer "$APP/dist/index.html" -type f 2>/dev/null | head -1)" ]; then
    echo "Building the AutoTool UI..."
    (cd "$APP" && npx vite build --logLevel warn)
  fi
}

# sets PORT and PID (empty when AutoTool is not running for this repo)
running_pid() {
  find_port
  case "$STATE" in ours*) PID="${STATE#ours }" ;; *) PID="" ;; esac
}

case "$CMD" in
  status)
    running_pid
    if [ -n "$PID" ]; then echo "AutoTool is running for $ROBOT_REPO: http://localhost:$PORT (process $PID, log $LOG)"
    else echo "AutoTool is not running for $ROBOT_REPO. Start it with ./autotool.sh"; fi
    exit 0 ;;
  stop)
    running_pid
    if [ -z "$PID" ]; then echo "AutoTool is not running for $ROBOT_REPO."; exit 0; fi
    kill "$PID"
    for _ in $(seq 1 50); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
    echo "AutoTool stopped."
    exit 0 ;;
  log)
    [ -f "$LOG" ] && tail -n 80 "$LOG" || echo "No log yet ($LOG)."
    exit 0 ;;
  open)
    running_pid
    if [ -z "$PID" ]; then echo "AutoTool is not running. Start it with ./autotool.sh"; exit 1; fi
    open_page
    echo "http://localhost:$PORT"
    exit 0 ;;
esac

build_if_needed
find_port
if [ "$STATE" = "none" ]; then
  echo "Ports $BASE_PORT-$((BASE_PORT + 9)) are all in use. Set AUTOTOOL_PORT to a free port."
  exit 1
fi
case "$STATE" in
  ours*)
    if [ "$CMD" = "fg" ]; then echo "AutoTool is already running in the background (./autotool.sh stop first)."; exit 1; fi
    echo "AutoTool is already running: http://localhost:$PORT"
    open_page
    exit 0 ;;
esac
if [ "$PORT" != "$BASE_PORT" ]; then
  case "$FIRST" in
    other-repo*) echo "AutoTool for another robot repo is on port $BASE_PORT; this one uses $PORT." ;;
    *) echo "Port $BASE_PORT is taken by another program; using $PORT (bookmarks of :$BASE_PORT will not reach it)." ;;
  esac
fi

if [ "$CMD" = "fg" ]; then
  echo "AutoTool for $ROBOT_REPO: http://localhost:$PORT (Ctrl+C stops it)"
  (sleep 1.5 && open_page) &
  cd "$TOOL"
  ROBOT_REPO="$ROBOT_REPO" exec node "$APP/src/server/main.ts" --repo "$ROBOT_REPO" --port "$PORT" --token "$TOKEN"
fi

# background: survives this terminal; the log keeps the last runs
mkdir -p "$DATA"
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 2000000 ] && mv "$LOG" "$LOG.old"
echo "--- $(date) start for $ROBOT_REPO on port $PORT" >> "$LOG"
cd "$TOOL"
ROBOT_REPO="$ROBOT_REPO" nohup node "$APP/src/server/main.ts" --repo "$ROBOT_REPO" --port "$PORT" --token "$TOKEN" >> "$LOG" 2>&1 < /dev/null &
SERVER=$!
for _ in $(seq 1 100); do
  case "$(probe "$PORT")" in ours*) break ;; esac
  if ! kill -0 "$SERVER" 2>/dev/null; then
    echo "AutoTool did not start. The last lines of $LOG:"
    tail -n 20 "$LOG"
    exit 1
  fi
  sleep 0.2
done
open_page
echo "AutoTool is running for $ROBOT_REPO: http://localhost:$PORT"
echo "It keeps running after this terminal closes. ./autotool.sh stop stops it; ./autotool.sh log shows its log."
