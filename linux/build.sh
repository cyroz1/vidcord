#!/bin/bash
# linux/build.sh
# Requires: pyinstaller, requirements.txt installed

# Clean previous builds
rm -rf dist build

# Run PyInstaller with Linux spec
pyinstaller vidcord_linux.spec

echo "Build complete. Executable is in dist/vidcord"
