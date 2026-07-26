# AGENTS.md

Guidance for AI assistants working in this repository. Read this before making changes.

## Project overview

**vidcord** is a cross-platform desktop app that compresses video files under Discord's size limits. It is built with **Tauri 2** (Rust backend + React/TypeScript frontend) and shells out to the system **FFmpeg** binary for all video work. It does **not** bundle FFmpeg — the system `ffmpeg`/`ffprobe` must be on `PATH`.

- **App version**: kept in sync across `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and any `vX.Y` references in source/docs (see "Bumping the version" below)
- **Window**: fixed 460×690, user non-resizable/non-maximizable, opaque window background with macOS Tahoe "liquid glass" styling inside the app surface
- **Supported OS/arch**: Windows (x86_64 + aarch64), macOS (universal), Linux (x86_64 + aarch64)
- **Node**: `^20.19.0 || >=22.13.0` (see `package.json` engines)
- **Rust**: stable toolchain, edition 2021

## Repository layout

```
.
├── src/                       # React frontend (TypeScript)
│   ├── App.tsx                # Root component — wires hooks, UI, trim timeline, compression
│   ├── App.css                # App styling (dark/light via prefers-color-scheme)
│   ├── ErrorBoundary.tsx      # Top-level crash recovery UI
│   ├── ipc.ts                 # Typed wrappers around Tauri invoke() commands
│   ├── main.tsx               # ReactDOM entry + native macOS title-bar theme sync
│   ├── index.css              # Global CSS vars (--accent, --surface, --blur…)
│   ├── ffmpegErrors.ts        # Shared FFmpeg-missing error detection/copy
│   ├── previewScrub.ts        # Pure preview-seek and native-context-menu helpers
│   ├── timelineZoom.ts        # Pure trim-timeline zoom/view calculations
│   ├── videoMetadata.ts       # Pure source-metadata formatting helpers
│   ├── components/
│   │   ├── PreviewPane.tsx    # Video preview + scrub thumbnail + filmstrip
│   │   ├── ProgressSection.tsx# Compression progress bar + ETA
│   │   ├── TrimTimeline.tsx   # Memoized trim controls, shortcuts, zoom, playhead UI
│   │   ├── Toast.tsx          # Single toast row
│   │   └── EncodersDialog.tsx # Lazy-loaded FFmpeg encoder list dialog
│   ├── hooks/
│   │   ├── useCompression.ts  # Event listeners + pure bitrate/dimension helpers (tested)
│   │   ├── useEncoders.ts     # detect_encoders + FFmpeg-missing tracking
│   │   ├── useSettings.ts     # persisted compression/output prefs + debounced saves
│   │   └── useToasts.ts       # Toast queue with per-id timer cleanup
│   ├── __tests__/             # Vitest tests (node env, Tauri APIs mocked)
│   └── __mocks__/@tauri-apps/ # Invoke/listen stubs so pure helpers run in Node
├── src-tauri/                 # Rust backend
│   ├── src/
│   │   ├── main.rs            # Thin entry — calls lib::run()
│   │   ├── lib.rs             # Tauri builder, platform shims/theme, file-open routing
│   │   ├── ffmpeg.rs          # probe / preview / filmstrip / VAAPI discovery + caches
│   │   ├── ffmpeg/
│   │   │   └── encoders.rs    # FFmpeg encoder detection + encoder cache invalidation
│   │   ├── gpu.rs             # Vendor detection (lspci / system_profiler / Get-CimInstance)
│   │   ├── log.rs             # Rotating ~/…/vidcord/vidcord.log (5 MB cap)
│   │   ├── settings.rs        # Typed settings persisted via atomic rename
│   │   └── commands/          # #[tauri::command] handlers
│   │       ├── compression.rs # compression jobs/retries/reservations + preview/probe commands
│   │       ├── encoders.rs    # detect/install/list FFmpeg; platform install flows
│   │       ├── files.rs       # output locations/staging, file reveal/clipboard, get_os, PendingFile
│   │       └── updates.rs     # Semver checks + verified installer download/publication
│   ├── capabilities/default.json  # Tauri permissions (dialog, opener, core)
│   ├── windows/
│   │   └── ffmpeg-hooks.nsh   # Interactive NSIS post-install FFmpeg/winget offer
│   ├── build.rs               # Tauri build entry
│   ├── tauri.conf.json        # Product config, CSP, associations, targets, installer hook
│   ├── Cargo.toml             # release/ci/dev profiles (see "Build profiles")
│   └── .cargo/audit.toml      # RUSTSEC ignore list for Tauri upstream advisories
├── public/
│   └── icon.png               # Vite-served app logo
├── site/                      # Static marketing/download website for vidcord.app
│   ├── index.html             # Crawlable landing page, metadata, JSON-LD, app download UI
│   ├── styles.css             # Dark blue responsive site styling
│   ├── script.js              # Platform detection + latest GitHub release asset selection
│   ├── robots.txt             # Allows search crawlers and AI agents
│   ├── sitemap.xml            # Canonical sitemap for vidcord.app
│   ├── llms.txt               # Short AI-agent grounding summary
│   ├── llms-full.txt          # Expanded AI-agent grounding context
│   ├── site.webmanifest       # Site/app manifest
│   └── assets/                # Canonical logo and uncropped product / file-manager screenshots
├── wrangler.jsonc             # Cloudflare Worker static-assets deployment config
├── .github/workflows/build.yml# Multi-platform CI + release workflow
├── .github/workflows/site.yml # Site-only validation workflow
├── scripts/                   # Bundle, version, asset, sitemap, and structured-data checks
├── index.html                 # Vite entry
├── vite.config.ts             # React plugin, manual chunks (react / tauri / tauri-opener)
├── vitest.config.ts           # Node env + Tauri-api mock aliases
├── eslint.config.js           # ESLint flat config (TS + react-hooks)
├── .prettierrc                # 100-col, 2-space, double-quote, ES5 trailing commas
├── tsconfig.json              # Strict TS, ES2021 target, react-jsx
├── FFMPEG_SETUP.md            # End-user FFmpeg install guide (per platform)
├── CHANGELOG.md               # User-facing release notes
├── .env.example               # Optional Vite/Tauri development build variables
└── README.md                  # Public overview
```

## Development workflows

### Run the app locally

```sh
npm install
npm run tauri dev          # starts Vite on :5173, launches the Tauri window
```

FFmpeg must be on `PATH` for the app to probe videos or compress.

### Quality gates

```sh
npm run lint               # eslint src
npm run typecheck          # tsc --noEmit
npm test                   # vitest run
npm run build              # production frontend bundle
npm run bundle:check       # enforce JS/CSS bundle-size budgets after build
npm run version:check      # align package/locks/Tauri config/site version references
npm run assets:check       # enforce canonical app/site asset organization
npm run format             # prettier --write src
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --tests -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
(cd src-tauri && cargo audit) # respects .cargo/audit.toml
```

CI treats any clippy warning as an error and also runs npm/Rust audit, version,
asset, lint, typecheck, test, and build checks — keep new Rust code
warning-clean.

### Build a release binary

```sh
npm run tauri build        # outputs to src-tauri/target/release/bundle/
```

### Windows installer FFmpeg offer

The NSIS bundle loads `src-tauri/windows/ffmpeg-hooks.nsh` through
`bundle.windows.nsis.installerHooks`. On an interactive install, the post-install hook checks for
both `ffmpeg` and `ffprobe`; if either is missing and `winget` exists, it asks the user before
installing the exact `Gyan.FFmpeg` package. Silent installs never prompt, declining is supported,
and failure falls back to the app's first-launch FFmpeg setup UI. Keep this explicitly opt-in and
do not describe FFmpeg as bundled with vidcord.

### Website (`/site`) deployment

The public website lives in `site/` and deploys from GitHub when changes are pushed to `main`.
Do not run Wrangler for normal site deploys.

- **Production domain**: `https://vidcord.app/`
- **Workers.dev URL**: `https://vidcord-site.cyrz.workers.dev/`
- **Cloudflare Worker name**: `vidcord-site`
- **Legacy/manual deployment config**: `wrangler.jsonc` → `assets.directory = "./site"`,
  `workers_dev = true`
- **Custom domain route**: `vidcord.app`
- **Deployment trigger**: push the committed site changes to `origin/main`; the
  GitHub-connected deployment handles publishing.

Site behavior and content:

- `site/index.html` is static, crawlable HTML. Keep important product claims visible in HTML, not only in JavaScript.
- `site/script.js` detects Windows/macOS/Linux, calls GitHub's latest-release API, and
  links download buttons directly to matching binary assets when the platform and architecture are
  known. If x64 vs ARM64 cannot be determined with high confidence, prompt the user to choose an
  architecture; each architecture option should link directly to the matching latest-release
  binary. It falls back to `https://github.com/cyroz1/vidcord/releases/latest` only when release
  metadata cannot be fetched. It also fetches the aggregate release download count from Shields.io
  with a bounded timeout and strict response validation; failure must leave the count unavailable
  without affecting download links.
- The social/link embed image intentionally uses the logo: `https://vidcord.app/assets/icon.png` via `og:image` and `twitter:image`.
- Discord and other chat clients may cache old embeds. Use a temporary query string such as `https://vidcord.app/?v=2` when checking a changed preview image.
- Product screenshots should not be cropped in CSS. Keep `width: 100%` and `height: auto` for screenshot images unless the user explicitly asks for a cropped composition.
- The website documents local processing, FFmpeg as a required system dependency, Discord target sizes, Open With integration, and selectable output destinations (Downloads by default).

SEO and crawler/agent files:

- `robots.txt` should allow normal web crawlers and AI agents, and point at `https://vidcord.app/sitemap.xml`.
- `sitemap.xml` should include the home page plus `llms.txt` and `llms-full.txt`.
  Update each changed public URL's `lastmod` date when its page or grounding content changes.
- `llms.txt` is the concise grounding file for AI agents.
- `llms-full.txt` is the expanded grounding context. Keep it factual and aligned with the app and README; do not invent hosted compression, bundled FFmpeg, accounts, or telemetry.
- `index.html` contains JSON-LD for `WebSite`, `SoftwareApplication`, and `FAQPage`. If site facts change, update visible copy, JSON-LD, `llms.txt`, and `llms-full.txt` together.

Local website preview:

```sh
python3 -m http.server 4174 --bind 127.0.0.1 -d site
```

Website validation:

```sh
npm run site:check
```

The site check runs Prettier, `node --check`, JSON-LD / manifest parsing, semantic sitemap validation, asset organization checks, and version alignment. If you need to run the structured-data or sitemap parsers directly:

```sh
node scripts/check-site-structured-data.mjs
node scripts/check-sitemap.mjs
```

Deploy the website:

```sh
git push origin main
```

Post-deploy checks:

```sh
curl -I https://vidcord.app/
curl -I https://vidcord.app/assets/icon.png
curl -L https://vidcord.app/robots.txt
curl -L https://vidcord.app/sitemap.xml
curl -L https://vidcord.app/llms.txt
curl -L https://vidcord.app/llms-full.txt
curl -L https://vidcord.app/site.webmanifest
```

For browser QA, use the in-app browser when available and check:

- page title and canonical URL
- no blank page or framework overlay
- no relevant console warnings/errors
- JSON-LD types are present
- FAQ and download sections render on desktop and mobile
- screenshot aspect ratios remain uncropped

Site-only changes should not trigger the multi-platform app CI: `.github/workflows/build.yml` ignores `site/**`, `wrangler.jsonc`, the Site Checks workflow, and site-only validator scripts for `push` and `pull_request`.

### Build profiles (src-tauri/Cargo.toml)

- `release` — LTO, `codegen-units=1`, `strip`, `panic=abort`. Used for tagged releases.
- `ci` — inherits release with `lto=false`, `codegen-units=4`, `opt-level=1`. Used by non-tag CI builds for speed.
- `dev.package."*"` — deps built at `opt-level=1` so FFmpeg stderr parsing / regex stay responsive in `tauri dev` while our crate stays unoptimised for fast incremental compiles.

CI picks the profile based on whether the ref is a `v*` tag (see `build.yml`).

## Architecture notes

### IPC boundary (Tauri commands)

All Rust→Frontend IO flows through `#[tauri::command]` functions registered in `src-tauri/src/lib.rs`'s `invoke_handler!` macro. When you add a new command:

1. Define it in the appropriate file under `src-tauri/src/commands/` (or a new module).
2. Re-export it from `commands/mod.rs` if needed and import it in `lib.rs`.
3. Add it to the `tauri::generate_handler![…]` list in `lib.rs` — otherwise `invoke()` from the frontend throws at runtime.
4. Heavy/blocking work (`ffmpeg`, `ffprobe`, `lspci`, `winget`, etc.) must run inside `tokio::task::spawn_blocking` — Tauri's command runtime uses a small async pool and blocking work there stalls the UI.

Events flow the other direction via `AppHandle::emit` → `listen()` in the frontend:

- `compress-progress` — percent, eta, status, attempt number, encoder, bitrate (emitted per FFmpeg stderr `time=` line and at retry boundaries)
- `compress-done` — success/cancelled/message/output_path plus input/output/target size metadata when available
- `open-file` — path from single-instance forwarding, macOS Apple Events, or CLI args
- `tauri://drag-drop` — built-in Tauri event for drops on the window

System notifications are initiated by `useToasts`: every in-app toast queues the exact same title
and body for the backend `send_system_notification` command. The backend rechecks main-window focus
immediately before delivery and suppresses the OS notification while focused. macOS uses a bounded
`osascript` invocation with title/body passed as data arguments; Windows and Linux use the
synchronous `notify-rust` API so delivery acceptance or failure is returned to the frontend.
Delivery failures are logged without logging notification contents, and the in-app toast remains
visible as the fallback. Keep notification delivery serialized so related banners retain their
in-app order, and escape Linux notification markup so errors render as literal text.

Compression uses a single owned backend job ID. Cancellation keeps that job active until its FFmpeg
process exits; do not clear frontend compression state before the matching `compress-done` event or
replace the job-specific state with an unowned global PID. Cancellation gives the owned process a
short graceful-exit window, then force-terminates it only while the same job still owns that PID.

### Compression and output lifecycle

FFprobe returns source codec, frame rate, bitrate, dimensions, display dimensions, and duration.
`videoMetadata.ts` formats those values for the import summary. The frontend derives the initial
target bitrate from the selected size and trimmed duration, then caps it at the probed source
bitrate so compression does not request a higher bitrate than the input. On success, the backend
includes the input file size in `compress-done` so the frontend can report the actual percentage
reduction.

Output handling has two paths:

- **Downloads / clip folder / custom folder**: `resolve_output_path` chooses a collision-free
  `<stem>-vidcord[-N].mp4` candidate. Before FFmpeg starts, `OutputReservation::create` atomically
  creates that exact path and owns it across every adaptive retry. Treat path resolution as
  advisory; do not replace the create-new reservation with a check-then-write flow or allow
  FFmpeg's `-y` to overwrite an unrelated file.
- **Ask when done**: compression writes only beneath
  `%TEMP%/vidcord/staged-output` (the platform temp equivalent), then the frontend opens a save
  dialog. `publish_staged_output` canonicalizes and accepts only a direct file child of that staging
  directory, first tries a same-filesystem hard link to a unique temporary path beside the
  destination, falls back to a create-new copy when linking is unavailable, syncs the temporary
  file, atomically publishes it via `settings::replace_file`, and removes the staged file.
  Cancelling the save dialog or failing finalization must call `discard_staged_output`; retain the
  backend validation and partial-file cleanup.

The persisted completion action is either `copy` (default) or `reveal`. Clipboard copy validates
that the output is still a file, then uses CF_HDROP on Windows, AppleScript on macOS, and
`wl-copy`/`xclip` on Linux. A copy failure falls back to revealing the saved file; a completion
action failure must not be reported as a compression failure.

`useSettings` persists `output_destination` (`downloads`, `source`, `ask`, or `custom`), the custom
directory, and `completion_action` (`copy` or `reveal`). Keep the frontend's allowlist validation
when loading these string values; invalid or older persisted values must fall back to safe defaults.

### File-open routing (tricky)

Open-with / right-click → Open must work across three delivery mechanisms:

- **Windows/Linux CLI arg**: handled in `setup()` → stored in `PendingFile`.
- **macOS Apple Events**: `RunEvent::Opened` in the top-level `.run(|app, event| …)` handler — fires after `setup()`, may fire hot or cold.
- **Second instance launched while running**: `tauri_plugin_single_instance::init` focuses the existing window and emits `open-file` directly.

The frontend registers its `open-file` listener and then invokes `frontend_ready`; that command marks the listener ready and drains `PendingFile` under the same mutex used by event delivery. `on_page_load` resets readiness at `PageLoadEvent::Started` so a WebView reload cannot emit into a stale React listener. Do **not** collapse these paths into one — each handles a real race that exists on at least one platform.

### Update downloads

The app checks the fixed `cyroz1/vidcord` GitHub Releases API endpoint and only downloads an
installer after explicit user approval. Preserve all of these controls when changing the updater:

1. Select only the expected `vidcord_` asset suffix for the current OS/architecture and validate
   the asset filename before using it locally.
2. Require GitHub's `sha256:` release-asset digest, hash the response incrementally, and reject
   missing, malformed, or mismatched digests before the file becomes visible or executable.
3. Enforce the 512 MB limit and response completeness while streaming to a create-new temporary
   file; never buffer a full installer in memory.
4. Publish under a collision-safe Downloads filename without replacing an existing file. Keep the
   hard-link path and create-new copy fallback for FAT, exFAT, and network filesystems.
5. Open the installer only after verification and publication, using `spawn_blocking` for the
   platform opener. Remove temporary or partial files on every failure path.

The repository does not configure platform signing credentials. Documentation may say downloads
are verified against GitHub's published SHA-256 digest, but must not claim code signing or
notarization unless the release workflow actually adds and verifies those controls.

### FFmpeg invocations

Every `std::process::Command::new("ffmpeg"|"ffprobe")` in Rust must:

1. Call `configure_ffmpeg_command(&mut cmd)` after setting its arguments and stdio. On Linux this sets `LIBVA_DRIVER_NAME=radeonsi` for AMD systems and removes AppImage-internal `LD_LIBRARY_PATH` entries that would make the system FFmpeg load incompatible bundled libraries.
2. On Windows, set `creation_flags(0x08000000)` (CREATE_NO_WINDOW) to avoid a console flash. The pattern in use:
   ```rust
   #[allow(unused_mut)]
   let mut cmd = std::process::Command::new("ffmpeg");
   cmd.args([…]);
   #[cfg(target_os = "windows")]
   {
       use std::os::windows::process::CommandExt;
       cmd.creation_flags(0x08000000);
   }
   ```
3. Validate any string interpolated into arguments. Encoder names are validated with `c.is_ascii_alphanumeric() || c == '_'` before being passed as `-c:v`; extend that pattern when adding new user-string args.
4. Short discovery/version commands must use `spawn_captured_command()` plus `wait_for_output()` with a finite deadline, output cap, and kill/reap cleanup. Do not use unbounded `.status()` or `.output()` on startup-facing FFmpeg, FFprobe, GPU, or package-manager probes. Long preview/compression jobs keep their existing generation/job cancellation paths instead.

### Caches

- `ENCODER_CACHE` (`src-tauri/src/ffmpeg/encoders.rs`) — memoised encoder list plus the H.264 hardware encoders that passed a bounded one-frame initialization test. Only validated hardware is eligible for first-run auto-selection; listed-but-unusable encoders remain available for an explicit choice. Call `invalidate_encoder_cache()` after a successful FFmpeg install. The frontend also persists the last validated capability list in `encoder_capabilities` so startup can restore it immediately, then refreshes discovery after a quiet idle window that resets while a video probe is active.
- `VAAPI_CACHE` (`src-tauri/src/ffmpeg.rs`) — probes `/dev/dri/renderD*` once per session.
- `PREVIEW_FRAME_CACHE` (`src-tauri/src/ffmpeg.rs`) — 60-entry / 16 MB LRU, keyed by `(path_hash, time_100ms, preview_width, preview_height)`.
- `FFMPEG_AVAIL_CACHE` (`src-tauri/src/commands/encoders.rs`) — 30 s TTL on `ffmpeg`/`ffprobe -version` probes, with `ffmpeg_available_fresh()` for post-install bypass.

On Windows, encoder detection and fresh availability probes also recover a standard WinGet
`Gyan.FFmpeg` install from its portable aliases or package directory and prepend that directory to
the current process PATH. This handles PATH registry updates that cannot propagate into an already
running vidcord process. Keep the lookup constrained to WinGet roots and require both
`ffmpeg.exe` and `ffprobe.exe` before using a directory.

Call `clear_preview_caches()` when the frontend loads a new file (already done in `probe`).
FFprobe child PIDs have a separate generation token and a six-second deadline. Starting a newer
import must terminate the older probe so stale metadata work cannot consume the full timeout.
Preview FFmpeg child PIDs are tracked by a generation token. Call `cancel_preview_jobs()` before
starting work that should supersede previews; `probe` and `compress_video` already do this, and the
frontend invokes `cancel_preview_generation` when the preview unmounts.
Preview frame and filmstrip IPC accepts optional preview dimensions; the backend clamps them to even values before building FFmpeg scale filters. Filmstrips are a fallback: they start after the first exact frame on Linux or when native media preview loading fails, decode keyframes into at most 30 lower-resolution frames (eight for videos of 3+ minutes), and are skipped when direct seeking works. If a source has too few keyframes, scrubbing continues requesting exact frames instead of relying on the sparse strip. Videos of 3+ minutes use sparse seeks for filmstrip generation instead of a dense single-pass `fps` filter. Preview frame, filmstrip, and generated-clip commands have bounded deadlines and output sizes. A failed hardware preview decode disables further hardware-decode attempts for that imported source. Generated preview clips are bounded to a short playhead-relative window, try platform H.264 hardware encoders first, then fall back through software `libx264`. Generated clips are not cached in Rust because returning cached owned IPC bytes requires another large copy; the frontend retains and revokes one Blob URL keyed by import generation, path, and clip range instead.
The frontend keeps only the newest fallback-frame target and actively cancels an older in-flight preview generation before launching it; preserve that cancellation handshake so slow stale seeks cannot block the released scrub position.

### Settings

`settings.rs` deserializes into a typed `Settings` struct and re-serializes to drop unknown keys — this silently migrates away from removed fields. When adding a field:

1. Add an `Option<T>` field to `Settings` (always optional for forward/backward compatibility).
2. Read it in the frontend's `useSettings.ts`.
3. Call `saveSettings({ your_key: … })`; writes are debounced 250 ms and flushed on unmount.

Persisted to `~/.local/share/vidcord/settings.json` (Linux), `~/Library/Application Support/vidcord/settings.json` (macOS), or `%LOCALAPPDATA%\vidcord\settings.json` (Windows) via `dirs::data_local_dir()`.
Writes use a flushed temporary file plus atomic replacement. Windows must use `MoveFileExW` with replace/write-through flags because `std::fs::rename` cannot replace an existing destination there; do not regress repeated settings saves to a plain rename.

### Native window theme

`main.tsx` watches `prefers-color-scheme` and invokes `sync_native_window_theme`. The command is a
no-op outside macOS; on macOS it sets the native `NSWindow` background behind the transparent title
bar. Its light/dark RGB values must stay aligned with the corresponding opaque `--bg` values in
`src/index.css`, or the title bar and web content visibly split at the seam.

### Frontend performance conventions

The app re-renders on every trim-slider move. Established patterns:

- **Module-scope style objects** in components (`PreviewPane`, `Toast`, `ProgressSection`) — do not re-create `React.CSSProperties` literals per render.
- **`memo()`** on leaf components that receive many prop updates.
- **Refs for callbacks** when a hook needs an empty dependency array but must call the latest version of a caller-provided function (see `useEncoders`, `loadVideoRef` pattern in `App.tsx`).
- **`useMemo`/`useCallback`** on anything used by the trim timeline.
- The import/settings subtree is memoized behind an explicit dependency list so trim-only updates do not rebuild it. Keep that dependency list complete when adding values captured by the subtree render callback.
- **Playhead updates** come from the `<video>` element's `timeupdate` event via `onTimeUpdate`, not a `setInterval`. The callback updates the compositor-owned playhead transform through a ref; only derived button-enabled booleans enter React state.

## Coding conventions

### TypeScript / React

- Prettier: double quotes, 2-space indent, semicolons, 100-column print width, ES5 trailing commas.
- Text source files are normalized to LF by `.gitattributes` so Prettier checks behave consistently on Windows and CI.
- Strict TS — no `any` without a `// eslint-disable-next-line @typescript-eslint/no-explicit-any` and a reason.
- Unused args must be prefixed with `_` (see `useCompression.ts`'s `_onToast`).
- No comment churn for removed code — delete it. Don't add "// removed" breadcrumbs.

### Rust

- `rustfmt` default config; CI runs `cargo fmt --check`.
- Prefer `OnceLock<Mutex<…>>` over `lazy_static` / `once_cell` — the codebase uses stdlib sync primitives exclusively.
- When locking a mutex that might be poisoned by a previous panic: `.lock().unwrap_or_else(|e| e.into_inner())`. This pattern is used consistently for cache mutexes; keep it.
- Platform-specific code goes behind `#[cfg(target_os = "…")]`. The Linux env setup in `lib.rs::run()` sets a dozen GTK/GIO/Wayland shims — do not reorder or remove without replicating on every DE listed in comments (KDE Plasma, LXQt, Sway, Hyprland).
- Logging: call `vidcord_log("…")` (writes to the rotating log). Never log `PATH` or `SHELL` — they can contain sensitive substrings.

### Commits / PRs

- **Branching and worktree strategy**: Only perform development work for an active WIP release
  from a branch named exactly `X.Y` (for example, `7.1`). The checked-out worktree must contain a
  top-level `## WIP` section in `CHANGELOG.md`. Do not develop on `main`, a detached HEAD,
  `feature/...`, or `vX.Y` branches. Before editing, verify both the branch name and WIP changelog;
  if either check fails, stop and ask the user to switch to or create the appropriate `X.Y`
  branch/worktree. Merge the completed `X.Y` branch into `main` only after all quality gates pass
  and version references are aligned. This prevents WIP commits from triggering automated website
  deployments (`site/`) or breaking `main`.
- **Run the relevant quality gates before every commit.** If Rust changed: `cargo fmt --check --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml --tests -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`. If frontend changed: `npm run lint`, `npm run typecheck`, `npm test`. Fix failures before committing — never push and let CI catch it.
- Document significant changes where future users and agents will look for them. Update `AGENTS.md` for workflow, architecture, release, or repository-practice changes; update `README.md` for public product behavior, install/setup, supported-platform, or development changes; and update the website (`site/index.html`, JSON-LD, `llms.txt`, `llms-full.txt`, and related site assets) when public-facing product facts or download behavior change.
- Keep a WIP changelog in `CHANGELOG.md` for user-visible changes made after the commit of the last release. Use the latest `vX.Y` tag as the baseline, keep notes concise and release-note-ready, and exclude pure refactors, tests, chores, or internal-only work unless they affect behavior.
- Don't bump the version casually. A version bump implies a release; only do it when explicitly requested. Follow the "Bumping the version" steps below — partial bumps cause CI/release mismatches.
- Add CHANGELOG entries under a new `## vX.Y` heading — the release workflow extracts that section as the GitHub release body.

### Bumping the version

When the user asks to change the version, update **every** reference in one commit so semver and `vX.Y` references stay aligned. There is no single source of truth — these all need to match:

1. **Packaging / source**:
   - `package.json` (`version`, full semver)
   - `package-lock.json` (run `npm install` after editing `package.json` so the lockfile picks up the new version — don't hand-edit)
   - `src-tauri/Cargo.toml` (`version`, full semver)
   - `src-tauri/Cargo.lock` (run `cargo check --manifest-path src-tauri/Cargo.toml` so the lockfile updates)
   - `src-tauri/tauri.conf.json` (`version`, full semver)
2. **Source code**: grep for the **previous** full semver and `vX.Y` short form across the repo (`README.md`, `src/**`, `src-tauri/src/**`, docs). Update inline copy and any hard-coded version strings that declare or display the current app version. The frontend's `DISPLAY_VERSION` is derived from `package.json` and does not need a manual edit. **Skip** test fixtures that use semver strings as arbitrary inputs (e.g. `src-tauri/src/commands/updates.rs` semver-comparison tests) — those exercise comparison invariants, not the current version.
3. **Verify**: run `npm run version:check`, then `git grep -E "<old-semver>|v<old-major>\.<old-minor>"` should return zero hits before committing (excluding `Cargo.lock`/`package-lock.json` entries for unrelated dependencies that share the version string — read each match before assuming).
4. Run the relevant quality gates (above) before committing.

### Tagging and pushing a release

When the user asks to tag and push `vX.Y`:

1. **Confirm version alignment**: every reference listed under "Bumping the version" must already match the requested version. If anything lags, fix it in a preparatory commit first — never tag a tree where the source disagrees with the tag.
2. **Update `CHANGELOG.md`**: convert the WIP notes into a `## vX.Y` section at the top with all user-visible changes since the previous tag. Cross-check against `git log <previous-tag>..HEAD --no-merges --pretty=format:"%s"` and rewrite as user-facing release notes (drop refactor/chore/test-only commits unless they affect behaviour). The release workflow extracts this section verbatim as the GitHub release body, so it is the public changelog.
3. **Commit** the CHANGELOG (and any version edits, if step 1 needed them) on the matching `X.Y`
   branch.
4. **Tag with the `vX.Y` short form** (matching existing tags — see `git tag --list`): `git tag vX.Y`. Do **not** use `vX.Y.Z` — the existing tag history is short-form and the release workflow's CHANGELOG extraction matches `## vX.Y`.
5. **Merge and push** the release commit to `main`, then push the tag: `git push origin main` followed
   by `git push origin vX.Y`. Pushing the tag triggers the release workflow (`build.yml` →
   `release` job), which builds the `release` profile and drafts a GitHub release.
6. **Start the next changelog on the next version branch**: create or switch to the next planned
   `X.Y` branch/worktree, add a fresh `## WIP` section at the top of `CHANGELOG.md`, commit it as
   the first post-release commit, and push that version branch. Do not put the new WIP commit
   directly on `main`. If the next version is not established, ask the user before creating it.

Confirm with the user before pushing the tag — tag pushes are hard to reverse and trigger the public release pipeline.

## CI reference

`.github/workflows/build.yml` has five jobs:

1. **frontend** (ubuntu-latest) — `npm ci`, audit (high), version and asset checks, lint, typecheck, test, build, and bundle-size budget; uploads `dist/` as an artifact for every platform matrix job to download.
2. **rust-lint** (ubuntu-latest) — `cargo fmt --check` + `cargo audit`. Fast, runs in parallel.
3. **rust-compile-checks** (ubuntu-22.04) — `cargo clippy -D warnings` + `cargo test`. Shares the `rust-linux-ubuntu-22.04-v1` `Swatinem/rust-cache` key with the Linux x86_64 build job for registry/source data and any profile-compatible artifacts.
4. **build** (5-way matrix) — Windows x86_64/aarch64, macOS universal, Linux x86_64/aarch64. Tagged `v*` refs use `release` profile; everything else uses `ci` profile.
5. **release** (ubuntu-latest, only on tags) — extracts the matching CHANGELOG section, downloads artifacts, creates a draft GitHub release.

The app workflow ignores `README.md`, `CHANGELOG.md`, `.gitignore`, `site/**`, `wrangler.jsonc`,
the Site Checks workflow, and the site-only sitemap/structured-data validators. Site changes run the
separate Site Checks workflow.

## Known pitfalls

- `npm audit` is run in CI; new high-severity advisories fail non-PR builds. Add a frontend advisory to an ignore-list only when upstream is the blocker.
- Rust audit ignores live in `src-tauri/.cargo/audit.toml` and are almost all Tauri/GTK transitives. If a new advisory appears for code we actually control, fix it.
- The Tauri window is opaque (`transparent: false`), while inner app surfaces still use glass-style translucency. Keep `--bg` fully opaque so WebView/Desktop compositor quirks cannot bleed through.
- `convertFileSrc` is required for local file URLs in the video preview; paths fed directly to `<video src>` will fail under the asset-protocol CSP. The CSP lives in `src-tauri/tauri.conf.json` → `app.security.csp`.
- Linux live `<video>` scrubbing and Play/Stop trim controls are deliberately disabled because WebKitGTK's GStreamer playback path can crash the renderer on systems without a usable audio sink. Keep the `get_os` guard and FFmpeg-generated filmstrip/frame fallback unless live playback is validated across the supported Linux desktop environments and AppImage packaging.
- CSP also gates drive roots on Windows (`C:/**` … `Z:/**`). If a user reports a path refused by the asset protocol, check `assetProtocol.scope`.
- EncodersDialog is `React.lazy` + `Suspense` — don't import it eagerly in `App.tsx`, that re-grows the entry bundle.
- Tests run in a **Node** environment, and the Tauri runtime APIs are mocked in `src/__mocks__/@tauri-apps/api/*`. Write tests against pure helpers (`useCompression.ts`, `ffmpegErrors.ts`, `previewScrub.ts`, `timelineZoom.ts`, `videoMetadata.ts`) or as Rust unit tests. Component integration tests are not currently wired up; don't invent a jsdom setup unless asked.
