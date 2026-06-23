#!/usr/bin/env bash
# Removes what install.sh added: the Dock icon, the .app, the PATH command, and
# (optionally) the running server. Leaves your playbooks and the repo untouched.
set -uo pipefail

APP="$HOME/Applications/1ops.app"
PORT="${ONEOPS_PORT:-1134}"
[ -f "$HOME/.1ops/config" ] && . "$HOME/.1ops/config"

# stop a running server
pids="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
[ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null || true

# remove the PATH command(s)
for d in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/bin"; do
  [ -f "$d/1ops" ] && rm -f "$d/1ops" && echo "removed $d/1ops"
done

# remove from Dock
if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "1ops.app"; then
  /usr/bin/python3 - "$APP" <<'PY' 2>/dev/null || true
import subprocess, sys
app = sys.argv[1]
import plistlib, os
# Use PlistBuddy-free approach: read via defaults export, filter, rewrite.
out = subprocess.run(["defaults","export","com.apple.dock","-"],capture_output=True).stdout
pl = plistlib.loads(out)
pa = pl.get("persistent-apps",[])
pl["persistent-apps"] = [x for x in pa if app not in plistlib.dumps(x).decode("utf-8","ignore")]
subprocess.run(["defaults","import","com.apple.dock","-"],input=plistlib.dumps(pl))
PY
  killall Dock 2>/dev/null || true
  echo "removed Dock icon"
fi

# remove the app bundle
[ -d "$APP" ] && rm -rf "$APP" && echo "removed $APP"

echo "Uninstalled. (Kept ~/.1ops/config and your playbooks; delete ~/.1ops to purge.)"
