# vidcord

This is a simple Python GUI application for compressing video files under Discord's size limits using FFmpeg and PyQt5. The application allows users to either right click videos in the File Explorer, drag and drop video files, or import them via a file dialog. Users can then adjust starting and ending times, and compress the imported video with either hardware or software encoding and five quality presets for different Nitro and server boost levels.

## Download

See [latest release](https://github.com/cyroz1/vidcord/releases/latest) to download and install.

## Features

- Two methods to import videos:
  - File Explorer: Right click .mp4 files in File Explorer and choose "Compress with vidcord".
  - Manual: Drag and drop or browse for video files in the application.
- Five quality presets:
  - 10MB, 480p (Free users)
  - 25MB, 480p (Free users)
  - 50MB, 720p (Nitro Basic or Level 2 Boost)
  - 100MB, 1080p (Level 3 Boost)
  - 500MB, Native (Nitro)
- Software and hardware encoders.
- Adjustable starting and ending points of the output video with sliders and a live preview.
- Progress bar and ETA are displayed during encoding.
- Compressed file is revealed in its output path in File Explorer.

## Screenshots

### Program window

![Program window](screenshots/window.png)

### Output file example

![Output file example](screenshots/file.png)
### Context menu integration

![Context menu integration](screenshots/context.png)

## Building

1. **Install Python**
   - Download and install [Python](https://www.python.org/downloads/).
   - Download and install [FFmpeg](https://www.ffmpeg.org/download.html).

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
