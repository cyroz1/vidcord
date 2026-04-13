# FFmpeg Setup

vidcord requires FFmpeg to be installed and available on your system PATH. Follow the steps for your platform below.

If FFmpeg is missing, vidcord now shows an install banner in-app:
- Windows: runs `winget install Gyan.FFmpeg`
- Windows ARM64: opens guided community build download page
- macOS: runs `brew install ffmpeg`
- Linux: can run distro install commands with privilege confirmation

---

## Windows

### x86_64 (most PCs)

Open **PowerShell** or **Command Prompt** and run:

```powershell
winget install Gyan.FFmpeg
```

Then **restart your PC** (or sign out and back in) to apply the PATH change.

> `winget` is built into Windows 10 (1809+) and Windows 11. If it's not available, [download winget here](https://aka.ms/getwinget).

### ARM64 (Surface Pro X, Snapdragon PCs)

No official ARM64 FFmpeg build exists for Windows yet. Download the community build manually:

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

After installing, launch vidcord normally — it will detect FFmpeg automatically.
