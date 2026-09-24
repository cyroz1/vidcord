#!/usr/bin/env bash
set -euo pipefail

pkg_config_packages=(glib-2.0 gobject-2.0 gdk-3.0 webkit2gtk-4.1)

if pkg-config --exists "${pkg_config_packages[@]}"; then
  exit 0
fi

for attempt in 1 2 3; do
  if sudo apt-get update &&
    sudo apt-get install --no-install-recommends -y \
      libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils; then
    break
  fi

  if [[ "$attempt" -eq 3 ]]; then
    echo "Unable to install Linux system dependencies after $attempt attempts." >&2
    exit 1
  fi
done

pkg-config --exists "${pkg_config_packages[@]}"
