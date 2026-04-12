# Changelog

## v6.0

vidcord has been fully rewritten from Python + PyQt6 to **Tauri (Rust + React)**. This is a ground-up rebuild — not an incremental update.

### Core changes

- **New runtime**: Replaced PyInstaller + Python with a native Tauri binary. No Python interpreter, no PyQt6, no bundled runtime.
- **Smaller installer**: ~10 MB vs ~80 MB — Tauri uses the OS WebView (Edge on Windows, WebKit on macOS/Linux) instead of bundling one.
- **Faster startup**: Near-instant launch; hardware detection and settings load happen in the background.
- **Rust backend**: All FFmpeg orchestration, file I/O, GPU detection, settings, and update checking are now in Rust.
- **React frontend**: UI rebuilt in React + TypeScript with a Fluent Design stylesheet.

### New features

- **Video playback preview**: Play the trimmed segment in-app before compressing (Windows + macOS; disabled on Linux due to WebKit limitations).
- **Linux VAAPI hardware acceleration**: Added `h264_vaapi` encoder support alongside NVIDIA, AMD, Intel, and Apple Silicon.
- **Apple Silicon VideoToolbox**: Native `h264_videotoolbox` encoder on M-series Macs.
- **ARM64 Windows support**: New aarch64 NSIS installer for Snapdragon PCs.
- **Single-instance enforcement**: Opening a second instance forwards the file to the existing window instead of launching a duplicate.
- **Settings persistence**: Remove Audio, advanced mode values, and encoder selection are saved across sessions.
- **Auto-increment output**: If the output filename already exists, vidcord appends `_1`, `_2`, etc. instead of overwriting.
- **Trim frame preview**: Live thumbnail updates as you drag the trim sliders.

### Platform fixes

- **Windows**: `CREATE_NO_WINDOW` on all FFmpeg calls (no console flash); fixed WebView2 `AbortError` on seek.
- **macOS**: Fixed "Open With" cold-launch race condition; Apple Events file delivery; universal binary (x86_64 + aarch64).
- **Linux**: Fixed GStreamer/GIO module errors in AppImage; KDE Plasma white window; LXQt/minimal WM compatibility; Wayland + X11 support.

### Removed

- Python source (`vidcord.py`), `requirements.txt`, PyInstaller specs, and all legacy build scripts.
- Old Linux platform scripts (`build_appimage.sh`, Debian/Fedora/Arch packaging).
- `verify_bitrate.py`, `tools/` debug scripts.
