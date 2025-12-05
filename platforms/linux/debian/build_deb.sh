#!/bin/bash
# linux/debian/build_deb.sh

# Ensure we are in the right directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$SCRIPT_DIR/../.."

# Build the binary first
cd "$ROOT_DIR"
./linux/build.sh

# Create package structure
PKG_DIR="$ROOT_DIR/linux/debian/vidcord_pkg"
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/DEBIAN"
mkdir -p "$PKG_DIR/usr/bin"
mkdir -p "$PKG_DIR/opt/vidcord"
mkdir -p "$PKG_DIR/usr/share/applications"
mkdir -p "$PKG_DIR/usr/share/pixmaps"

# Copy binary
cp -r "$ROOT_DIR/dist/vidcord" "$PKG_DIR/opt/vidcord/vidcord_bin"

# Create launcher script
echo '#!/bin/bash
/opt/vidcord/vidcord_bin' > "$PKG_DIR/usr/bin/vidcord"
chmod +x "$PKG_DIR/usr/bin/vidcord"

# Copy control file
cp "$SCRIPT_DIR/control" "$PKG_DIR/DEBIAN/control"

# Create Desktop Entry
echo "[Desktop Entry]
Type=Application
Version=1.0
Name=VidCord
Comment=Video Compressor
Exec=vidcord
Icon=vidcord
Terminal=false
Categories=AudioVideo;Video;" > "$PKG_DIR/usr/share/applications/vidcord.desktop"

# Copy Icon
cp "$ROOT_DIR/icon.png" "$PKG_DIR/usr/share/pixmaps/vidcord.png"

# Build .deb
dpkg-deb --build "$PKG_DIR" "$ROOT_DIR/vidcord_5.0_amd64.deb"

echo "Debian package built: $ROOT_DIR/vidcord_5.0_amd64.deb"
