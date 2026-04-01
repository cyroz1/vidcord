#!/bin/bash
set -euo pipefail

# Determine project root relative to this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."

APP_NAME="vidcord"
IDENTIFIER="com.cyroz1.vidcord"
INSTALL_LOCATION="/Applications"

# Tauri build output path (universal or arch-specific)
TAURI_BUNDLE_DIR="$PROJECT_ROOT/src-tauri/target"

# Try universal build first, then arch-specific
if [ -d "$TAURI_BUNDLE_DIR/universal-apple-darwin/release/bundle/macos/$APP_NAME.app" ]; then
    APP_PATH="$TAURI_BUNDLE_DIR/universal-apple-darwin/release/bundle/macos/$APP_NAME.app"
elif [ -d "$TAURI_BUNDLE_DIR/aarch64-apple-darwin/release/bundle/macos/$APP_NAME.app" ]; then
    APP_PATH="$TAURI_BUNDLE_DIR/aarch64-apple-darwin/release/bundle/macos/$APP_NAME.app"
elif [ -d "$TAURI_BUNDLE_DIR/x86_64-apple-darwin/release/bundle/macos/$APP_NAME.app" ]; then
    APP_PATH="$TAURI_BUNDLE_DIR/x86_64-apple-darwin/release/bundle/macos/$APP_NAME.app"
elif [ -d "$TAURI_BUNDLE_DIR/release/bundle/macos/$APP_NAME.app" ]; then
    APP_PATH="$TAURI_BUNDLE_DIR/release/bundle/macos/$APP_NAME.app"
else
    echo "Error: $APP_NAME.app not found in Tauri build output."
    echo "Run 'npx tauri build' first."
    exit 1
fi

# Extract version from tauri.conf.json
if command -v jq &>/dev/null; then
    CLEAN_VERSION=$(jq -r '.version' "$PROJECT_ROOT/src-tauri/tauri.conf.json")
else
    CLEAN_VERSION=$(grep '"version"' "$PROJECT_ROOT/src-tauri/tauri.conf.json" | head -1 | sed -n 's/.*"\([0-9][0-9.]*\)".*/\1/p')
fi
if [[ -z "$CLEAN_VERSION" ]]; then
    echo "Error: Could not extract version from tauri.conf.json" >&2
    exit 1
fi

# Detect Architecture
ARCH=$(uname -m)

OUTPUT_DIR="$PROJECT_ROOT/src-tauri/target/release/bundle/pkg"
mkdir -p "$OUTPUT_DIR"
OUTPUT_PKG="$OUTPUT_DIR/vidcord_v${CLEAN_VERSION}_${ARCH}.pkg"

echo "Using app bundle: $APP_PATH"
echo "Building installer → $INSTALL_LOCATION/$APP_NAME.app"

# Single-step: productbuild --component guarantees the install location.
# This avoids distribution.xml entirely so macOS Installer cannot redirect
# the destination to ~/Applications or anywhere else.
productbuild \
    --component "$APP_PATH" "$INSTALL_LOCATION" \
    --identifier "$IDENTIFIER" \
    --version "$CLEAN_VERSION" \
    "$OUTPUT_PKG"

echo "Done. Installer created at $OUTPUT_PKG"
