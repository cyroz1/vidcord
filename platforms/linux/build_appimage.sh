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
cp "$SCRIPT_DIR/qt.conf" AppDir/usr/bin/

# Create AppRun symlink
# AppRun is the entry point. Linking it to our binary works for one-file builds.
ln -s usr/bin/vidcord AppDir/AppRun

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" == "x86_64" ]; then
    TOOL_NAME="appimagetool-x86_64.AppImage"
    FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
elif [ "$ARCH" == "aarch64" ]; then
    TOOL_NAME="appimagetool-aarch64.AppImage"
    FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

# Download and bundle FFmpeg
    curl -L -v --retry 5 --retry-delay 5 -o ffmpeg.tar.xz "$FFMPEG_URL"

echo "Extracting FFmpeg..."
tar -xf ffmpeg.tar.xz
# Find the extracted directory (it usually has a version number)
FFMPEG_DIR=$(find . -maxdepth 1 -type d -name "ffmpeg-*-static" | head -n 1)
cp "$FFMPEG_DIR/ffmpeg" AppDir/usr/bin/
cp "$FFMPEG_DIR/ffprobe" AppDir/usr/bin/
chmod +x AppDir/usr/bin/ffmpeg AppDir/usr/bin/ffprobe
rm -rf "$FFMPEG_DIR" ffmpeg.tar.xz

# Check for appimagetool in script directory
    curl -L -v --retry 5 --retry-delay 5 -o "$SCRIPT_DIR/$TOOL_NAME" "https://github.com/AppImage/appimagetool/releases/download/continuous/$TOOL_NAME"

# Build AppImage
echo "Building AppImage..."

# Extract version from vidcord.py
VERSION_LINE=$(grep 'CURRENT_VERSION =' "$PROJECT_ROOT/vidcord.py")
# Extract content between quotes
VERSION_STRING=$(echo "$VERSION_LINE" | sed -n 's/.*"\(.*\)".*/\1/p')

# Clean version (remove leading 'v' if present to avoid duplication in filename)
CLEAN_VERSION="${VERSION_STRING#v}"

OUTPUT_NAME="vidcord_v${CLEAN_VERSION}_${ARCH}.appimage"

mkdir -p "$PROJECT_ROOT/dist"
chmod +x "$SCRIPT_DIR/$TOOL_NAME"
ARCH=$ARCH "$SCRIPT_DIR/$TOOL_NAME" AppDir "$PROJECT_ROOT/dist/$OUTPUT_NAME"

echo "Success! AppImage created: $OUTPUT_NAME"
