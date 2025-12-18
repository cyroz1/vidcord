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

# Check if the app exists
if [ ! -d "$APP_PATH" ]; then
    echo "Error: $APP_PATH not found. Please run PyInstaller first."
    exit 1
fi

# Verify bundle contents before packaging
echo "Verifying bundle contents..."
if [ -d "$APP_PATH/Contents/Frameworks" ]; then
    echo "Frameworks found:"
    ls -R "$APP_PATH/Contents/Frameworks"
else
    echo "Warning: No Frameworks directory found in bundle."
fi

# Create the component package
# Using --component is better for .app bundles than --root
echo "Creating component package..."
pkgbuild --component "$APP_PATH" \
         --install-location "$INSTALL_LOCATION" \
         "$DIST_DIR/$APP_NAME-component.pkg"

# Create the product archive (installer)
echo "Creating product archive..."
productbuild --distribution "$SCRIPT_DIR/distribution.xml" \
             --package-path "$DIST_DIR" \
             --resources "$SCRIPT_DIR" \
             "$DIST_DIR/$OUTPUT_PKG_NAME"

# Clean up component package
rm "$DIST_DIR/$APP_NAME-component.pkg"

echo "Done. Installer created at $DIST_DIR/$OUTPUT_PKG_NAME"

