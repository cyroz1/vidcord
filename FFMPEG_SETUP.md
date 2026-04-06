# FFmpeg Setup

vidcord requires FFmpeg to be installed and available on your system PATH. Follow the steps for your platform below.

---

## Windows

Open **PowerShell** or **Command Prompt** and run:

```powershell
winget install Gyan.FFmpeg
```

Then **restart your PC** (or sign out and back in) to apply the PATH change.

> `winget` is built into Windows 10 (1809+) and Windows 11. If it's not available, [download winget here](https://aka.ms/getwinget).

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
