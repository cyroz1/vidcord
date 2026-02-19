#!/bin/bash
set -e

# Determine project root relative to this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# Ensure dist/vidcord exists (one-file build output)
if [ ! -f "$PROJECT_ROOT/dist/vidcord" ]; then
    echo "Error: dist/vidcord not found. Please run PyInstaller first."
    exit 1
fi

# Create AppDir structure (always in a temp location, not wherever the shell cwd is)
APPDIR="$PROJECT_ROOT/AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"

# Copy files
cp "$PROJECT_ROOT/dist/vidcord" "$APPDIR/usr/bin/"
cp "$PROJECT_ROOT/icon.png"       "$APPDIR/icon.png"
cp "$SCRIPT_DIR/vidcord.desktop"  "$APPDIR/"
cp "$SCRIPT_DIR/qt.conf"          "$APPDIR/usr/bin/"

# Create AppRun entry-point symlink and make binary executable
chmod +x "$APPDIR/usr/bin/vidcord"
ln -sf usr/bin/vidcord "$APPDIR/AppRun"

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
echo "Downloading FFmpeg..."
curl -L --retry 5 --retry-delay 5 -o "$PROJECT_ROOT/ffmpeg.tar.xz" "$FFMPEG_URL"

echo "Extracting FFmpeg..."
tar -xf "$PROJECT_ROOT/ffmpeg.tar.xz" -C "$PROJECT_ROOT"
FFMPEG_DIR=$(find "$PROJECT_ROOT" -maxdepth 1 -type d -name "ffmpeg-*-static" | head -n 1)
cp "$FFMPEG_DIR/ffmpeg"  "$APPDIR/usr/bin/"
cp "$FFMPEG_DIR/ffprobe" "$APPDIR/usr/bin/"
chmod +x "$APPDIR/usr/bin/ffmpeg" "$APPDIR/usr/bin/ffprobe"
rm -rf "$FFMPEG_DIR" "$PROJECT_ROOT/ffmpeg.tar.xz"

# Download appimagetool only if not already cached
TOOL_PATH="$SCRIPT_DIR/$TOOL_NAME"
if [ ! -f "$TOOL_PATH" ]; then
    echo "Downloading $TOOL_NAME..."
    curl -L --retry 5 --retry-delay 5 -o "$TOOL_PATH" \
        "https://github.com/AppImage/appimagetool/releases/download/continuous/$TOOL_NAME"
fi
chmod +x "$TOOL_PATH"

# Extract version from vidcord.py
VERSION_LINE=$(grep 'CURRENT_VERSION =' "$PROJECT_ROOT/vidcord.py")
VERSION_STRING=$(echo "$VERSION_LINE" | sed -n 's/.*"\(.*\)".*/\1/p')
CLEAN_VERSION="${VERSION_STRING#v}"
OUTPUT_NAME="vidcord_v${CLEAN_VERSION}_${ARCH}.appimage"

echo "Building AppImage..."
mkdir -p "$PROJECT_ROOT/dist"
ARCH=$ARCH "$TOOL_PATH" "$APPDIR" "$PROJECT_ROOT/dist/$OUTPUT_NAME"

# Clean up
rm -rf "$APPDIR"

echo "Success! AppImage created: dist/$OUTPUT_NAME"
