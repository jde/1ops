#!/usr/bin/env bash
# Installs 1ops on macOS:
#   • a `1ops` command on your PATH that launches the local server + opens a browser
#   • a Dock app (1ops.app, 🔑 icon) that does the same
#   • restart semantics: a running server is killed and restarted on each launch
# Re-runnable (idempotent). Undo with scripts/uninstall.sh.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$SCRIPT_DIR")"
PORT=1134
HOMEDIR="$HOME/.1ops"
APP="$HOME/Applications/1ops.app"

say() { printf '  %s\n' "$*"; }
echo "Installing 1ops from $REPO"

# ── prerequisites ────────────────────────────────────────────────────────────
if ! command -v pnpm >/dev/null 2>&1; then
  echo "✗ pnpm not found on PATH. Install it first (npm i -g pnpm), then re-run." >&2
  exit 1
fi
PNPM_DIR="$(dirname "$(command -v pnpm)")"
NODE_DIR="$(dirname "$(command -v node)")"
EXTRA_PATH="$PNPM_DIR:$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# ── config ───────────────────────────────────────────────────────────────────
PLAYBOOKS="${ONEOPS_PLAYBOOKS_DIR:-$HOME/playbooks}"
mkdir -p "$HOMEDIR" "$PLAYBOOKS"
cat > "$HOMEDIR/config" <<CFG
# Written by scripts/install.sh — edit ONEOPS_CMD to "pnpm start" for a prod build.
ONEOPS_REPO="$REPO"
ONEOPS_PORT="$PORT"
ONEOPS_CMD="pnpm dev"
ONEOPS_PLAYBOOKS_DIR="$PLAYBOOKS"
ONEOPS_PATH="$EXTRA_PATH:\$PATH"
CFG
chmod +x "$SCRIPT_DIR/launch.sh"
say "✓ config       → $HOMEDIR/config   (playbooks: $PLAYBOOKS)"

# ── PATH command ─────────────────────────────────────────────────────────────
BINDIR=""
for d in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/bin"; do
  case ":$PATH:" in
    *":$d:"*) if mkdir -p "$d" 2>/dev/null && [ -w "$d" ]; then BINDIR="$d"; break; fi ;;
  esac
done
PATH_NOTE=""
if [ -z "$BINDIR" ]; then BINDIR="$HOME/.local/bin"; mkdir -p "$BINDIR"; PATH_NOTE="$BINDIR"; fi
cat > "$BINDIR/1ops" <<SH
#!/usr/bin/env bash
exec "$SCRIPT_DIR/launch.sh" "\$@"
SH
chmod +x "$BINDIR/1ops"
say "✓ command      → $BINDIR/1ops"

# ── icon (best-effort) ───────────────────────────────────────────────────────
ICNS="$SCRIPT_DIR/1ops.icns"
if command -v swift >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  TMP="$(mktemp -d)"; ICONSET="$TMP/1ops.iconset"; mkdir -p "$ICONSET"
  if swift "$SCRIPT_DIR/make-icon.swift" "$TMP/icon.png" 2>/dev/null; then
    for s in 16 32 128 256 512; do
      sips -z "$s" "$s"       "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}.png"    >/dev/null 2>&1
      sips -z "$((s*2))" "$((s*2))" "$TMP/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
    done
    iconutil -c icns "$ICONSET" -o "$ICNS" 2>/dev/null && say "✓ icon         → $ICNS"
  fi
  rm -rf "$TMP"
fi
[ -f "$ICNS" ] || say "• icon         → skipped (swift/iconutil unavailable); app uses default"

# ── .app bundle ──────────────────────────────────────────────────────────────
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>1ops</string>
  <key>CFBundleDisplayName</key><string>1ops</string>
  <key>CFBundleIdentifier</key><string>co.rolldeep.1ops</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>1ops</string>
  <key>CFBundleIconFile</key><string>1ops</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/1ops" <<SH
#!/usr/bin/env bash
exec "$SCRIPT_DIR/launch.sh"
SH
chmod +x "$APP/Contents/MacOS/1ops"
[ -f "$ICNS" ] && cp "$ICNS" "$APP/Contents/Resources/1ops.icns"
# Nudge Finder/LaunchServices to pick up the new icon.
touch "$APP"
say "✓ app          → $APP"

# ── add to Dock (idempotent) ─────────────────────────────────────────────────
if ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "$APP"; then
  defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://$APP/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
  killall Dock 2>/dev/null || true
  say "✓ dock         → added (Dock restarted)"
else
  say "• dock         → already present"
fi

echo "Done."
[ -n "$PATH_NOTE" ] && echo "⚠ Add to your shell profile:  export PATH=\"$PATH_NOTE:\$PATH\""
echo "Launch with:  1ops   (or click the 🔑 in your Dock)"
