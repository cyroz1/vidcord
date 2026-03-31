#!/bin/bash
# linux/debian/build_deb.sh
set -e

# Ensure we are in the right directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$SCRIPT_DIR/../.."

# Build the binary first
cd "$ROOT_DIR"
# ./linux/build.sh # Assuming build is done separately or handled by user workflow

# Extract version from vidcord.py
VERSION_LINE=$(grep 'CURRENT_VERSION =' "$ROOT_DIR/vidcord.py")
VERSION_STRING=$(echo "$VERSION_LINE" | sed -n 's/.*"\(.*\)".*/\1/p')
CLEAN_VERSION="${VERSION_STRING#v}"

# Detect Architecture
ARCH_RAW=$(uname -m)
if [ "$ARCH_RAW" == "x86_64" ]; then
    DEB_ARCH="amd64"
elif [ "$ARCH_RAW" == "aarch64" ]; then
    DEB_ARCH="arm64"
else
    DEB_ARCH="$ARCH_RAW"
fi

OUTPUT_NAME="vidcord_v${CLEAN_VERSION}_${DEB_ARCH}.deb"

# Create package structure
PKG_DIR="$ROOT_DIR/platforms/linux/debian/vidcord_pkg"
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/DEBIAN"
mkdir -p "$PKG_DIR/usr/bin"
mkdir -p "$PKG_DIR/opt/vidcord"
mkdir -p "$PKG_DIR/usr/share/applications"
mkdir -p "$PKG_DIR/usr/share/pixmaps"

# Check if binary exists
if [ ! -d "$ROOT_DIR/dist/vidcord" ]; then
    echo "Error: dist/vidcord directory not found. Please run the build script first."
    exit 1
fi

# Copy binary
cp -r "$ROOT_DIR/dist/vidcord" "$PKG_DIR/opt/vidcord/vidcord_bin"

# Create launcher script
echo '#!/bin/bash
/opt/vidcord/vidcord_bin/vidcord "$@"' > "$PKG_DIR/usr/bin/vidcord"
chmod +x "$PKG_DIR/usr/bin/vidcord"

# Process control file
cp "$SCRIPT_DIR/control" "$PKG_DIR/DEBIAN/control"
# Update version and architecture in control file
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/Version: .*/Version: $CLEAN_VERSION/" "$PKG_DIR/DEBIAN/control"
    sed -i '' "s/Architecture: .*/Architecture: $DEB_ARCH/" "$PKG_DIR/DEBIAN/control"
else
    sed -i "s/Version: .*/Version: $CLEAN_VERSION/" "$PKG_DIR/DEBIAN/control"
    sed -i "s/Architecture: .*/Architecture: $DEB_ARCH/" "$PKG_DIR/DEBIAN/control"
fi

# Create Desktop Entry
echo "[Desktop Entry]
Type=Application
Version=1.0
Name=VidCord
Comment=Video Compressor
Exec=vidcord %F
Icon=vidcord
Terminal=false
Categories=AudioVideo;Video;" > "$PKG_DIR/usr/share/applications/vidcord.desktop"

# Copy Icon
if [ -f "$ROOT_DIR/icon.png" ]; then
    cp "$ROOT_DIR/icon.png" "$PKG_DIR/usr/share/pixmaps/vidcord.png"
fi

# Build .deb
dpkg-deb --build "$PKG_DIR" "$ROOT_DIR/$OUTPUT_NAME"

echo "Debian package built: $ROOT_DIR/$OUTPUT_NAME"
