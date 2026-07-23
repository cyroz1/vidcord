# FFmpeg Setup

vidcord requires FFmpeg to be installed and available on your system PATH. Follow the steps for your platform below.

If FFmpeg is missing, vidcord can help install it without bundling FFmpeg
binaries:

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
   - Click **Environment Variables** → under *System variables*, select **Path** → **Edit**
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

vidcord requires both commands. If either one is missing, restart your shell or
computer after the package manager updates PATH, then try again. On Windows,
vidcord can also detect a standard `Gyan.FFmpeg` WinGet installation before that
PATH update reaches other running programs. Once both commands work, launch
vidcord normally and it will detect FFmpeg automatically.
