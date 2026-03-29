# <img src="icon.ico" height="25"> vidcord

A fast, lightweight desktop app for compressing video files under Discord's size limits — powered by FFmpeg, built with **Tauri** (Rust + React). Available for **Windows, macOS, and Linux**.

## Download

[Download latest release installer.](https://github.com/cyroz1/vidcord/releases/latest)

## Features

- **Modern UI**: Clean, responsive interface styled after Fluent Design.
- **Three ways to import videos**:
  - **File Explorer / Finder**: Right-click a video → "Open with vidcord" (Windows, macOS).
  - **Drag and drop**: Drop a video file directly onto the window.
  - **Browse**: Click "Browse File" to pick a file.
- **Five quality presets**:
  - 10 MB, 480p — Discord free tier
  - 25 MB, 480p — Discord free tier (legacy)
  - 50 MB, 720p — Nitro Basic / Level 2 Server Boost
  - 100 MB, 1080p — Level 3 Server Boost or [Clips Bypass](https://github.com/riolubruh/YABDP4Nitro?tab=readme-ov-file#clips)
  - 500 MB, native — Nitro Full
- **Advanced Mode**: Custom target size (MB), resolution, and any FFmpeg encoder string.
- **Trim**: Adjustable start/end sliders with live frame preview.
- **Video playback preview**: Play the selected trim segment in-app before compressing.
- **Remove Audio**: Strip audio tracks to reclaim space.
- **Hardware acceleration**: NVIDIA (NVENC), AMD (AMF), Intel (QSV), Linux VAAPI, Apple Silicon (VideoToolbox) — auto-detected at startup.
- **Real-time progress**: Progress bar and ETA updated as FFmpeg runs.
- **Auto output**: Saves to your Downloads folder with an auto-incremented filename, then opens it in the file explorer.
- **Tiny binary**: ~10 MB installer (no bundled runtime — Tauri uses the system WebView).

## Screenshots

### Program window

![Program window](screenshots/window.png)

### Advanced mode

![Advanced mode](screenshots/advancedmode.png)

### Output file example

![Output file example](screenshots/file.png)

### Context menu integration

![Context menu integration](screenshots/context.png)
![Finder context menu integration](screenshots/finder.png)

## Building

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Rust](https://rustup.rs) | stable | Install via `rustup` |
| [Node.js](https://nodejs.org) | 18+ | For the React frontend |
| [FFmpeg](https://ffmpeg.org/download.html) | any recent | Must be on `PATH` at runtime |
| **Linux only** | | `libwebkit2gtk-4.1-dev`, `libgtk-3-dev` |
| **Windows only** | | [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (pre-installed on Win11) |

### Install and run (dev)

```sh
# Install frontend dependencies
npm install

# Start the dev server with hot-reload
npm run tauri dev
```

### Build a release binary

```sh
npm run tauri build
```

The signed installer or `.AppImage` will be in `src-tauri/target/release/bundle/`.

### CI / cross-platform releases

GitHub Actions builds on Windows, macOS, and Linux via the [`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action) matrix. See [`.github/workflows/build.yml`](.github/workflows/build.yml).

## Acknowledgements

- [FFmpeg](https://ffmpeg.org/)
- [Tauri](https://tauri.app/)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
