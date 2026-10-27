# Source map and verification guide

This guide describes the current implementation on the `7.7` development branch.
Use [AGENTS.md](../AGENTS.md) for contribution rules, [README.md](../README.md)
for product usage, and [package.json](../package.json) for runnable commands.
Historical release notes are preserved in [CHANGELOG.md](../CHANGELOG.md).

## Runtime entry points

[main.tsx](../src/main.tsx) checks for `__TAURI_INTERNALS__`, lazily mounts the
native `App` or browser `WebApp`, and wraps either in `ErrorBoundary` and
`Suspense`. Desktop builds use the same Vite entry, then
[prune-desktop-dist.mjs](../scripts/prune-desktop-dist.mjs) removes browser-only
routes, FFmpeg workers, and WASM before Tauri embeds `dist/`.

| Area                        | Implementation and responsibility                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native UI                   | [App.tsx](../src/App.tsx): import ownership, modes, output preparation, batch orchestration, completion actions, updates, presets, and dialogs                                                              |
| Native compression hook     | [useCompression.ts](../src/hooks/useCompression.ts): command/event boundary, progress state, cancellation, bitrate/dimension helpers                                                                        |
| Native settings             | [useSettings.ts](../src/hooks/useSettings.ts), [settingsPresets.ts](../src/settingsPresets.ts), [settings.rs](../src-tauri/src/settings.rs): normalization, migration, debounced saves, durable replacement |
| Native capability discovery | [useEncoders.ts](../src/hooks/useEncoders.ts), [encoders.rs](../src-tauri/src/ffmpeg/encoders.rs), [gpu.rs](../src-tauri/src/gpu.rs): cached discovery and bounded hardware validation                      |
| Desktop host                | [lib.rs](../src-tauri/src/lib.rs): platform setup, plugins, command registration, file-open delivery, theme, and page-load cleanup                                                                          |
| Browser shell               | [WebApp.tsx](../src/web/WebApp.tsx): product page, deferred editor, drop forwarding, feedback, and support                                                                                                  |
| Download story              | [DesktopUpgrade.tsx](../src/web/DesktopUpgrade.tsx), [desktopDownloads.ts](../src/web/desktopDownloads.ts): platform/architecture/distribution selection, GitHub assets, Linux install dialog, Shields download count |
| Browser editor              | [WebEditor.tsx](../src/web/WebEditor.tsx), [WebTrimTimeline.tsx](../src/web/WebTrimTimeline.tsx): file/metadata ownership, mode controls, preview, trim history, queue, export delivery                     |
| Browser export              | [exportPlan.ts](../src/web/exportPlan.ts), [webExporter.ts](../src/web/webExporter.ts), [ffmpegEngine.ts](../src/web/ffmpegEngine.ts): arguments, adaptive passes, owned worker sessions                    |

## Desktop media lifecycle

1. File picker, folder picker, drops, CLI arguments, macOS Open With, and
   second-instance launches converge on import expansion. The backend scans
   the MP4/MOV/MKV/AVI/WebM/FLV/WMV extension allowlist recursively, deduplicates videos, skips discovered
   directory links, and reports unreadable/skipped items. A scan stops at
   100,000 entries; `truncated` and `superseded` results must remain visible as
   incomplete. See [files.rs](../src-tauri/src/commands/files.rs) and
   [importSummary.ts](../src/importSummary.ts).
2. [ffmpeg.rs](../src-tauri/src/ffmpeg.rs) probes media through generation-owned,
   bounded FFprobe children. Batch probing runs at most two children together.
   Imported metadata includes display dimensions, bitrate, frame rate, audio
   streams, pixel format, and color transfer. Stale work cannot update a new
   selection.
3. [PreviewPane.tsx](../src/components/PreviewPane.tsx) uses HTML video on all
   platforms. Windows/macOS use scoped Tauri asset URLs. Linux uses
   [preview_source.rs](../src-tauri/src/preview_source.rs) to serve original
   bytes over loopback with range requests, exact Host validation, scope checks,
   random capability URLs, and file identity checks. Registrations are revoked
   on release/reload, capped at 16, and requests at eight concurrently. This is
   original-file delivery; preview does not transcode unsupported sources.
4. [compression.rs](../src-tauri/src/commands/compression.rs) owns the encode
   job, its children, output reservation, retries, size measurements, and native
   taskbar/Dock progress. Cancelling retains ownership until child termination;
   it must not free the UI to start a conflicting job prematurely.
5. Direct output paths are advisory until an atomic create-new reservation
   succeeds. Ask when done uses staged output and a later save dialog; Batch
   asks for one destination directory. Publication validates staged paths,
   flushes output, and cleans partial files. User-approved single-file save
   publication and collision-safe batch publication have separate paths.
6. Completion can copy, reveal, or leave files saved. Copy failures fall back
   to reveal. Windows uses native shell/CF_HDROP APIs; macOS uses NSWorkspace
   and NSPasteboard; Linux uses FileManager1 with folder-opening fallback and
   `wl-copy`/`xclip`. Close after export is independent and requires success.

### Encoding modes and boundaries

Compress and Advanced re-encode into MP4; normal output includes a vidcord
metadata comment and faststart. Audio selections map to separate AAC streams
at 128 kbps each, with each stream included in the video bitrate budget. The
track picker does not mix the selected tracks into one stream. Preview enables
only the first selected track when the platform exposes track selection.
[Audio selection helpers](../src/audioTracks.ts) prefer the first track unless
a later track's estimated data score is at least 20% greater.

Target-size exports measure results and use bounded oversize and underfill
correction. Sampling, hardware-decode fallback, CPU fallback, and private
candidate outputs are implemented in `compression.rs`. Keep the best fitting
result if refinement fails. Temporary candidates use private directories;
Windows uses the per-user cache, and Unix validates ancestor ownership,
permissions, and applicable macOS ACLs before staging. Do not replace these
rules with predictable writable sibling paths or unchecked cross-volume moves.

Deep-color video is converted to `yuv420p` for normal video encoding. PQ/HLG
sources are tone-mapped to SDR BT.709 only if both `tonemap` and `zscale` are
available; plain format conversion preserves source color tags. Filter
availability probes are cached and invalidated after FFmpeg installation.
This does not imply browser HDR parity or HDR preservation.

Lossless Trim discovers keyframes, snaps trim bounds outward, and stream-copies
all source streams (or drops audio with `-an`). Desktop tries MP4, then a
validated source container, then normal compression. It does not add the
re-encoding metadata comment or apply crop/FPS/color filters. Browser copy
uses MP4/MOV/MKV/WebM according to the source extension, or MP4 otherwise;
it has no matching desktop container-fallback sequence.

GIF and WebP have shared 5/10/20 MB presets at 15/30/50 FPS. GIF creates its
palette in a separate pass; WebP uses `libwebp_anim` without a palette. Native
Batch supports Compress MP4 only, at most two encodes concurrently, and switches
to serial scheduling on recognized hardware/session contention.

## Browser engine and delivery

The page renders before loading FFmpeg. After readable metadata is available,
`WebEditor` warms the encoder; export and keyframe discovery also ensure it is
loaded. The installed `@ffmpeg/core` package supplies the fixed WASM build;
no system FFmpeg is used. Normal video encoding uses `libx264` (`superfast`
on mobile and `veryfast` otherwise).

Inputs are capped at 512 MiB each, displayed as “512 MB”; Batch accepts up to
12 files, processes them sequentially with a shared full-duration Compress
profile, and isolates failures. Browser metadata depends on the media decoder;
[webMedia.ts](../src/web/webMedia.ts) estimates bitrate and reads exposed audio
tracks. Exact codecs and frame rates may be unavailable. Standard FPS options
are filtered only when the source rate is known; Advanced accepts positive FPS
up to 240. [webSettings.ts](../src/web/webSettings.ts) normalizes current
settings under `vidcord.browser.settings.v2`, with a v1 fallback. There are no
named browser presets.

Engine sessions mount input read-only using WORKERFS and use generated internal
names. Load cancellation has a generation token and a two-minute deadline.
Encoding has a four-minute progress-silence watchdog; a stalled worker is torn
down, with one automatic export retry. Keyframe discovery is limited to 60
seconds and 100,000 keyframes. File-identity weak caches avoid sharing metadata
between distinct files with matching names and sizes.

Browser audio compatibility retries can skip normalization or remove unsupported
audio, reporting that outcome. All successful outputs trigger browser downloads.
Single-file Advanced, Lossless Trim, and GIF/WebP additionally attempt a browser
clipboard write for blobs up to 8 MiB with a two-second deadline. Compress and
Batch skip this convenience; it is not the native file-copy completion setting.
Exports estimated above 256 MiB ask for confirmation because of browser memory
pressure. The final portion of progress is reserved for checks and delivery.

## Feedback, notifications, and network use

Compression never uploads selected video. Network operations include loading
site assets, public GitHub release metadata/downloads, the Shields count, and
feedback explicitly submitted by the user.

The desktop [FeedbackDialog](../src/components/FeedbackDialog.tsx) collects a
report through [feedback.rs](../src-tauri/src/commands/feedback.rs): app/system
information, a description capped at 8 KiB, and 100 log lines in the submitted
body. Its private local copy includes up to 500 log lines. Successful endpoint
submission triggers best-effort deletion; failure retains the copy for the
user-selected email fallback. Copies older than seven days are swept when
another report is collected. Logs can contain local filenames and diagnostics.

The website [feedback form](../src/web/FeedbackSection.tsx) accepts up to 5,000
characters and adds the page URL, user agent, and language. Both frontends use
[feedback.ts](../src/feedback.ts) to POST to `/api/feedback`. The separate
[Worker](../workers/feedback/README.md) forwards text through Resend; its public
shared token is not a private credential. Website failures display an error;
the desktop dialog also provides a manual mail-app fallback.

[useToasts.ts](../src/hooks/useToasts.ts) serializes matching native notifications.
The backend checks window focus before delivery and handles activation without
blocking the delivery queue. macOS development has an AppleScript fallback;
bundled builds use Notification Center with ad-hoc signing. This does not claim
Developer ID signing or notarization.

## Website source, generated output, and deployment

Edit product content in `src/web/`, metadata/JSON-LD in root `index.html`, and
static marketing/crawler resources under `site/`. Run `npm run web:build` to
stage a Vite manifest build, add browser static dependency and hero-image hints,
compress WASM as `.wasm.gz`, and replace only `site/assets`, `site/icon.png`,
and `site/index.html`. It preserves the marketing and crawler files and removes
the historical `site/app` output. Generated assets must accompany relevant
source changes; do not hand-edit hashed files.

[wrangler.jsonc](../wrangler.jsonc) serves `site/`; the existing GitHub-connected
site deploy publishes from `main`. The Actions site workflows validate output;
they do not contain a deployment command. Custom-domain configuration is outside
the root config. Feedback has its own Worker config and deployment.

[site/\_headers](../site/_headers) applies CSP, allows only required external
connections, and gives content-hashed assets immutable cache headers. It marks
`llms.txt` and `llms-full.txt` as noindex/follow while leaving them crawlable.
[site/\_redirects](../site/_redirects) maps `/index.html`, `/index`, `/app`, and
`/app/` to `/`. `#download` and `#web-editor` are anchors on the same page.
The manifest is not an offline service worker; a cold browser visit still needs
the site and encoder assets to load.

## Packaging, releases, and updates

[tauri.conf.json](../src-tauri/tauri.conf.json) defines the initial native window,
CSP, scoped media, associations, package dependencies, and NSIS FFmpeg offer. The desktop
[window sizing hook](../src/hooks/useDesktopWindowSizing.ts) measures the rendered controls,
chooses a layout for the monitor work area, and adjusts the WebView size using observed native
resize events so scaling and window decorations are accounted for.
[build.yml](../.github/workflows/build.yml) builds Windows x64/ARM64 NSIS, macOS
universal DMG, and Linux x64/ARM64 AppImage, DEB, and RPM. Tag builds additionally
repack the two DEBs as native Arch/Arch Linux ARM `vidcord-bin` packages with
[the packaging templates](../packaging/arch/PKGBUILD.template).

`vX.Y` tags use the optimized release profile. Branch, PR, and manual builds
use the CI profile, upload installers for seven days, and do not publish a
release. A separate permissioned job generates provenance for tag and manual
platform builds; Arch tag builds attest their packages in the Arch job. Tagged
publication verifies provenance, checks the Ed25519 key, signs the installer
formats, extracts `## vX.Y` notes, and publishes immediately.
Linux repository publication follows, and skips with a summary if its separate
GPG secret is absent. See [RELEASE_SIGNING.md](RELEASE_SIGNING.md) for format and
key contracts and [LINUX_INSTALL.md](LINUX_INSTALL.md) for repository activation.

[updates.rs](../src-tauri/src/commands/updates.rs) routes installed Linux packages
with configured vidcord repositories to APT/DNF/pacman before a GitHub lookup.
Flatpak environments (`FLATPAK_ID` or `/.flatpak-info`) bypass GitHub checks and
installer downloads in favor of platform-managed updates. This repository does not
build a Flatpak package. AppImages bypass package-repository detection; native packages without the repository retain
GitHub checks. Installer approval binds an exact release tag. Downloads require
a GitHub SHA-256 digest and the pinned Ed25519 signature, enforce a 512 MiB cap
and response/chunk deadlines, and publish without overwriting a file. Linux
reveals the executable AppImage for manual replacement; Windows/macOS open the
verified installer/DMG. These checks do not automatically replace native Linux
packages or authenticate platform code signing.

## Verification and workflow scope

| Change                          | Relevant local verification                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend behavior               | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run bundle:check`                                                                                                |
| Native behavior                 | `cargo fmt --check --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml --tests -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml` |
| Browser/site source or metadata | `npm run web:build`, inspect generated diffs, `npm run site:check`; after committing generated output, `node scripts/check-site-generated.mjs` verifies its WASM against HEAD           |
| Versions/assets/build tooling   | `npm run version:check`, `npm run assets:check`, `npm run build-tools:check`                                                                                                            |
| Feedback service                | `node --check workers/feedback/src/index.js`, `node --test workers/feedback/test/index.test.js`                                                                                         |
| Full media UI flows             | `npm run e2e:web`, `npm run e2e:desktop`; see [E2E prerequisites](../scripts/e2e/README.md)                                                                                             |

The four workflow files have distinct responsibilities:

- **Multi-Platform Build**: app/packaging/config/workflow paths on `main` and
  `X.Y` pushes/PRs, all `v*` tags, and manual dispatch. Frontend quality/audit
  runs once; Rust checks run on Linux with explicit target and CI profile;
  five platform builds reuse the frontend artifact and locked minimal Tauri CLI.
  Install it with `npm ci --prefix tools/tauri-cli` before running
  `npm run build-tools:check` locally.
  Signing, publication, Arch repacking, and repository publication are tag-only.
- **End-to-End UI Tests**: matching app/test/runner/config/workflow paths on
  `main` and `X.Y` pushes/PRs, or manual dispatch. One Chromium browser job and
  four desktop jobs (Linux x64, Linux ARM64, macOS, Windows), each limited to
  60 minutes, upload evidence for seven days.
- **Site Checks**: matching site/metadata/config/workflow paths on `main`
  pushes or PRs targeting `main`, plus manual dispatch. Formatting, structured
  data, sitemap, assets/extensions, size limits, and versions; no bundle rebuild.
- **Site Browser Build**: matching browser/site/build/workflow paths on `main`
  pushes or PRs targeting `main`, plus manual dispatch. Rebuilds and compares
  all non-WASM output exactly, then compares decompressed WASM against HEAD
  because gzip bytes can vary across Node/zlib versions. All `site/**` changes,
  including marketing and crawler files, match this workflow.

Vitest defaults to Node with Tauri invoke/listen mocks; component suites opt
into happy-dom. Worker tests use Node's test runner separately and are outside
Vitest's `src/**` include. E2E uses real FFmpeg and media checks, with native
file dialogs mocked and an isolated app-data directory. The E2E feature exposes
an embedded WebDriver/global Tauri bridge absent in production; application
code must keep using imported Tauri APIs.

Pure Markdown maintenance does not need platform packaging tests. Run the
checks for any site metadata/output touched and validate relative documentation
links. Do not rewrite old release notes as current behavior or add a release
note for documentation-only corrections.
