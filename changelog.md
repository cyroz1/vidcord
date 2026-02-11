# Changelog

## v5.7 — Code Quality & Reliability Overhaul

### Bug Fixes
- **Fixed FFmpeg command argument ordering** — audio flags (`-an` / `-c:a aac`) are now correctly placed before the output file, preventing undefined behavior with certain FFmpeg versions
- **Fixed video upscaling** — selecting a resolution preset higher than the source (e.g. "1080p" on a 480p video) no longer upscales; the original resolution is preserved
- **Removed dead/orphaned code** — deleted unreachable `get()` method and stale comments

### Reliability Improvements
- **Cancel cleanup** — cancelling a compression now deletes the partial output file instead of leaving a broken `.mp4` in Downloads
- **Atomic settings write** — settings are now written to a temp file first and atomically renamed, preventing corruption if the app crashes mid-write
- **Safe exception handling** — all bare `except:` clauses replaced with `except Exception:` to avoid swallowing `SystemExit` and `KeyboardInterrupt`
- **Log file cleanup** — log file handle is now properly closed on exit via `atexit`

### Performance
- **VAAPI device caching** — the VAAPI render node probe result is now cached, avoiding repeated FFmpeg subprocess calls on Linux
- **FFmpeg path setup caching** — `setup_ffmpeg_path()` now skips redundant filesystem scans after first successful run
- **Startup logging fix** — debug environment prints now run after logging is initialized, so they appear in the log file instead of the console

### Code Quality
- **Quality presets refactored** — magic string matching replaced with a `QUALITY_PRESETS` data structure for a single source of truth
- **Platform constants** — extracted `_CREATION_FLAGS` module-level constant, eliminating repeated platform checks
- **Shared temp directory** — extracted `_get_temp_dir()` utility, removing 3 duplicated blocks
- **Import cleanup** — removed unused `shlex` import, moved `re` to top-level imports
- **VideoProcessor class** — removed pointless instantiation (all methods are static)
