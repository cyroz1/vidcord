# vidcord

This is a simple Python GUI application for compressing video files under Discord's size limits using FFmpeg and PyQt5. The application allows users to either right click videos in the File Explorer, drag and drop video files, or import them via a file dialog. Users can then choose starting and ending times, and compress the imported video with four quality presets for different Nitro and server boost levels.

## Download

See [latest release](https://github.com/cyroz1/vidcord/releases/latest) to download and install.

## Features

- Two methods to import videos:
  - Drag and drop or browse for video files to import.
  - Right click .mp4 files in File Explorer and choose "Compress with vidcord".
- Select between four quality presets:
  - 25MB, 480p (Free users)
  - 50MB, 720p (Nitro Basic or Level 2 Boost)
  - 100MB, 1080p (Level 3 Boost)
  - 500MB, native res (Nitro)
- Chose between common hardware and software encoders.
- Set the starting and ending point of the output clip in seconds.
- Progress bar and ETA are displayed during encoding.
- Highlights compressed file in its output path in File Explorer.

## Screenshots

### Main program window

![Main program window](screenshots/main%20window.png)
### File compressed

![File imported](screenshots/file%20compressed.png)
### Output file example

![Output file example](screenshots/output%20file%20example.png)
### Context menu integration

![Context menu integration](screenshots/context%20menu.png)

## Building

1. **Install Python**
   - Download and install Python from [Python official website](https://www.python.org/downloads/).

2. **Install Python dependencies**:
   ```sh
   pip install PyQt5
   pip install ffmpeg-python
   ```

3. **Run the application**:
   ```sh
   python vidcord.py
   ```

## Acknowledgements

- [FFmpeg](https://ffmpeg.org/)
- [PyQt5](https://pypi.org/project/PyQt5/)
- [PyInstaller](https://www.pyinstaller.org/)
- [Inno Setup](https://jrsoftware.org/isinfo.php)
