#!/bin/bash

# Determine project root relative to this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."

APP_NAME="vidcord"
VERSION="5.0"
IDENTIFIER="com.cyroz1.vidcord"
INSTALL_LOCATION="/Applications"
DIST_DIR="$PROJECT_ROOT/dist"
APP_PATH="$DIST_DIR/$APP_NAME.app"
PKG_NAME="${APP_NAME}_v${VERSION}.pkg"

# Check if the app exists
if [ ! -d "$APP_PATH" ]; then
    echo "Error: $APP_PATH not found. Please run PyInstaller first."
    exit 1
fi

# Create the component package
echo "Creating component package..."
pkgbuild --root "$APP_PATH" \
         --identifier "$IDENTIFIER" \
         --version "$VERSION" \
         --install-location "$INSTALL_LOCATION/$APP_NAME.app" \
         "$DIST_DIR/$APP_NAME-component.pkg"

# Create the product archive (installer)
echo "Creating product archive..."
productbuild --distribution "$SCRIPT_DIR/distribution.xml" \
             --package-path "$DIST_DIR" \
             --resources "$SCRIPT_DIR" \
             "$DIST_DIR/$PKG_NAME"

# Clean up component package
rm "$DIST_DIR/$APP_NAME-component.pkg"

echo "Done. Installer created at $DIST_DIR/$PKG_NAME"
