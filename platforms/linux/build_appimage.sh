#!/bin/bash
set -e

# Determine project root relative to this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# Ensure dist/vidcord exists
if [ ! -f "$PROJECT_ROOT/dist/vidcord" ]; then
    echo "Error: dist/vidcord not found. Please run PyInstaller first."
    exit 1
fi

# Create AppDir structure
echo "Setting up AppDir..."
rm -rf AppDir
mkdir -p AppDir/usr/bin

# Copy files
cp "$PROJECT_ROOT/dist/vidcord" AppDir/usr/bin/
cp "$PROJECT_ROOT/icon.png" AppDir/icon.png
cp "$SCRIPT_DIR/vidcord.desktop" AppDir/

# Create AppRun symlink
# AppRun is the entry point. Linking it to our binary works for one-file builds.
ln -s usr/bin/vidcord AppDir/AppRun

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" == "x86_64" ]; then
    TOOL_NAME="appimagetool-x86_64.AppImage"
elif [ "$ARCH" == "aarch64" ]; then
    TOOL_NAME="appimagetool-aarch64.AppImage"
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

# Download appimagetool if not exists
if [ ! -f "$TOOL_NAME" ]; then
    echo "Downloading $TOOL_NAME..."
    if command -v wget >/dev/null 2>&1; then
        wget -q "https://github.com/AppImage/appimagetool/releases/download/continuous/$TOOL_NAME"
    elif command -v curl >/dev/null 2>&1; then
        curl -L -o "$TOOL_NAME" "https://github.com/AppImage/appimagetool/releases/download/continuous/$TOOL_NAME"
    else
        echo "Error: Neither wget nor curl found. Cannot download appimagetool."
        exit 1
    fi
    chmod +x "$TOOL_NAME"
fi

# Build AppImage
echo "Building AppImage..."
ARCH=$ARCH ./$TOOL_NAME AppDir

echo "Success! AppImage created."
