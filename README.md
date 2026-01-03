# <img src="icon.ico" height="25"> vidcord  

This is a simple and fast Python GUI application for compressing video files under Discord's size limits using FFmpeg and PyQt6 in one-click. The application features a modern **Fluent Design** interface, and is available for **Windows, macOS, and Linux**.

## Download

[Download latest release installer.](https://github.com/cyroz1/vidcord/releases/latest)

## Features

- **Modern UI**: Clean and responsive interface built with Fluent Design.
- **Three methods to import videos**:
  - File Explorer: Right click video files in File Explorer and choose "Compress with vidcord". (Windows only)
  - Finder: Right click video files in Finder and choose "Open with..." -> "vidcord.app". (macOS only)
  - Manual: Drag and drop or browse for video files in the application. 
- **Five quality presets**:
  - 10MB, 480p (Free users)
  - 25MB, 480p (Free users, old)
  - 50MB, 720p (Nitro Basic or Level 2 Server Boost)
  - 100MB, 1080p (Level 3 Server Boost or [Clips Bypass](https://github.com/riolubruh/YABDP4Nitro?tab=readme-ov-file#clips))
  - 500MB, Native (Nitro Full)
- **Advanced Options**:
  - **Remove Audio**: Strip audio tracks to save space or for silent clips.
  - **Trimming**: Adjustable starting and ending points with live preview.
- **Hardware Acceleration**: Support for NVIDIA (NVENC), AMD (AMF), Intel (QSV), and Apple Silicon encoders.
- **Instant Startup**: Optimized with lazy-loading and background hardware detection for immediate responsiveness.
- **Multi-Platform**: Native builds for Windows (.exe), macOS (.pkg), and Linux (.AppImage).
- **Progress Tracking**: Real-time progress bar and ETA display.

## Screenshots

### Program window

![Program window](screenshots/window.png)

### Output file example

![Output file example](screenshots/file.png)
### Context menu integration

![Context menu integration](screenshots/context.png)
![Finder context menu integration](screenshots/finder.png)

## Building

1. **Install Prerequisites**
   - Download and install [Python 3.10+](https://www.python.org/downloads/).
   - **macOS**: Ensure Xcode Command Line Tools are installed (`xcode-select --install`).

2. **Setup Environment & Dependencies**
   It's recommended to use a virtual environment:
   ```sh
   # Create and activate venv
   python -m venv venv
   source venv/bin/activate  # macOS/Linux
   venv\Scripts\activate     # Windows

   # Install dependencies
   pip install -r requirements.txt
   pip install pyinstaller
   ```

3. **Build the Application**
   A unified build script handles platform-specific packaging (using PyInstaller, Inno Setup, or AppImage tools):
   ```sh
   python build.py
   ```
   The resulting installer/package will be located in the `dist/` directory.

## Acknowledgements

- [FFmpeg](https://ffmpeg.org/)
- [PyQt6](https://pypi.org/project/PyQt6/)
- [PyQt6-Fluent-Widgets](https://github.com/zhiyiYo/PyQt-Fluent-Widgets)
- [PyInstaller](https://www.pyinstaller.org/)
