# Changelog

## v7.1

### Performance

- Reduced redundant CI work by deduplicating branch and pull-request runs for the same commit, reusing CI-profile Rust artifacts, and reserving installer packaging for release tags and explicit manual builds.

## v7.0

### Features & Audio

- **EBU R128 Loudness Normalization**: Added optional audio loudness normalization (`-af loudnorm=I=-14:TP=0.0:LRA=11`) targeting a 0 dB True Peak limit to eliminate quiet audio without clipping or distortion.
- **Smart Multi-Track Audio Selection**: Automatically detects multi-track audio recordings (such as OBS or ShadowPlay multi-stream MP4s) and extracts/encodes only the primary audio stream with the most data, preferring the first stream on ties and reliably falling back to that first stream if discovery fails.
- **Aspect Ratio Cropping Presets**: Added aspect ratio crop options (`16:9`, `1:1` Square, `9:16` Vertical/Shorts, `4:3` Standard, `3:4`, `4:5`, `5:4`) prepended ahead of scaling filters in FFmpeg's video pipeline.
- **Native Aspect Ratio Detection & Filtering**: Detects the input video's native display aspect ratio and dynamically excludes matching crop presets from the selector dropdown to avoid redundant crop operations (e.g. excluding 16:9 for a 1920×1080 clip).
- **Frame Snapshots**: Added a 📷 **Snapshot** overlay button and `Cmd+Shift+S` / `Ctrl+Shift+S` global keyboard shortcut to extract full-resolution PNG frames at any playback position.
- **Integrated Snapshot Output Workflow**: Frame snapshot saving respects the user's configured output destination (Downloads, source clip folder, custom directory, or save prompt) and completion action (copies saved PNG to clipboard with reveal fallback, or reveals in file explorer).

### Integration

- **OS Taskbar & Dock Progress Bar**: Real-time encoding progress is now reflected on the OS taskbar/dock app icon (macOS Dock, Windows Taskbar button, Linux Unity launcher bar) so you can monitor compression progress while unfocused.
- **Native System Notifications**: Every in-app banner and error is mirrored in order as a matching desktop notification while vidcord is unfocused, using delivery paths that report failures consistently on Windows, macOS, and Linux. Clicking a notification now restores and focuses the vidcord window on every platform, and macOS builds now carry the stable app identity required for Notification Center authorization.
- Increased in-app banner opacity so notification text stays legible over the controls behind it.

### Performance

- Made GIF sizing progressive, kept Linux GPU discovery off the cold-import path, validated hardware encoders before first-run auto-selection, and remembered failed preview hardware-decode paths.
- Bounded compression cancellation and desktop helper processes, capped preview-frame cache memory by bytes, and invalidated generated preview clips when a same-path source is re-imported.
- Isolated high-frequency playhead movement from full-app React renders, preserved toast memoization, removed redundant FFmpeg setup probes, and started website release requests concurrently with platform detection.
- Removed unnecessary backdrop filters from opaque app controls and aligned the direct `dirs` dependency with Tauri's runtime version.
- Deferred cold encoder and GPU discovery until the interface is idle, while immediately restoring the last detected encoder capabilities.
- Encoder discovery now waits for a quiet startup/import window, and superseded FFmpeg preview-frame requests are terminated so the newest scrub position is not blocked behind stale work.
- Avoided redundant live-video seeks during playhead dragging and skipped expensive filmstrip generation when native preview seeking is available.
- New installs prefer an available H.264 hardware encoder, while saved encoder choices remain unchanged and failed hardware decode or encode paths fall back automatically.
- Long encodes run below normal process priority to keep the app and desktop responsive, and GIF exports use a short sizing sample to avoid unnecessary full-size retry passes.
- File imports cancel superseded FFprobe processes and cap metadata analysis at six seconds instead of leaving stale probes active.
- Ask-when-done saves use a same-filesystem hard-link publish path when possible, avoiding a second full output copy while retaining the safe copy fallback.
- Fixed Windows ask-when-done publishing so hard-linked output files can complete their durability sync instead of failing with an access-denied error.

### Preview

- FFmpeg filmstrips now start only after the first exact frame, decode keyframes into fewer lower-resolution thumbnails, and remain available as a fallback on Linux or when native preview loading fails.
- Preview frame, filmstrip, and fallback-clip jobs now enforce time and output-size limits instead of waiting indefinitely on a stalled FFmpeg process.
- Failed or stopped preview playback now preserves the current scrub position, while generated fallback clips remain autoplay-safe on WebKit instead of briefly starting and stopping.
- Replaying a preview after it reaches the trim end now restarts from the trim start instead of resuming at the out point.
- Long Linux filmstrips use eight representative frames, and fallback playback keeps only the latest generated clip in the webview to reduce FFmpeg work and memory copying.

### UI

- **Single Horizontal Line Advanced Controls**: Layout Advanced Mode controls (`Size`, `Resolution`, `Crop`, `FPS`, `Encoder`, `Mute`, `Norm`, `Info`) into a clean 5-column single horizontal row.
- **Icon-Only Audio Controls**: Updated `Mute` and `Norm` controls to compact 28px square icon-only SVG buttons with tooltips and accessible aria-labels.
- **Maxed-Out Active Waveform Icon**: The active audio normalization button displays a full-amplitude 5-bar waveform icon when enabled.
- **Memoized Controls Render Pipeline**: Added `audioNormalize`, `cropAspectRatio`, and dynamic `cropOptions` to `MemoizedSubtree` dependencies so control state updates instantly without re-rendering the trim timeline.
- Video imports now show an explicit “Reading video…” state, and missing FFmpeg uses the non-blocking in-app setup banner instead of an automatic system confirmation dialog.
- Trim controls use a tighter segmented layout and compositor-driven range/playhead motion to reduce layout work inside the glass timeline card. Unchanged import and settings controls are also skipped during trim-only renders.
- The timeline playhead now follows an actively moved trim handle in both directions instead of retaining a stale position when the handle reverses.
- Reduced glass-filter compositor cost, honored reduced-transparency settings across every glass control, and removed duplicate taskbar-progress and desktop-notification updates.

## v6.9

### Setup

- **Reliable Windows FFmpeg detection**: vidcord now recognizes WinGet's FFmpeg aliases and package directory immediately after installation, even before the running app receives an updated PATH, and no longer reports a successful setup when either `ffmpeg` or `ffprobe` is still unavailable.

### UI

- **Discord-ready GIF exports**: a bottom-right GIF Mode switches the app to focused 10 MB Free and 50 MB Nitro Basic targets with selectable 15, 30, or Discord-safe maximum 50 FPS, removes unrelated video controls, and creates optimized animated GIF files with automatic size retries that preserve the chosen frame rate.
- **Long-video timeline controls**: the trim timeline can now show hours, minutes, and seconds, and its zoom range extends from 20× to 100× for more precise edits in long videos.
- **Direct trim-time entry**: Advanced Mode turns the timeline's start and end labels into editable fields that accept seconds or hours, minutes, and seconds.

### Compression

- **Source-bitrate exports**: leaving the Advanced mode size field empty now encodes at the source video's bitrate without enforcing a target file size.

### Website

- Refreshed the main and Advanced mode screenshots and added a dedicated GIF Mode showcase.

## v6.8

### UI

- **Less intrusive playback controls**: Stop now appears only while hovering the preview during playback instead of remaining visible after Play retains focus.
- **Contained playback previews**: live video playback now stays clipped to the preview instead of painting artifacts over nearby output controls.
- **Clearer compression results**: successful compression messages now show the percentage reduction from the original file size without repeating the selected target size.
- **Richer import details**: imported videos now show source resolution, frame rate, codec, average bitrate, and length in a compact one-line summary, while the preview uses a single playhead-over-duration readout.
- **System-matched macOS title bar**: the native title bar now follows the current macOS Light or Dark appearance instead of remaining white in Dark Mode.
- **Flexible output completion**: compact, always-visible settings-style controls above Compress let you choose Downloads, the imported clip's folder, a remembered custom folder, or an after-compression save prompt. Completed files are copied to the system clipboard by default, with a reveal fallback if copying fails, or can always be revealed instead.
- **Feature idea credit**: output destination and completion action ideas were suggested by [wvbzy](https://github.com/wvbzy) ([WubzyFN on X](https://x.com/WubzyFN)).
- **Reliable folder selection**: custom output folders now open through the already-loaded native dialog API instead of failing when a deferred module cannot be fetched.

## v6.7

### Updates

- **In-app update installer prompt**: update notices can now download the matching installer for the current platform to Downloads and open it directly, with a release-page fallback.
- **Safer update downloads**: update installers are streamed asynchronously to disk with size, completeness, and GitHub-published SHA-256 integrity checks, then published under a collision-safe filename without replacing an existing Downloads file, including on FAT, exFAT, and network filesystems without hard-link support.
- **Less intrusive update checks**: automatic GitHub release checks now wait until startup work has settled instead of competing with initial file loading and encoder detection.

### Compression

- **Race-free cancellation**: cancelling an encode now keeps the app in a cancelling state until FFmpeg exits, prevents overlapping compression jobs, and keeps stale cleanup from affecting a newer job.
- **Faster size correction**: strict-size compression now caps adaptive work at four full attempts for hardware encoders and two for CPU encoding, giving both the selected encoder and CPU fallback one measured bitrate correction instead of retrying as many as six times.
- **More resilient encoding**: hardware failures fall back to CPU even without a target-size retry, invalid command options are rejected early, malformed FFmpeg output is memory-bounded, and failed jobs are killed, reaped, and cleaned up consistently.
- **Collision-safe output files**: output names are atomically reserved before FFmpeg starts and remain owned across adaptive retries, preventing a late Downloads-file collision from being overwritten.

### Preview

- **Faster startup and file import**: encoder discovery now overlaps settings loading, native media loading begins while FFprobe validates the file, and probes request only the metadata vidcord uses.
- **Documented Linux preview limits**: Linux continues to use FFmpeg-generated frame and filmstrip scrub previews; live video scrubbing and trim playback remain disabled because WebKitGTK's playback path can crash the renderer on some systems.
- **Cancellable preview work**: obsolete frame, filmstrip, fallback-clip, and pending playback work is invalidated when a new file loads, compression starts, playback stops, or the preview unmounts.
- **Lighter filmstrips**: sparse seeking now starts at three minutes, and preview images scale to the actual display pixel ratio instead of always rendering at 2x resolution.
- **More stable preview caching**: duplicate clip replacements now keep exact cache accounting, while oversized clips no longer evict useful cached previews.

### FFmpeg Setup

- **Automated FFmpeg setup assistance**: Windows installers and first launch can offer package-manager FFmpeg installation while still keeping FFmpeg as a system dependency.
- **More accurate FFmpeg detection**: startup checks now require both `ffmpeg` and `ffprobe`, so missing `ffprobe` still shows setup help before video probing fails.
- **Faster startup detection**: GPU discovery now overlaps encoder enumeration where safe, skips unnecessary work when FFmpeg cannot launch, reuses that successful probe instead of spawning a redundant version check, and terminates stalled GPU, FFprobe, encoder, and VAAPI discovery commands at bounded deadlines.
- **Fixed Fedora AppImage detection**: system FFmpeg tools no longer inherit incompatible libraries bundled inside the AppImage, preventing false missing-FFmpeg errors on newer Fedora releases.

### File Opening

- **More reliable Open With routing**: file-open events now wait for the React listener to register before delivering cold-start, reload, or second-instance file paths.
- **Fixed Linux output reveal**: Browse File now launches desktop helpers without AppImage-bundled library paths, preventing host file managers from failing with incompatible GLib symbols.

### UI

- **Fixed app and preview sizing**: the main window now stays locked at 460×690, and preview/filmstrip thumbnails use a fixed 16:9 surface instead of resizing to content or source aspect ratio.
- **Accurate VideoToolbox labels**: macOS hardware encoders are now labeled for macOS instead of implying they are limited to Apple Silicon.
- **Safer file switching**: rapid file selections can no longer let an older probe replace the newest video, and unsupported drops leave the current selection intact.
- **More accessible controls**: the file picker is fully keyboard-operable, compression progress is exposed to assistive technology, update/encoder dialogs trap and restore focus correctly, and native Space/right-click behavior is preserved on interactive fields.
- **Restored liquid-glass window styling**: the app shell, cards, controls, footer, and light/dark palette once again match the established main-branch design while retaining the denser trim toolbar.
- **Clearer trim editing**: trim commands are grouped into an intuitive native toolbar with a recognizable magnet, honest zoomed/off-screen handles, undoable keyboard edits, and `?` shortcut help.
- **Fixed-size window layout**: standard and advanced controls continue to fit the 460×690 window without horizontal overflow, while the main-branch vertical scroll behavior remains available when platform title-bar space is tighter.
- **Readable encoder suggestions**: the advanced encoder dropdown now uses a fully opaque, content-sized surface so names remain visible without controls showing through.
- **Responsive trim previews**: dragging either the in or out handle keeps the thumbnail updated even when the WebView cannot seek the source directly or filmstrip generation is unavailable; on supported platforms, releasing a handle keeps the already-seeked video frame visible immediately while the exact FFmpeg fallback frame is generated in the background, and Play/Stop no longer reloads or clears that frame.
- **Selection-centered timeline zoom**: zoom buttons and Ctrl/Cmd-wheel zoom now focus the visible timeline on the current in/out range instead of the full clip midpoint.
- **Stable compression hover state**: the Compress Video button now keeps its gradient surface while hovering instead of flashing between gradient and solid-color paints.

- **More reliable preferences**: repeated settings changes now replace the persisted file atomically on Windows instead of failing after the first save.
- **Restored footer spacing**: version and link controls use the main-branch spacing, with Advanced Mode anchored at the opposite edge.

### Website

- **Live release download count**: the landing page now shows the aggregate GitHub release download total and falls back cleanly when the count service is unavailable.

### Build and Release

- **Stronger release safeguards**: CI now enforces frontend bundle-size budgets and high-severity npm audits on pull requests, validates structured data and the sitemap, rejects empty tagged changelog sections, pins the write-enabled release action, and prevents published tag builds from being cancelled by later pushes.
- **More reliable cross-platform builds**: Rust caches are isolated by compatible Linux runner and Windows target architecture, packaged artifacts use bounded retention without redundant recompression, site-only validation avoids installing the full app dependency tree, and source text uses consistent LF line endings across platforms.
- **Dependency hardening**: updated `anyhow` to 1.0.103 to resolve its `Error::downcast_mut()` soundness advisory.

### Documentation

- Updated the README, FFmpeg setup guide, website copy, structured data, and AI grounding files for package-manager FFmpeg setup and selectable encoder behavior.
- Corrected Discord tier, update-networking, package-size, trim-precision, retry-order, Linux compatibility, and encoder-selection claims across the README and website.
- Updated the README, website, structured data, AI grounding files, and contributor guidance to document Linux preview limitations and the FFmpeg-generated scrub-preview fallback.
- Aligned the public and maintainer documentation with bounded compression retries, race-safe cancellation, collision-safe output reservation, verified update downloads, and website network behavior.

## v6.6

### Preview

- **Reimplemented video preview**: the preview system has been rebuilt around source-shaped playback, live scrub updates, display-sized thumbnails and filmstrips, and a more accurate trim playback loop.
- **Sharper preview frames and filmstrips**: trim previews now request images sized to the rendered preview pane, including HiDPI displays, instead of using fixed low-resolution thumbnails.
- **More reliable preview generation**: preview frames and filmstrips try FFmpeg hardware decode first and automatically retry with software decode when hardware acceleration fails.
- **Faster long-video filmstrips**: videos over 10 minutes now use sparse frame seeks and lower frame counts so loading long clips does less upfront thumbnail work.
- **Hardware-accelerated preview clips**: generated scrub preview clips now try platform H.264 hardware encoders where available before falling back to `libx264`.
- **Playhead-aware fallback preview clips**: generated fallback preview clips now start from the current playhead and stay bounded to a short preview window so long selections do not generate huge in-memory clips.

### UI

- **Auto-fitting compact window**: the main window now starts at 460×690, keeps a fixed width, and automatically adjusts height to fit content and the available monitor space while saved window state restores position only.
- **Tighter settings layout**: target, FPS, and encoder controls now use fixed-width sizing where needed so the standard and advanced rows fit cleanly in the compact window.
- **Cleaner shortcut help**: the trim shortcut reference is now a hover/focus popover so it no longer expands the timeline layout.
- **Safer encoder warning tooltip**: the H.265 compatibility tooltip now opens above the encoder row and layers over neighboring controls reliably.

### Documentation

- Refreshed the website screenshots with corrected compact-window captures.
- Updated the README, website copy, structured data, and AI grounding files for scrub preview and preview-from-playhead behavior.

### Internal

- Preview frame cache keys now include requested output dimensions, and preview clip cache keys include the source file path and bounded time window to avoid stale preview reuse across files or display sizes.
- Rust audit ignores now include the current upstream `quick-xml` advisories that are blocked on the Tauri/plist dependency chain.

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

| Key             | Action                                |
| --------------- | ------------------------------------- |
| `Space`         | Toggle play / stop                    |
| `,` / `.`       | Step 1/30 second backward / forward   |
| `J` / `K`       | Jump playhead to trim start / end     |
| `[` / `]`       | Nudge trim start / end                |
| `I` / `O`       | Set trim in / out to current playhead |
| `Shift + Arrow` | Fine-nudge active handle by one frame |
| `R`             | Reset trim to full duration           |
| `?`             | Open shortcuts overlay                |

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
