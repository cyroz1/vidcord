# vidcord

This is a simple Python GUI application for compressing video files under Discord's size limits using FFmpeg and PyQt5. The application allows users to drag and drop video files or open them via a file dialog, and convert them to either a low or high-quality preset for free and Nitro users.

## Download

See [latest release](https://github.com/cyroz1/vidcord/releases/latest) to download and install.

## Features

- Two methods to import videos:
  - Drag and drop or browse for video files to import.
  - Right click .mp4 files in File Explorer and choose "Compress with vidcord".
- Select between two quality options:
  - Low quality (free users): 25MB target size, 480p resolution.
  - High quality (Nitro users): 50MB target size, 720p resolution.
- Chose between common hardware and software encoders.
- Set the starting and ending point of the output clip in seconds.
- Highlights converted file in its output path in File Explorer.

## Screenshots

### Main program window

![Main program window](screenshots/main%20window.png)
### File imported

![File imported](screenshots/file%20imported.png)
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

- Thanks to the [FFmpeg](https://ffmpeg.org/) team for their powerful media processing tools.
- PyQt5 for providing the GUI framework.
