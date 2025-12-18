# <img src="icon.ico" height="25"> vidcord  

This is a high-performance Python GUI application for compressing video files under Discord's size limits using FFmpeg and PyQt6. The application features a modern **Fluent Design** interface, **instant-start architecture**, and is available for **Windows, macOS, and Linux**.

## Download

[Download latest release installer.](https://github.com/cyroz1/vidcord/releases/latest)

## Features

- **Modern UI**: Clean and responsive interface built with Fluent Design.
- **Two methods to import videos**:
  - File Explorer: Right click video files in File Explorer and choose "Compress with vidcord". (Windows only)
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

## Building

1. **Install Python and FFmpeg**
   - Download and install [Python](https://www.python.org/downloads/).
   - Download and install [FFmpeg](https://www.ffmpeg.org/download.html).

2. **Install Python dependencies**:
   ```sh
   pip install ffmpeg-python
   pip install PyQt6
   pip install requests
   pip install PyQt6-Fluent-Widgets
   pip install packaging
   ```

3. **Build the application**:
   A unified build script is provided for easy packaging:
   ```sh
   python build.py
   ```
   This will automatically detect your OS and generate the appropriate installer/package in the `dist/` directory.

4. **Run the source directly**:
   ```sh
   python vidcord.py
   ```

## Acknowledgements

- [FFmpeg](https://ffmpeg.org/)
- [PyQt6](https://pypi.org/project/PyQt6/)
- [PyQt6-Fluent-Widgets](https://github.com/zhiyiYo/PyQt-Fluent-Widgets)
- [PyInstaller](https://www.pyinstaller.org/)
- [Inno Setup](https://jrsoftware.org/isinfo.php)
