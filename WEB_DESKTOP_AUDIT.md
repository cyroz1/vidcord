# Browser/Desktop parity audit

Snapshot for the `7.4` worktree. This audit covers the browser editor at `/`, the
native Tauri app, their shared export helpers, and the public capability copy.

## Current baseline

- GIF targets are aligned in both editors and the public site: **5 MB, 10 MB, and
  20 MB**.
- Both editions share Compress, Advanced, Lossless Trim, and GIF modes. The browser
  uses FFmpeg WebAssembly and browser downloads; desktop uses system FFmpeg plus
  native filesystem integrations.
- Verification completed: `npm run lint`, `npm run typecheck`, `npm test` (158
  tests), `npm run build`, `npm run bundle:check`, `npm run web:build`,
  `npm run site:check`, `cargo fmt --check`, `cargo test` (110 tests), and
  `cargo clippy --tests -- -D warnings`. `git diff --check` and the rendered
  browser smoke pass also completed successfully.

## Capability differences

| Area                  | Browser                                                                | Desktop                                                                          |
| --------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Encoder               | Fixed `libx264` in WebAssembly                                         | CPU and detected GPU encoders; selectable                                        |
| Inputs                | Browser-decodable files, capped at 512 MB each; metadata is limited    | Any format the installed FFmpeg can demux                                        |
| Advanced resolution   | Native, 1080p, 720p, 480p                                              | Native, 4K, 1440p, 1080p, 720p, 480p                                             |
| Advanced FPS          | Up to 240 when source FPS is known; otherwise Source-only              | Validated up to 1000                                                             |
| Scaling semantics     | Literal encoded target height, with even-dimension correction          | Literal encoded target height, with encoder-specific correction                  |
| Audio                 | First source stream; normalize/remove when re-encoding; lossless `-an` | Track selection/mixing, normalize/remove                                         |
| Trim editing          | Handles, playhead, labels, history, loop, snap, zoom, and pan          | Browser features plus keyframe snap, range drag, and native keyboard shortcuts   |
| Lossless Trim         | Keyframe stream copy through WebAssembly; optional audio removal       | Keyframe stream copy, optional audio removal, container and compression fallback |
| Batch                 | Shared full-duration Compress profile; sequential browser downloads    | Per-file trims, native workers, collision-safe/native output handling            |
| Output and completion | Browser download; optional small-blob clipboard convenience            | Downloads/source/custom/save prompt; copy or reveal                              |
| Persistence           | Lightweight browser storage with semantic GIF targets                  | Settings and named presets with semantic GIF targets                             |

The matrix is intentionally concise. The status sections below record each
previously identified parity risk and the residual limitations that remain
intentional or browser-platform dependent.

## Resolved findings

### P1 — Browser Lossless Trim audio control was a no-op — resolved

`removeAudio` now flows from `src/web/WebApp.tsx` through
`src/web/webExporter.ts` and `src/web/exportPlan.ts`; Lossless Trim emits `-an`
while retaining stream copy for video. The UI describes audio removal as
non-reencoding, and `src/__tests__/webExport.test.ts` asserts the command shape.

### P1 — Portrait scaling semantics differed — resolved

Browser re-encoded scale filters now use a literal `scale=-2:<targetHeight>`
contract matching native output. GIF dimensions and crop corrections are forced
even where required by H.264/GIF encoders. Portrait and odd-square planner tests
cover the contract on the browser side, while native filter tests cover the
corresponding Rust path.

### P2 — GIF quality and retry policy diverged — resolved

Both editors expose the shared `GIF_PRESETS` values 5/10/20 MB with target
heights 360/480/720. Browser GIF planning now lowers initial spatial detail for
higher FPS, uses palette complexity in its bounded retry policy, and allows four
attempts while preserving the selected FPS. Native already had the corresponding
FPS-aware scale and palette retry behavior. Export argument tests cover target,
FPS, palette, and retry changes.

### P2 — GIF persistence could silently change meaning — resolved

Browser storage now uses a v2 schema with semantic `gifTargetMb`; native settings
and named presets use `gif_target_mb`. Legacy numeric indexes are migrated so old
20/50 MB-era values resolve safely to the new 20 MB maximum rather than becoming
5 or 10 MB. The migration is tested in browser, preset, and Rust settings suites.

### P2 — Browser FPS could upsample unknown-rate sources — resolved safely

When browser media metadata cannot determine the source frame rate, Standard mode
offers only Source and Advanced custom FPS is disabled. With a known source rate,
the normal source-aware choices remain available. This avoids presenting an output
rate as a cap when the source cadence is unknown.

### P2 — Browser bitrate planning assumed one audio stream — addressed

Browser metadata now reports an available audio-track count when the browser
exposes one, and bitrate planning reserves 128 kbps per reported track. If the
browser exposes only a boolean audio signal, planning retains the conservative
one-track allowance. Browser encoding still maps the first source audio stream;
full track selection/mixing remains a desktop capability.

### P2 — Browser audio fallback hid unrelated failures — resolved

The video-only retry now runs only for errors that contain both audio-related and
failure-related signals. Generic memory, filter, and codec failures propagate
without silently changing the requested media shape. The classifier has a
non-audio regression test.

### P2 — Browser Batch clipboard gate used stale single-file mode — resolved

Clipboard convenience is now derived from the effective browser mode and batch
state, so Batch always follows the documented browser-download behavior. The pure
state helper and regression tests cover this transition.

### P2 — Browser keyframe discovery was tail-truncated — resolved

The WebAssembly runner now supports an incremental log callback. Keyframe output
is parsed as it arrives into a bounded normalized list, while the diagnostic log
tail remains available only for error context. This avoids losing early keyframes
from long videos.

### P2 — Browser probing and memory bounds were weak — addressed

Browser metadata loading now has a finite timeout, and selected files larger than
512 MB are rejected before WebAssembly loading/encoding. The cap is documented in
the browser UI copy and public docs. Browser encoding still necessarily loads the
accepted source into WebAssembly memory; a streaming pipeline is outside the
current FFmpeg WebAssembly integration.

### P3 — Browser picker and validator extension lists differed — resolved

The picker and input validator now share `VIDEO_FILE_ACCEPT`, covering the browser
supported extension set including M4V, MPEG, MPG, and OGV.

### P3 — Persisted browser crop could disappear while remaining active — resolved

Browser crop state now resets to `off` and persists the correction when an imported
source makes the saved crop redundant. This matches the native normalization path.

### P3 — Odd square crops could produce invalid dimensions — resolved

Crop output dimensions are corrected to even values after crop/filter construction,
including 1:1 square crops. The browser planner has an odd-square regression test;
native filter tests cover crop correction as well.

### P3 — Native MP4 compression lacked consistent faststart — resolved

Native normal MP4 compression now adds `-movflags +faststart`, matching the browser
MP4 export and the existing native lossless faststart policy where applicable.

### P3 — Source-quality rate control differed — resolved

Browser `-maxrate`/`-bufsize` are now emitted only for target-sized plans, matching
the native contract. Source-quality and target-sized argument shapes are tested.

### P3 — Browser trim editing was materially lighter — improved and documented

The browser timeline now provides snap intervals, zoom, and pan in addition to its
existing handles, playhead, time labels, history, and loop playback. Desktop still
retains native keyframe snapping, range drag, and keyboard shortcuts as intentional
desktop affordances; the capability matrix and docs describe that boundary.

### P3 — Browser component coverage was missing — resolved

The suite now includes a small `happy-dom` WebApp/timeline harness plus pure state,
settings, media, and export-planner regressions. It verifies semantic GIF options,
timeline controls, crop/FPS state behavior, migration, and Batch completion gating
without requiring a full FFmpeg export.

## Remaining risks and intentional differences

- Browser media APIs do not reliably expose rotation or non-square-pixel SAR. The
  browser therefore derives crop choices from decoded pixel dimensions, while
  desktop can use FFprobe display dimensions and rotation metadata. This remains a
  platform limitation and is called out in the capability copy.
- Browser FFmpeg WebAssembly remains memory-bound even with the 512 MB input cap;
  device memory, browser codec support, and source container behavior can still
  limit successful exports.
- Browser uses the first audio stream and cannot offer desktop's source-track
  mixer. Browser audio-track counts, where available, improve bitrate planning but
  do not add track-selection UI.
- Desktop retains native-only GPU encoders, filesystem destinations, OS actions,
  native notifications, and richer keyframe/keyboard timeline integration.

## Verification record

- Frontend: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and
  `npm run bundle:check` passed. The final bundle is 479.5 KiB raw JavaScript /
  147.6 KiB gzip and remains within the explicit 7.4 budget.
- Site: `npm run web:build` and `npm run site:check` passed, including generated
  asset, structured-data, sitemap, and file-size validation.
- Native: `cargo fmt --check --manifest-path src-tauri/Cargo.toml`, `cargo test
--manifest-path src-tauri/Cargo.toml`, and `cargo clippy --manifest-path
src-tauri/Cargo.toml --tests -- -D warnings` passed.
- Rendered browser smoke: the rebuilt local root reported the expected title,
  showed exactly 5/10/20 MB in GIF mode, disabled Advanced FPS when source rate
  was unavailable, exposed trim snap/zoom/pan controls, and produced no warning
  or error console entries.

## Release hygiene

The active branch is `7.4`, but the app/package/Tauri version references remain
`7.3.0`. That is acceptable for an in-progress branch; all version references must
be aligned before tagging or publishing v7.4. The audit does not change release
version metadata.
