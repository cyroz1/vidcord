# Changelog

## v5.3 (2026-01-13)

### Features
- **Dynamic Versioning**: Automated version extraction from `vidcord.py` for Windows build artifacts, ensuring consistency between application version and installer filename.
- **Multi-Platform Consistency**: Synchronized versioning across all platform-specific configurations (Inno Setup, macOS PKG, Arch PKGBUILD, Debian Control, and Fedora Spec).

### CI/CD & Automation
- **Workflow Optimization**: Updated GitHub Actions to dynamically pass the version string to Inno Setup compiler.

### Bug Fixes
- Fixed issue where Windows installer filenames had incorrect or hardcoded version numbers.
- Fixed Linux hardware acceleration.
- Fixed context menu integration on macOS.
- Fixed build scripts on local environment.