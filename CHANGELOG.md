# Changelog

## v5.4 (2026-01-13)

### Bug Fixes
- **Linux Hardware Acceleration**: Fixed an issue where `h264_vaapi` and other hardware encoders were not correctly detected on Linux.
- **Robust Encoder Detection**: Improved the encoder detection mechanism to be more robust across different FFmpeg versions and environments.

### Features
- **Expanded Linux Support**: Enabled NVIDIA (`nvenc`), AMD (`amf`), and Intel (`qsv`) encoder support on Linux when compatible hardware is detected.

## v5.3 (2026-01-13)

### Features
- **Dynamic Versioning**: Automated version extraction from `vidcord.py` for Windows build artifacts, ensuring consistency between application version and installer filename.
- **Multi-Platform Consistency**: Synchronized versioning across all platform-specific configurations (Inno Setup, macOS PKG, Arch PKGBUILD, Debian Control, and Fedora Spec).

### CI/CD & Automation
- **Workflow Optimization**: Updated GitHub Actions to dynamically pass the version string to Inno Setup compiler.

### Bug Fixes
- Fixed issue where Windows installer filenames had incorrect or hardcoded version numbers.

## v5.2 (2025-12-20)