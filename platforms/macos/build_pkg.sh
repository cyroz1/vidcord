#!/bin/bash
set -e

# Determine project root relative to this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."

APP_NAME="vidcord"
IDENTIFIER="com.cyroz1.vidcord"
INSTALL_LOCATION="/Applications"
DIST_DIR="$PROJECT_ROOT/dist"
APP_PATH="$DIST_DIR/$APP_NAME.app"

# Extract version from vidcord.py
VERSION_LINE=$(grep 'CURRENT_VERSION =' "$PROJECT_ROOT/vidcord.py")
VERSION_STRING=$(echo "$VERSION_LINE" | sed -n 's/.*"\(.*\)".*/\1/p')
CLEAN_VERSION="${VERSION_STRING#v}"

# Detect Architecture
ARCH=$(uname -m)

OUTPUT_PKG_NAME="vidcord_v${CLEAN_VERSION}_${ARCH}.pkg"
OUTPUT_PKG="$DIST_DIR/$OUTPUT_PKG_NAME"

# Check if the app exists
if [ ! -d "$APP_PATH" ]; then
    echo "Error: $APP_PATH not found. Please run PyInstaller first."
    exit 1
fi

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
