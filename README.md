# vidcord

This is a simple Python GUI application for compressing video files under Discord's size limits using FFmpeg. The application allows users to drag and drop video files or open them via a file dialog, and convert them to either a low or high-quality preset for free and Nitro users.

## Features

- Drag and drop video files for easy conversion.
- Select between two quality options:
  - Low quality (free users): 25MB target size, 480p resolution.
  - High quality (Nitro users): 50MB target size, 720p resolution.
- Copies the path of the converted file to the clipboard.

## Prerequisites

- Python 3.x
- FFmpeg
- PyQt5

## Building

1. **Install FFmpeg**:
   - Download and install FFmpeg from [FFmpeg official website](https://ffmpeg.org/download.html).

2. **Install Python dependencies**:
   ```sh
   pip install PyQt5
   ```

## Usage

1. **Run the application**:
   ```sh
   python vidcord.py
   ```

2. **Convert a video**:
   - Drag and drop a video file into the application window, or click the button to open a file dialog and select a video file.
   - Choose the desired quality (Low or High) from the dropdown menu.
   - The conversion will start automatically, and the converted file path will be copied to the clipboard upon completion.

## Notes

- Ensure FFmpeg is installed and accessible in your system's PATH.
- The application sets the target bitrate based on the desired file size and video duration.

## Acknowledgements

- Thanks to the [FFmpeg](https://ffmpeg.org/) team for their powerful media processing tools.
- PyQt5 for providing the GUI framework.
