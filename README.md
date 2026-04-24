# <img src="public/icon.png" height="28" align="left"> vidcord

A fast, lightweight desktop app that compresses videos under Discord's upload
limits — powered by system FFmpeg, built with [Tauri 2](https://tauri.app)
(Rust + React).

<p>
  <img alt="Platforms"    src="https://img.shields.io/badge/platforms-windows%20%7C%20macos%20%7C%20linux-3b82f6">
  <img alt="Architectures" src="https://img.shields.io/badge/arch-x86__64%20%7C%20aarch64-1f6feb">
  <img alt="Version"      src="https://img.shields.io/github/v/release/cyroz1/vidcord?display_name=tag&sort=semver">
  <img alt="Downloads"    src="https://img.shields.io/github/downloads/cyroz1/vidcord/total">
  <img alt="Build"        src="https://img.shields.io/github/actions/workflow/status/cyroz1/vidcord/build.yml?branch=main">
  <img alt="Installer"    src="https://img.shields.io/badge/installer-~10%20MB-16a34a">
  <img alt="License"      src="https://img.shields.io/badge/license-MIT-blue">
</p>

![Program window](screenshots/window.png)

---

## Contents

- [Why vidcord](#why-vidcord)
- [Features](#features)
- [Screenshots](#screenshots)
- [Install](#install)
- [FFmpeg setup](#ffmpeg-setup)
- [Usage](#usage)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Hardware acceleration](#hardware-acceleration)
- [Building from source](#building-from-source)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## Why vidcord

Discord caps uploads at 10 MB (free), 25 MB (legacy), 50 MB (Nitro Basic /
Boost Level 2), 100 MB (Boost Level 3), and 500 MB (Nitro). vidcord picks a
target bitrate for the clip length you want, runs FFmpeg with the right
hardware encoder for your GPU, and drops the result in your **Downloads**
folder — under the size limit you asked for, on the first try.

- **~10 MB installer.** Tauri uses the system WebView (Edge on Windows,
  WebKit on macOS/Linux) instead of bundling Chromium.
- **Native-speed encoding.** Hardware encoders auto-detected: NVENC, AMF,
  QSV, VAAPI, VideoToolbox.
- **No telemetry, no accounts, no uploads.** Files never leave your machine.

## Features

- **Five quality presets** mapped to Discord's tiers:
  - 10 MB @ 480p — Discord free tier
  - 25 MB @ 480p — Discord free tier (legacy)
  - 50 MB @ 720p — Nitro Basic / Boost Level 2
  - 100 MB @ 1080p — Boost Level 3 or
    [Clips Bypass](https://github.com/riolubruh/YABDP4Nitro?tab=readme-ov-file#clips)
  - 500 MB @ native — Nitro Full
- **Advanced mode** — custom target size (MB), output resolution, and any
  FFmpeg video encoder string.
- **Trim timeline** with frame-accurate handles, draggable playhead,
  snap tick marks, and a minimap when zoomed in.
- **In-app preview** of the trimmed segment before you commit to a compress.
- **Hardware acceleration**, auto-detected at startup:
  - NVIDIA NVENC (`h264_nvenc`, `hevc_nvenc`)
  - AMD AMF (`h264_amf`, `hevc_amf`)
  - Intel Quick Sync (`h264_qsv`, `hevc_qsv`)
  - Linux VAAPI (`h264_vaapi`)
  - Apple Silicon VideoToolbox (`h264_videotoolbox`)
- **Three ways to open a video:** drag-and-drop onto the window, "Open with
  vidcord" from Explorer/Finder, or the in-app **Browse** button.
- **Remove audio** — strip the audio track to reclaim space.
- **Real-time progress** with ETA parsed from FFmpeg's stderr.
- **Auto-increment output** — saves `name-vidcord.mp4` and bumps `-1`, `-2`,
  … if the filename is taken, never overwriting.
- **In-app FFmpeg install banner** when it's missing — `winget` on Windows,
  `brew` on macOS, or distro package manager on Linux (with confirmation).
- **Cross-platform installers:** Windows NSIS (x86_64 + aarch64), macOS
  universal `.dmg`, Linux `.AppImage` (x86_64 + aarch64).

## Screenshots

| Main window | Advanced mode |
|---|---|
| ![Main window](screenshots/window.png) | ![Advanced mode](screenshots/advancedmode.png) |

| Output file | Windows context menu | macOS Finder |
|---|---|---|
| ![Output file](screenshots/file.png) | ![Windows context menu](screenshots/context.png) | ![Finder context menu](screenshots/finder.png) |

## Install

Grab the latest installer for your platform from the releases page:

**→ [Download latest release](https://github.com/cyroz1/vidcord/releases/latest)**

| Platform | Architecture | File |
|---|---|---|
| Windows 10/11 | x86_64 | `vidcord_<version>_x64-setup.exe` |
| Windows 10/11 | aarch64 | `vidcord_<version>_arm64-setup.exe` |
| macOS 11+ | universal | `vidcord_<version>_universal.dmg` |
| Linux (any distro with glibc) | x86_64 | `vidcord_<version>_amd64.AppImage` |
| Linux (any distro with glibc) | aarch64 | `vidcord_<version>_aarch64.AppImage` |

> **You still need FFmpeg.** vidcord does not bundle FFmpeg. See the next
> section.

## FFmpeg setup

vidcord shells out to the system `ffmpeg` and `ffprobe` binaries, which must
be on `PATH`. If they aren't, vidcord shows an in-app banner with a
one-click install for your platform.

### Windows (x86_64)

```powershell
winget install Gyan.FFmpeg
```

Restart vidcord (or sign out and back in) so the new `PATH` takes effect.

### Windows (aarch64 — Surface Pro X, Snapdragon PCs)

No official ARM64 build exists yet. See [FFMPEG_SETUP.md](FFMPEG_SETUP.md)
for the community build and manual PATH steps.

### macOS

```sh
brew install ffmpeg
```

### Linux

```sh
sudo apt install ffmpeg        # Debian / Ubuntu
sudo dnf install ffmpeg        # Fedora (needs RPM Fusion)
sudo pacman -S ffmpeg          # Arch / Manjaro
```

For more distros, manual installs, or troubleshooting, read
[FFMPEG_SETUP.md](FFMPEG_SETUP.md).

## Usage

1. **Open a video** — drop it onto the window, right-click → *Open with
   vidcord* from Explorer/Finder, or click **Browse File**.
2. **Pick a preset** — 10/25/50/100/500 MB, or flip on **Advanced mode** for
   a custom target size, resolution, and encoder.
3. **Trim** (optional) — drag the handles or use `I` / `O` to stamp the
   playhead. `Space` plays the selected range.
4. **Toggle Remove Audio** to strip audio if you need more video bitrate.
5. **Click Compress.** Progress and ETA update live. When it's done vidcord
   highlights the file in your file explorer.

Output goes to `~/Downloads/<original-name>-vidcord.mp4` by default, with
`-1`, `-2`, … appended if the name is taken.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / stop preview |
| `,` / `.` | Step one frame back / forward |
| `Shift` + `,` / `.` | Nudge active trim handle by one frame |
| `J` / `K` | Jump playhead to trim start / end |
| `[` / `]` | Nudge trim start / end by a small step |
| `I` / `O` | Set trim in / out to current playhead |
| `R` | Reset trim to full clip |
| `?` | Open shortcuts cheat-sheet |
| `Esc` | Dismiss overlays |

## Hardware acceleration

At startup vidcord runs `ffmpeg -encoders` and picks the best available
hardware encoder for the GPU it detects. You can override this from the
**Encoders** dialog.

| Vendor / Platform | Encoder | Notes |
|---|---|---|
| NVIDIA | `h264_nvenc`, `hevc_nvenc` | Maxwell 2nd-gen and newer |
| AMD | `h264_amf`, `hevc_amf` | Windows only; Linux uses VAAPI |
| Intel | `h264_qsv`, `hevc_qsv` | HD Graphics 500-series and newer |
| Linux (any GPU) | `h264_vaapi` | Requires a working `/dev/dri/renderD*` |
| Apple Silicon | `h264_videotoolbox` | Native on M-series Macs |
| Fallback (CPU) | `libx264`, `libx265` | Always available |

On Linux, vidcord probes `/dev/dri/renderD*` once per session to pick the
right VAAPI device, and sets `LIBVA_DRIVER_NAME=radeonsi` for AMD systems.

## Building from source

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| [Rust](https://rustup.rs) | stable (2021 edition) | `rustup default stable` |
| [Node.js](https://nodejs.org) | `^20.19` or `>=22.12` | see `package.json` engines |
| [FFmpeg](https://ffmpeg.org/download.html) | any recent | must be on `PATH` at runtime |
| **Linux extras** | — | `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf` |
| **Windows extras** | — | [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (pre-installed on Windows 11) |

### Run the dev build

```sh
git clone https://github.com/cyroz1/vidcord
cd vidcord
npm install
npm run tauri dev
```

Vite serves the frontend on `:5173` and Tauri launches the window with
hot-reload.

### Produce a release binary

```sh
npm run tauri build
```

Installers / bundles land in `src-tauri/target/release/bundle/`.

### Quality gates (what CI runs)

```sh
npm run lint                                            # eslint src
npm run typecheck                                       # tsc --noEmit
npm test                                                # vitest
npm run format                                          # prettier --write src
cargo fmt   --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --tests -- -D warnings
cargo test  --manifest-path src-tauri/Cargo.toml
cargo audit --manifest-path src-tauri/Cargo.toml        # respects .cargo/audit.toml
```

CI treats any clippy warning as an error — keep new Rust code warning-clean.

### Build profiles

- `release` — LTO, `codegen-units = 1`, `strip`, `panic = abort`. Used for
  tagged `v*` releases.
- `ci` — inherits `release` with `lto = false`, `codegen-units = 4`,
  `opt-level = 1`. Used by non-tag CI builds for speed.
- `dev.package."*"` — third-party deps built at `opt-level = 1` so FFmpeg
  stderr parsing and regex stay responsive in `tauri dev` while our own
  crate stays unoptimised for fast incremental compiles.

### CI / releases

[`.github/workflows/build.yml`](.github/workflows/build.yml) runs five jobs:
a shared frontend build, Rust lint + audit, clippy + tests, a 5-way bundle
matrix (Windows x86_64/aarch64, macOS universal, Linux x86_64/aarch64), and
a release job that extracts the matching `CHANGELOG.md` section and drafts
a GitHub release on `v*` tags.

## Project layout

```
src/                       React + TypeScript frontend
  App.tsx                  Root component — trim UI, preset wiring, compress flow
  components/              PreviewPane, ProgressSection, Toast, EncodersDialog
  hooks/                   useCompression, useEncoders, useSettings, useToasts
  __tests__/               Vitest tests (node env, Tauri APIs mocked)

src-tauri/                 Rust backend
  src/lib.rs               Tauri builder, plugins, Linux env shims, file-open routing
  src/ffmpeg.rs            Probe / preview / filmstrip / encoder detection + caches
  src/gpu.rs               Vendor detection (lspci / system_profiler / CIM)
  src/settings.rs          Typed settings persisted via atomic rename
  src/commands/            #[tauri::command] handlers (compression, encoders, files, updates)
  tauri.conf.json          Product config, CSP, file associations, bundle targets
```

A deeper architectural tour — IPC boundary, file-open race conditions,
cache layout, settings migration — lives in [CLAUDE.md](CLAUDE.md).

## Troubleshooting

**"FFmpeg not found" after installing it.**
`PATH` changes don't propagate to running processes. Quit vidcord fully
(check the tray / dock) and relaunch. On Windows, sign out and back in if
that doesn't help.

**The output file exceeds the target size.**
vidcord reserves a small overhead for container + audio. If you're still
over, try **Remove audio**, drop to a lower resolution in Advanced mode,
or pick `hevc_*` (H.265) if your recipient can decode it.

**Preview is blank on Linux.**
WebKit2GTK's `<video>` element has spotty codec coverage. Install
`gstreamer1.0-libav` and `gstreamer1.0-plugins-bad` (Debian/Ubuntu naming)
and relaunch.

**Windows console flashes during a compress.**
Shouldn't happen — every FFmpeg invocation sets `CREATE_NO_WINDOW`
(`0x08000000`). If you see it, open an issue with the vidcord log
(`%LOCALAPPDATA%\vidcord\vidcord.log`).

**Where do settings live?**

| OS | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\vidcord\settings.json` |
| macOS | `~/Library/Application Support/vidcord/settings.json` |
| Linux | `~/.local/share/vidcord/settings.json` |

Logs live alongside `settings.json` as `vidcord.log` (rotated at 5 MB).

## Contributing

Issues and PRs are welcome. Before opening a PR:

1. Run all quality gates above — CI is strict about clippy and formatting.
2. Add a `## vX.Y` section at the top of [CHANGELOG.md](CHANGELOG.md) for
   user-visible changes. The release workflow uses it as the GitHub release
   body.
3. **Don't bump version numbers casually.** `package.json`,
   `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` must stay in
   sync, and any bump triggers a release the next time a tag is pushed.

Read [CLAUDE.md](CLAUDE.md) for the architectural invariants you're
expected not to break (Tauri command registration, blocking work and
`spawn_blocking`, the three file-open delivery paths, Linux env shims for
KDE / LXQt / Sway / Hyprland, cache invalidation rules).

## License

vidcord is released under the [MIT License](LICENSE). FFmpeg is a separate
dependency and is licensed under the LGPL/GPL by its own authors — vidcord
invokes the `ffmpeg` and `ffprobe` binaries on your system but does not
redistribute them.

## Acknowledgements

- [FFmpeg](https://ffmpeg.org/) — the actual video compression.
- [Tauri](https://tauri.app/) — cross-platform desktop shell.
- [React](https://react.dev/) + [Vite](https://vitejs.dev/) — frontend.
- [YABDP4Nitro](https://github.com/riolubruh/YABDP4Nitro) — documented the
  Discord Clips size-limit quirk that the 100 MB preset targets.
