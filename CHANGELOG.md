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
- **ARM64 support**: New aarch64 installers for Windows (NSIS) and Linux (AppImage); macOS ships as a universal binary.
- **Single-instance enforcement**: Opening a second instance forwards the file to the existing window instead of launching a duplicate.
- **Settings persistence**: Remove Audio, advanced mode values, and encoder selection are saved across sessions.
- **Auto-increment output**: Output is saved to `Downloads/<name>-vidcord.mp4`; if that name is taken, `-1`, `-2`, etc. are appended instead of overwriting.
- **Trim frame preview**: Live thumbnail updates as you drag the trim sliders.
- **File associations**: `.mp4`, `.avi`, `.mov`, `.mkv`, `.flv`, `.wmv`, and `.webm` registered with the OS so "Open with vidcord" works from Explorer/Finder.
- **Update checker**: Background GitHub release check with proper semver comparison, respecting a user-configurable cadence.
- **Error boundary & toasts**: Frontend crashes surface as a recoverable error instead of a blank window, and notifications use a non-blocking toast system.

### Installers

- **Windows**: NSIS installer (x86_64 + aarch64), replacing the previous Inno Setup script.
- **macOS**: Universal `.dmg` containing both aarch64 and x86_64 slices.
- **Linux**: `.AppImage` for x86_64 and aarch64.

### Platform fixes

- **Windows**: `CREATE_NO_WINDOW` on every FFmpeg/probe invocation (no console flash); fixed WebView2 `AbortError` on seek; `explorer /select` handles paths with spaces and the `\\?\` extended-length prefix.
- **macOS**: Fixed "Open With" cold-launch race condition; Apple Events file delivery via `RunEvent::Opened`; installer hard-locked to `/Applications`.
- **Linux**: Fixed GStreamer/GIO module errors in the AppImage; KDE Plasma white-window rendering; LXQt/minimal-WM startup; Wayland + X11 compatibility.

### Removed

- Python source (`vidcord.py`), `requirements.txt`, PyInstaller specs, and all legacy build scripts.
- Old Linux platform scripts (`build_appimage.sh`, Debian/Fedora/Arch packaging).
- `verify_bitrate.py`, `benchmark_startup.py`, `debug_encoders.py`, and other `tools/` debug scripts.
