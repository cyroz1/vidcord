# Changelog

## WIP

### Preview

- **Sharper preview frames and filmstrips**: trim previews now request images sized to the rendered preview pane, including HiDPI displays, instead of using fixed low-resolution thumbnails.
- **More reliable preview decoding**: preview frames and filmstrips try FFmpeg hardware decode first and automatically retry with software decode when hardware acceleration fails.
- **Faster long-video filmstrips**: videos over 10 minutes now use sparse frame seeks and lower frame counts so loading long clips does less upfront thumbnail work.
- **Hardware-accelerated preview clips**: generated scrub preview clips now try platform H.264 hardware encoders where available before falling back to `libx264`.
- **More accurate preview playback**: trim playback now starts from the current playhead when it is inside the selected range, stops at the trim out point more precisely, and loops correctly even when the selected range reaches the source video's end.
- **Full-range fallback preview clips**: generated fallback preview clips now cover the selected trim range instead of being capped to the first 12 seconds.

### UI

- **Compact fixed window**: the main window is now fixed at 460×690, and saved window state restores position only so stale dimensions cannot leave extra blank space or reintroduce scrollbars.
- **Tighter settings layout**: target, FPS, and encoder controls now use fixed-width sizing where needed so the standard and advanced rows fit cleanly in the compact window.

### Internal

- Preview frame cache keys now include requested output dimensions, and preview clip cache keys include the source file path to avoid stale preview reuse across files or display sizes.

## v6.5

### Compression

- **Output FPS controls**: standard mode can leave frame rate unchanged or cap output at 24, 30, or 60 FPS, with options above the source frame rate hidden. Advanced mode accepts a custom FPS value or an empty field shown as Off for no change.
- **Updated output metadata**: compressed video comments now point to `vidcord.app`.

### UI

- **Compact H.265 warning**: the H.265 compatibility warning now appears behind a hover/focus warning icon instead of taking up space as inline text.

### Documentation

- Updated the README, website copy, structured data, and AI grounding files for the new FPS controls.

---

## v6.4

### Compression

- **Strict target-size verification**: finished outputs are measured against the selected size limit. Oversized results are removed and retried automatically.
- **Smarter retry order**: if the first attempt misses the target, vidcord now tries `libx264` CPU encoding at the original bitrate before stepping down through 80%, 70%, and lower safety levels with the original encoder and CPU fallback.
- **Clearer progress and results**: progress now shows the current attempt number, encoder, bitrate, and ETA. Success reports the final output size; failure reports the smallest oversized result.

### Encoders

- **Advanced encoder autocomplete**: replaced the browser datalist with a keyboard-friendly menu that filters installed encoders, keeps inline completion, and avoids horizontal overflow in the fixed-size window.
- **H.265 grouping**: normal-mode encoder choices now group H.264 and H.265 options separately, with a compatibility warning when an HEVC encoder is selected.

### Preview

- Fixed preview race conditions so stale frame loads are ignored when switching files or scrubbing quickly.

### Build

- Tightened TypeScript and CI configuration for cleaner release checks.
- Updated frontend and Rust transitive dependencies to clear release audit advisories.

---

## v6.3

### Encoders

- **H.265 / HEVC support**: `libx265` (CPU) and the hardware variants `hevc_nvenc`, `hevc_amf`, `hevc_qsv`, `hevc_vaapi`, and `hevc_videotoolbox` now appear directly in the normal-mode encoder dropdown. Hardware encoders are gated on the same vendor / VAAPI-device detection as their H.264 counterparts and are only listed when the installed FFmpeg actually exposes them.

### Visual

- **Dropdown readability on Windows**: option lists in the encoder, target, snap, and resolution dropdowns now render with an explicit opaque background and text colour. The native popup ignores `backdrop-filter`, so on Windows the transparent select previously fell back to system colours and rendered options as white-on-white.
- **Solid window background**: `--bg` is now fully opaque and the body no longer carries a transparent background, eliminating desktop bleed-through after the v6.2 transparency fix.

### Update checker

- The 6-hour throttle now advances on update-check failure as well as success, so a transient network error no longer causes every subsequent app launch to refire the request immediately.
- Banner dismissal persists across launches: dismissing the "Version X available" banner skips it until a newer release appears.
- Update-check failures are routed through the rotating log so opaque "no banner" reports are diagnosable.
- The GitHub API request now includes `CARGO_PKG_VERSION` in its User-Agent.

### Documentation

- Rewrote `README.md` to production standards: badges, table of contents, hero screenshot, feature list grouped by capability, per-platform install table, FFmpeg setup, usage walkthrough, keyboard shortcuts, hardware-encoder matrix, build-from-source and CI notes, troubleshooting, and contributing guidelines.
- README also tuned for search and LLM retrieval: keyword-rich H1, "At a glance" facts block, supported-input-formats list, FAQ section, and descriptive screenshot alt text.
- Added MIT license at the repo root with a corresponding README section noting that FFmpeg remains a separate system dependency under its own terms.

---

## v6.2

### Trim UX improvements

- **Draggable playhead**: the playhead can now be grabbed and dragged directly on the timeline in addition to click-to-seek.
- **Free-roam playhead**: playhead is no longer clamped to the trim range — it moves freely across the full clip duration, matching Premiere Pro's model. Trim handles define the export region only.
- **I / O shortcuts**: press `I` or `O` to stamp the trim start or end handle to the current playhead position; dedicated In / Out buttons flank the time labels for mouse users.
- **Shortcuts panel**: press `?` to open a full cheat-sheet of every keybinding; `Esc` or backdrop-click dismisses.
- Fixed ref-staleness bug where rapid undo/redo and pointer drags could read stale `startTime` / `endTime` values during scrubbing.

### Visual

- Removed `backdrop-filter` blur / saturation from the app window (`#root`). The liquid-glass Mica effect has been stripped; the window now renders with a solid background.

---

## v6.1

### macOS Tahoe Liquid Glass UI

- Restyled the entire interface to match the macOS Tahoe liquid glass design language: semi-transparent surfaces with `backdrop-filter` blur + saturation, white glass-edge borders, inset top-highlight, and layered shadows.
- Window is now transparent so the OS desktop wallpaper shows through the frosted glass shell.
- Accent color updated to macOS blue (`#0A84FF` dark / `#007AFF` light); font switched to `-apple-system / SF Pro Text`.
- Larger border radii (12 / 8 / 6 px) throughout; toggle switches match the macOS pill style.
- Compress button gets a gradient blue fill with ambient glow; cancel state gets a red-tinted glass treatment.
- Video preview container, overlay play/stop buttons, time badges, and toast notifications all carry the glass `backdrop-filter` treatment.

### Trim UX overhaul

- **Scrubbing**: click or drag anywhere on the timeline to move the playhead; click inside the selected range without dragging seeks rather than no-ops.
- **Persistent playhead**: playhead is visible whenever a video is loaded, not only during playback. Resuming picks up from the last scrubbed position.
- **Handle polish**: handles bumped to 18 px with hover/active scale-up and accent glow on the focused handle. Double-click a handle to snap it to 0 % / 100 %.
- **Floating time chip**: a live timestamp floats above the handle being dragged.
- **In / Out buttons**: next to the time labels; work whether playing or paused since I / O operate on the persistent playhead.
- **Snap tick marks**: render on the track when snap is active; auto-hide when the view is too dense to be useful.
- **Minimap**: appears above the main timeline when zoomed in — shows the full video with trim range, viewport window, and playhead. Click or drag to pan.
- **Shortcuts overlay**: press `?` or click the footer button to open a cheat-sheet of every keybinding; `Esc` or backdrop-click dismisses.
- Timeline zoom up to 20×; Shift + `,` / `.` nudges the active handle by one frame.

### Keyboard shortcuts (new / expanded)

| Key | Action |
|-----|--------|
| `Space` | Toggle play / stop |
| `,` / `.` | Step one frame backward / forward |
| `J` / `K` | Jump playhead to trim start / end |
| `[` / `]` | Nudge trim start / end |
| `I` / `O` | Set trim in / out to current playhead |
| `Shift + Arrow` | Fine-nudge active handle by one frame |
| `R` | Reset trim to full duration |
| `?` | Open shortcuts overlay |

### Performance

- **Filmstrip pre-generation**: on file load a single FFmpeg pass extracts ~60 evenly-spaced JPEG frames. Scrubbing shows the nearest filmstrip frame instantly (0 ms) instead of spawning a new FFmpeg process per seek; the exact frame is fetched as a refinement after 80 ms.
- **Frame cache**: 20-entry LRU cache in the backend so scrubbing back over recently-seen positions returns immediately.
- **Hardware decode for previews**: `-hwaccel auto` added to single-frame extraction and filmstrip generation, activating VideoToolbox / DXVA2 / VAAPI where available.
- **Encoder presets**: encoder-specific `-preset` flags now set at compression time (`libx264/libx265 → fast`, `nvenc → p4/hq`, `qsv → veryfast`, `amf → quality=speed`). Previously the backend used encoder defaults (medium / slow), which was slower than necessary at a fixed target bitrate.
- **Encoder detection cache**: `get_available_encoders()` is now memoised behind a `Mutex<Option<Vec>>`. Skips re-running `ffmpeg -encoders` on every call; invalidated automatically after a successful FFmpeg install.
- **Playhead polling eliminated**: replaced the 80 ms `setInterval` poll with a `PreviewPane → onTimeUpdate` callback driven by the media element's native `timeupdate` event, stopping the main thread from waking ~12.5× / s while paused.
- **IPC parallelism**: `resolve_output_path` and `get_vaapi_device` now run in `Promise.all` on compression start, saving one round-trip.
- **Probe caching**: FFmpeg probe results are cached per file path to avoid redundant re-probes.
- **Window state persistence**: window position and size are restored between launches via `tauri-plugin-window-state`.

### Dependencies

- `rustls-webpki` bumped; Tauri-upstream advisories added to audit ignore list.

---

## v6.0

vidcord has been fully rewritten from Python + PyQt6 to **Tauri (Rust + React)**. This is a ground-up rebuild — not an incremental update.

### Core changes

- **New runtime**: Replaced PyInstaller + Python with a native Tauri binary. No Python interpreter, no PyQt6, no bundled runtime.
- **Smaller installer**: ~10 MB vs ~80 MB — Tauri uses the OS WebView (Edge on Windows, WebKit on macOS/Linux) instead of bundling one.
- **Faster startup**: Near-instant launch; hardware detection and settings load happen in the background.
- **Rust backend**: All FFmpeg orchestration, file I/O, GPU detection, settings, and update checking are now in Rust.
- **React frontend**: UI rebuilt in React + TypeScript with a Fluent Design stylesheet.

### New features

- **Video playback preview**: Play the trimmed segment in-app before compressing (Windows + macOS; disabled on Linux due to WebKit limitations).
- **Linux VAAPI hardware acceleration**: Added `h264_vaapi` encoder support alongside NVIDIA, AMD, Intel, and Apple Silicon.
- **Apple Silicon VideoToolbox**: Native `h264_videotoolbox` encoder on M-series Macs.
- **ARM64 support**: New aarch64 installers for Windows (NSIS) and Linux (AppImage); macOS ships as a universal binary.
- **Single-instance enforcement**: Opening a second instance forwards the file to the existing window instead of launching a duplicate.
- **Settings persistence**: Remove Audio, advanced mode values, and encoder selection are saved across sessions.
- **Auto-increment output**: Output is saved to `Downloads/<name>-vidcord.mp4`; if that name is taken, `-1`, `-2`, etc. are appended instead of overwriting.
- **Trim frame preview**: Live thumbnail updates as you drag the trim sliders.
- **File associations**: `.mp4`, `.avi`, `.mov`, `.mkv`, `.flv`, `.wmv`, and `.webm` registered with the OS so "Open with vidcord" works from Explorer/Finder.
- **Update checker**: Background GitHub release check with proper semver comparison, respecting a user-configurable cadence.
- **Error boundary & toasts**: Frontend crashes surface as a recoverable error instead of a blank window, and notifications use a non-blocking toast system.

### Installers

- **Windows**: NSIS installer (x86_64 + aarch64), replacing the previous Inno Setup script.
- **macOS**: Universal `.dmg` containing both aarch64 and x86_64 slices.
- **Linux**: `.AppImage` for x86_64 and aarch64.

### Platform fixes

- **Windows**: `CREATE_NO_WINDOW` on every FFmpeg/probe invocation (no console flash); fixed WebView2 `AbortError` on seek; `explorer /select` handles paths with spaces and the `\\?\` extended-length prefix.
- **macOS**: Fixed "Open With" cold-launch race condition; Apple Events file delivery via `RunEvent::Opened`; installer hard-locked to `/Applications`.
- **Linux**: Fixed GStreamer/GIO module errors in the AppImage; KDE Plasma white-window rendering; LXQt/minimal-WM startup; Wayland + X11 compatibility.

### Removed

- Python source (`vidcord.py`), `requirements.txt`, PyInstaller specs, and all legacy build scripts.
- Old Linux platform scripts (`build_appimage.sh`, Debian/Fedora/Arch packaging).
- `verify_bitrate.py`, `benchmark_startup.py`, `debug_encoders.py`, and other `tools/` debug scripts.
