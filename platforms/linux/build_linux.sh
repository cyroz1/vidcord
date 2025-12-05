#!/bin/bash
set -e

# Determine project root relative to this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# Change to project root
cd "$PROJECT_ROOT"

VENV_PYTHON="./venv/bin/python3"
VENV_PIP="./venv/bin/pip"
VENV_PYINSTALLER="./venv/bin/pyinstaller"

echo "Installing dependencies..."
$VENV_PIP install -r requirements.txt
$VENV_PIP install pyinstaller

echo "Building executable..."
$VENV_PYINSTALLER "$SCRIPT_DIR/vidcord_linux.spec"

echo "Build complete. Executable is in dist/vidcord"
