#!/usr/bin/env bash
# 1ops launcher — the single source of truth used by BOTH the `1ops` shell
# command and the Dock app. Restart semantics: if a server is already running on
# the port, kill it and start fresh, then open the browser.
set -uo pipefail

# Config written by install.sh (repo path, port, command, node/pnpm PATH).
CONFIG="$HOME/.1ops/config"
[ -f "$CONFIG" ] && . "$CONFIG"

REPO="${ONEOPS_REPO:?run scripts/install.sh first (no ~/.1ops/config)}"
PORT="${ONEOPS_PORT:-1134}"
CMD="${ONEOPS_CMD:-pnpm dev}"
PLAYBOOKS="${ONEOPS_PLAYBOOKS_DIR:-$HOME/playbooks}"
LOGDIR="$HOME/.1ops"; LOG="$LOGDIR/server.log"
mkdir -p "$LOGDIR" "$PLAYBOOKS"

# A GUI .app launches with a minimal PATH (no node/pnpm). Restore the locations
# captured at install time.
[ -n "${ONEOPS_PATH:-}" ] && export PATH="$ONEOPS_PATH"

ts() { date "+%Y-%m-%d %H:%M:%S"; }

# 1) Restart: kill whatever holds the port.
pids="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
if [ -n "$pids" ]; then
  echo "[$(ts)] restart — killing PID(s) $pids on :$PORT" >>"$LOG"
  echo "$pids" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# 2) Start detached so the launcher (and the Dock app) can exit while the server runs.
cd "$REPO" || { echo "[$(ts)] repo missing: $REPO" >>"$LOG"; exit 1; }
[ -d node_modules ] || pnpm install >>"$LOG" 2>&1
echo "[$(ts)] starting: $CMD  (playbooks: $PLAYBOOKS)" >>"$LOG"
ONEOPS_PLAYBOOKS_DIR="$PLAYBOOKS" nohup $CMD >>"$LOG" 2>&1 &
disown 2>/dev/null || true

# 3) Wait for it to answer, then open the browser.
for _ in $(seq 1 80); do
  curl -s -m 1 -o /dev/null "http://localhost:$PORT/" && break
  sleep 0.5
done
open "http://localhost:$PORT/" 2>/dev/null || echo "open http://localhost:$PORT/ in your browser"
