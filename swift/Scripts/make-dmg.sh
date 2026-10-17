#!/usr/bin/env bash
# Build the Swift port into a Vidcord.app and a drag-to-install DMG.
#
#   Scripts/make-dmg.sh [--skip-build]
#
# Products land in .build/ next to the package:
#   .build/Vidcord.app        the app bundle (ad hoc signed)
#   .build/Vidcord-Swift.dmg  the disk image, with its SHA-256 printed
#
# The signing is ad hoc ("-"): this port is an experiment with no
# Developer ID or notarization, the same posture the Tauri macOS CI
# bundles use. Gatekeeper will ask the user to right-click > Open on
# first launch. Nothing here needs an Apple account or any secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

CONFIG=release
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$SKIP_BUILD" -eq 0 ]; then
  swift build -c "$CONFIG"
fi

BIN_DIR="$(swift build -c "$CONFIG" --show-bin-path)"
BIN="$BIN_DIR/Vidcord"
if [ ! -x "$BIN" ]; then
  echo "built executable not found at $BIN" >&2
  exit 1
fi

APP=".build/Vidcord.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/Vidcord"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Vidcord</string>
  <key>CFBundleIdentifier</key>
  <string>net.cyroz.vidcord.swift</string>
  <key>CFBundleName</key>
  <string>Vidcord</string>
  <key>CFBundleDisplayName</key>
  <string>Vidcord (Swift)</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

# Ad hoc sign the bundle so macOS will run it locally and in CI.
codesign --force --sign - "$APP"
codesign --verify --strict "$APP"

DMG=".build/Vidcord-Swift.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Vidcord" -srcfolder "$STAGE" -format UDZO -ov "$DMG"

echo "app: $APP"
echo "dmg: $DMG"
shasum -a 256 "$DMG"
