# FFmpeg Setup for the Native Desktop App

This guide is for the native desktop app. The browser editor at
[vidcord.app](https://vidcord.app/) does not require a system FFmpeg install: the
editor renders first and loads its fixed FFmpeg WebAssembly encoder on demand
when export work starts. Lossless Trim may load it during local keyframe
discovery. Selected files stay in the browser, and finished exports download
through the browser. It is the quick no-install fallback for a phone, tablet, or
desktop browser when you need an export in a pinch. Browser inputs must be
readable by the browser and are limited to 512 MB per file; performance depends
on the browser, device, available memory, and source format. The browser encoder
is fixed to `libx264`, Browser Batch uses one full-duration Compress profile for
up to 12 files, and the browser controls the download location. See the
[README browser capability matrix](README.md#browser-and-desktop-capability-matrix)
for the complete browser/desktop boundary.

The desktop app requires FFmpeg to be installed and available on your system
`PATH`. Follow the steps for your platform below.

If FFmpeg is missing, the desktop app can help install it without bundling
FFmpeg binaries:

- Windows: the installer and first launch can run `winget install Gyan.FFmpeg`
- macOS: runs `brew install ffmpeg`
- Linux: can run distro install commands with privilege confirmation

---

## Windows

### Package-manager setup

The vidcord installer and first-launch setup offer to install FFmpeg with
`winget` if `ffmpeg` and `ffprobe` are not already on PATH. If you skipped that
step or the automatic install failed, open **PowerShell** or **Command Prompt**
and run:

```powershell
winget install Gyan.FFmpeg
```

When the command finishes, return to vidcord and use **Retry**. vidcord also
checks WinGet's FFmpeg installation directory directly, so a Windows restart
should not be necessary.

> `winget` is built into Windows 10 (1809+) and Windows 11. If it's not available, [download winget here](https://aka.ms/getwinget).

### ARM64 (Surface Pro X, Snapdragon PCs)

vidcord tries `winget` first. If that package is unavailable for your ARM64 PC,
download the community build manually:

1. Go to [github.com/tordona/ffmpeg-win-arm64/releases](https://github.com/tordona/ffmpeg-win-arm64/releases) and download the latest `ffmpeg-*-essentials-static-win-arm64.7z`
2. Extract the archive (use [7-Zip](https://www.7-zip.org/) if needed)
3. Copy `ffmpeg.exe` and `ffprobe.exe` to a permanent folder, e.g. `C:\ffmpeg\`
4. Add that folder to your PATH:
   - Open **Start** → search **"Edit the system environment variables"**
   - Click **Environment Variables** → under _System variables_, select **Path** → **Edit**
   - Click **New** and enter `C:\ffmpeg`
   - Click **OK** on all dialogs, then restart your PC

---

## macOS

Install [Homebrew](https://brew.sh) if you don't have it, then run:

```sh
brew install ffmpeg
```

---

## Linux

**Ubuntu / Debian:**

```sh
sudo apt install ffmpeg
```

**Fedora:**

```sh
sudo dnf install ffmpeg
```

**Arch / Manjaro:**

```sh
sudo pacman -S ffmpeg
```

---

## Verify the installation

Open a new terminal after installation and confirm that both required tools are
available:

```sh
ffmpeg -version
ffprobe -version
```

The desktop app requires both commands. If either one is missing, restart your
shell or computer after the package manager updates `PATH`, then try again. On
Windows, vidcord can also detect a standard `Gyan.FFmpeg` WinGet installation
before that PATH update reaches other running programs. Once both commands
work, launch the desktop app normally and it will detect FFmpeg automatically.

If you only want the browser editor, return to
[vidcord.app](https://vidcord.app/); do not install system FFmpeg just for the
web workflow.
