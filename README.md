# vidcord

This is a simple Python GUI application for compressing video files under Discord's size limits using FFmpeg. The application allows users to drag and drop video files or open them via a file dialog, and convert them to either a low or high-quality preset for free and Nitro users.

## Features

- Drag and drop video files for easy conversion.
- Right click video files in the File Explorer and select vidcord.
- Select between two quality options:
  - Low quality (free users): 25MB target size, 480p resolution.
  - High quality (Nitro users): 50MB target size, 720p resolution.
- Copies the path of the converted file to the clipboard.

## Building

1. **Install Python**
   - Download and install Python from [Python official website](https://www.python.org/downloads/).

1. **Install FFmpeg**:
   - Download and install FFmpeg from [FFmpeg official website](https://ffmpeg.org/download.html).

2. **Install Python dependencies**:
   ```sh
   pip install PyQt5
   ```

3. **Run the application**:
   ```sh
   python vidcord.py
   ```

## Usage

- Either drag and drop a video file into the application window, or click the button to open a file dialog and select a video file.
- Choose the desired quality (Low or High) from the dropdown menu.
- The conversion will start automatically, and the converted file path will be copied to the clipboard upon completion.

## Acknowledgements

- Thanks to the [FFmpeg](https://ffmpeg.org/) team for their powerful media processing tools.
- PyQt5 for providing the GUI framework.
