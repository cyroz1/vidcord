# <img src="public/icon.png" height="25"> vidcord

A fast, lightweight desktop app for compressing video files under Discord's size limits — powered by FFmpeg, built with **Tauri** (Rust + React). Available for **Windows, macOS, and Linux**.

## Download

[Download latest release installer.](https://github.com/cyroz1/vidcord/releases/latest)

## Prerequisites

**FFmpeg must be installed on your system before running vidcord.** It is not bundled with the app.

When FFmpeg is missing, vidcord now shows an in-app install banner:
- Windows: one-click install via `winget`
- Windows ARM64: guided fallback to community ARM64 build download
- macOS: one-click install via `brew` (Homebrew required)
- Linux: optional in-app privileged install (with confirmation), plus manual guidance fallback

**Windows (x86_64)**
```powershell
winget install Gyan.FFmpeg
```
Then restart your PC (or vidcord) if PATH changes are not detected immediately.

**Windows (ARM64 — Surface Pro X, Snapdragon PCs)**
No official ARM64 FFmpeg build exists yet. See [FFMPEG_SETUP.md](FFMPEG_SETUP.md) for manual install steps.

**macOS**
```sh
brew install ffmpeg
```

**Linux (Ubuntu/Debian)**
```sh
sudo apt install ffmpeg
```

For Fedora, Arch, and other distros, see [FFMPEG_SETUP.md](FFMPEG_SETUP.md).

## Features

- **Modern UI**: Clean, responsive interface.
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
| [Node.js](https://nodejs.org) | 22.12+ | For the React frontend |
| [FFmpeg](https://ffmpeg.org/download.html) | any recent | Must be on `PATH` at runtime |
| **Linux only** | | `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf` |
| **Windows only** | | [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (pre-installed on Win11) |

### Install FFmpeg

FFmpeg must be installed and available on your `PATH` before running or building vidcord.

**Windows**
```sh
winget install ffmpeg
```

**macOS**
```sh
brew install ffmpeg
```

**Linux (Debian/Ubuntu)**
```sh
sudo apt install ffmpeg
```

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

The installer or `.AppImage` will be in `src-tauri/target/release/bundle/`.

### CI / cross-platform releases

GitHub Actions builds on Windows (x86_64 + aarch64), macOS (universal), and Linux (x86_64 + aarch64) using a custom matrix that runs `npm run tauri build`. See [`.github/workflows/build.yml`](.github/workflows/build.yml).

## Acknowledgements

- [FFmpeg](https://ffmpeg.org/)
- [Tauri](https://tauri.app/)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
