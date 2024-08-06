# vidcord

This is a simple Python GUI application for compressing video files under Discord's size limits using FFmpeg and PyQt5. The application allows users to drag and drop video files or open them via a file dialog, and convert them to either a low or high-quality preset for free and Nitro users.

## Download

See [releases](https://github.com/cyroz1/vidcord/releases) for the latest binaries for your system.

## Features

- Drag and drop or browse video files for easy conversion.
- Select between two quality options:
  - Low quality (free users): 25MB target size, 480p resolution.
  - High quality (Nitro users): 50MB target size, 720p resolution.
- Highlights converted file in its output path in File Explorer.

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

## Usage

- Either drag and drop a video file into the application window, or click the button to open a file dialog and select a video file.
- Choose the desired quality (Low or High) from the dropdown menu.
- The conversion will start automatically, and the converted file path will be highlighted in the File Explorer upon completion.

## Acknowledgements

- Thanks to the [FFmpeg](https://ffmpeg.org/) team for their powerful media processing tools.
- PyQt5 for providing the GUI framework.
