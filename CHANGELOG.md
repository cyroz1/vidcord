# Changelog
All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-02-10
### Added
- Preview playback of the selected trim region with audio and play/stop overlay controls.
- Liquid glass-style playback controls with custom white icons.
- Cross-platform preview playback fallback using `QVideoSink` with `QVideoWidget` fallback.
- GitHub release update check with in-app notification when a newer version is available.

### Changed
- Hover detection now respects the preview content bounds and avoids letterbox overflow.
- Preview playback now waits for media to load before seeking to the trim start.

### Fixed
- `build.py` now defines `main()` and runs correctly.
- Preview playback aspect ratio and corner radius alignment.
