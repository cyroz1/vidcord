# CLAUDE.md

Guidance for AI assistants working in this repository. Read this before making changes.

## Project overview

**vidcord** is a cross-platform desktop app that compresses video files under Discord's size limits. It is built with **Tauri 2** (Rust backend + React/TypeScript frontend) and shells out to the system **FFmpeg** binary for all video work. It does **not** bundle FFmpeg — the system `ffmpeg`/`ffprobe` must be on `PATH`.

- **App version**: `6.1.0` (both `package.json` and `src-tauri/Cargo.toml` should stay in sync)
- **Window**: fixed-size 460×630, non-resizable, transparent (macOS Tahoe "liquid glass" styling)
- **Supported OS/arch**: Windows (x86_64 + aarch64), macOS (universal), Linux (x86_64 + aarch64)
- **Node**: `^20.19.0 || >=22.12.0` (see `package.json` engines)
- **Rust**: stable toolchain, edition 2021

## Repository layout

```
.
├── src/                       # React frontend (TypeScript)
│   ├── App.tsx                # Monolithic root component — wires hooks, UI, trim timeline, compression
│   ├── App.css                # All styling (dark theme + light theme via data-theme)
│   ├── ErrorBoundary.tsx      # Top-level crash recovery UI
│   ├── main.tsx               # ReactDOM entry
│   ├── index.css              # Global CSS vars (--accent, --surface, --blur…)
│   ├── components/
│   │   ├── PreviewPane.tsx    # Video preview + scrub thumbnail + filmstrip
│   │   ├── ProgressSection.tsx# Compression progress bar + ETA
│   │   ├── Toast.tsx          # Single toast row
│   │   └── EncodersDialog.tsx # Lazy-loaded FFmpeg encoder list dialog
│   ├── hooks/
│   │   ├── useCompression.ts  # Event listeners + pure bitrate/dimension helpers (tested)
│   │   ├── useEncoders.ts     # detect_encoders + FFmpeg-missing tracking
│   │   ├── useSettings.ts     # load_settings / debounced save_settings
│   │   └── useToasts.ts       # Toast queue with per-id timer cleanup
│   ├── __tests__/             # Vitest tests (node env, Tauri APIs mocked)
│   └── __mocks__/@tauri-apps/ # Invoke/listen stubs so pure helpers run in Node
├── src-tauri/                 # Rust backend
│   ├── src/
│   │   ├── main.rs            # Thin entry — calls lib::run()
│   │   ├── lib.rs             # Tauri builder, plugins, Linux env shims, file-open routing
│   │   ├── ffmpeg.rs          # probe / preview / filmstrip / encoder detection / VAAPI discovery + caches
│   │   ├── gpu.rs             # Vendor detection (lspci / system_profiler / Get-CimInstance)
│   │   ├── log.rs             # Rotating ~/…/vidcord/vidcord.log (5 MB cap)
│   │   ├── settings.rs        # Typed settings persisted via atomic rename
│   │   └── commands/          # #[tauri::command] handlers
│   │       ├── compression.rs # compress_video, cancel_compression, preview/probe wrappers
│   │       ├── encoders.rs    # detect/install/list FFmpeg; platform install flows
│   │       ├── files.rs       # show_in_file_explorer, resolve_output_path, get_os, PendingFile
│   │       └── updates.rs     # GitHub latest-release checker (semver)
│   ├── capabilities/default.json  # Tauri permissions (dialog, opener, core)
│   ├── tauri.conf.json        # Product config, CSP, file associations, bundle targets
│   ├── Cargo.toml             # release/ci/dev profiles (see "Build profiles")
│   └── .cargo/audit.toml      # RUSTSEC ignore list for Tauri upstream advisories
├── .github/workflows/build.yml# Multi-platform CI + release workflow
├── index.html                 # Vite entry
├── vite.config.ts             # React plugin, manual chunks (react / tauri / app)
├── vitest.config.ts           # Node env + Tauri-api mock aliases
├── eslint.config.js           # ESLint flat config (TS + react-hooks)
├── .prettierrc                # 100-col, 2-space, double-quote, ES5 trailing commas
├── tsconfig.json              # Strict TS, ES2021 target, react-jsx
├── FFMPEG_SETUP.md            # End-user FFmpeg install guide (per platform)
├── CHANGELOG.md               # User-facing release notes
└── README.md                  # Public overview
```

## Development workflows

### Run the app locally

```sh
npm install
npm run tauri dev          # starts Vite on :5173, launches the Tauri window
```

FFmpeg must be on `PATH` for the app to probe videos or compress.

### Quality gates (mirror CI)

```sh
npm run lint               # eslint src
npm run typecheck          # tsc --noEmit
npm test                   # vitest run
npm run format             # prettier --write src
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --tests -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
cargo audit                # in src-tauri/ (respects .cargo/audit.toml)
```

CI treats any clippy warning as an error — keep new Rust code warning-clean.

### Build a release binary

```sh
npm run tauri build        # outputs to src-tauri/target/release/bundle/
```

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
- `compress-progress` — percent, eta, status (emitted per FFmpeg stderr `time=` line)
- `compress-done` — success/cancelled/message/output_path
- `open-file` — path from single-instance forwarding, macOS Apple Events, or CLI args
- `tauri://drag-drop` — built-in Tauri event for drops on the window

### File-open routing (tricky)

Open-with / right-click → Open must work across three delivery mechanisms:
- **Windows/Linux CLI arg**: handled in `setup()` → stored in `PendingFile`.
- **macOS Apple Events**: `RunEvent::Opened` in the top-level `.run(|app, event| …)` handler — fires after `setup()`, may fire hot or cold.
- **Second instance launched while running**: `tauri_plugin_single_instance::init` focuses the existing window and emits `open-file` directly.

The frontend's `open-file` listener may not be registered when the event fires on cold start, so `on_page_load` (200 ms after `PageLoadEvent::Finished`) drains `PendingFile`. Do **not** collapse these paths into one — each handles a real race that exists on at least one platform.

### FFmpeg invocations

Every `std::process::Command::new("ffmpeg"|"ffprobe")` in Rust must:
1. Use `envs(get_ffmpeg_env())` — on Linux this sets `LIBVA_DRIVER_NAME=radeonsi` for AMD systems.
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

### Caches (in `ffmpeg.rs`)

- `ENCODER_CACHE` — memoised encoder list. Call `invalidate_encoder_cache()` after a successful FFmpeg install.
- `VAAPI_CACHE` — probes `/dev/dri/renderD*` once per session.
- `PREVIEW_FRAME_CACHE` — 60-entry LRU, keyed by `(path_hash, time_100ms)`.
- `PREVIEW_CLIP_CACHE` — 100 MB LRU, keyed by `(start_ms, end_ms)`.
- `FFMPEG_AVAIL_CACHE` — 30 s TTL on `ffmpeg -version` probe, with `ffmpeg_available_fresh()` for post-install bypass.

Call `clear_preview_caches()` when the frontend loads a new file (already done in `probe`).

### Settings

`settings.rs` deserializes into a typed `Settings` struct and re-serializes to drop unknown keys — this silently migrates away from removed fields. When adding a field:
1. Add an `Option<T>` field to `Settings` (always optional for forward/backward compatibility).
2. Read it in the frontend's `useSettings.ts`.
3. Call `saveSettings({ your_key: … })`; writes are debounced 250 ms and flushed on unmount.

Persisted to `~/.local/share/vidcord/settings.json` (Linux), `~/Library/Application Support/vidcord/settings.json` (macOS), or `%LOCALAPPDATA%\vidcord\settings.json` (Windows) via `dirs::data_local_dir()`.

### Frontend performance conventions

The app re-renders on every trim-slider move. Established patterns:
- **Module-scope style objects** in components (`PreviewPane`, `Toast`, `ProgressSection`) — do not re-create `React.CSSProperties` literals per render.
- **`memo()`** on leaf components that receive many prop updates.
- **Refs for callbacks** when a hook needs an empty dependency array but must call the latest version of a caller-provided function (see `useEncoders`, `loadVideoRef` pattern in `App.tsx`).
- **`useMemo`/`useCallback`** on anything used by the trim timeline.
- **Playhead updates** come from the `<video>` element's `timeupdate` event via `onTimeUpdate`, not a `setInterval`. A 0.02 s threshold avoids sub-frame re-renders.

## Coding conventions

### TypeScript / React

- Prettier: double quotes, 2-space indent, semicolons, 100-column print width, ES5 trailing commas.
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

- **Run the relevant quality gates before every commit.** If Rust changed: `cargo fmt --check --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml --tests -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`. If frontend changed: `npm run lint`, `npm run typecheck`, `npm test`. Fix failures before committing — never push and let CI catch it.
- Don't bump `version` in `package.json` + `Cargo.toml` + `tauri.conf.json` casually. A version bump implies a release; only do it when explicitly requested.
- Add CHANGELOG entries under a new `## vX.Y` heading — the release workflow extracts that section as the GitHub release body.

## CI reference

`.github/workflows/build.yml` has four jobs:
1. **frontend** (ubuntu-latest) — `npm ci`, audit (high), lint, typecheck, test, build; uploads `dist/` as an artifact for every platform matrix job to download.
2. **rust-lint** (ubuntu-latest) — `cargo fmt --check` + `cargo audit`. Fast, runs in parallel.
3. **rust-compile-checks** (ubuntu-latest) — `cargo clippy -D warnings` + `cargo test`. Shares the `rust-linux` `Swatinem/rust-cache` key with the Linux x86_64 build job.
4. **build** (5-way matrix) — Windows x86_64/aarch64, macOS universal, Linux x86_64/aarch64. Tagged `v*` refs use `release` profile; everything else uses `ci` profile.
5. **release** (ubuntu-latest, only on tags) — extracts the matching CHANGELOG section, downloads artifacts, creates a draft GitHub release.

Changes to `README.md`, `CHANGELOG.md`, `.gitignore`, and `screenshots/**` do not trigger CI.

## Known pitfalls

- `npm audit` is run in CI; new high-severity advisories fail non-PR builds. Add a frontend advisory to an ignore-list only when upstream is the blocker.
- Rust audit ignores live in `src-tauri/.cargo/audit.toml` and are almost all Tauri/GTK transitives. If a new advisory appears for code we actually control, fix it.
- The window is `transparent: true` — new backgrounds must set an explicit opaque colour or the desktop bleeds through.
- `convertFileSrc` is required for local file URLs in the video preview; paths fed directly to `<video src>` will fail under the asset-protocol CSP. The CSP lives in `src-tauri/tauri.conf.json` → `app.security.csp`.
- CSP also gates drive roots on Windows (`C:/**` … `Z:/**`). If a user reports a path refused by the asset protocol, check `assetProtocol.scope`.
- EncodersDialog is `React.lazy` + `Suspense` — don't import it eagerly in `App.tsx`, that re-grows the entry bundle.
- Tests run in a **Node** environment, and the Tauri runtime APIs are mocked in `src/__mocks__/@tauri-apps/api/*`. Write tests against pure helpers (`calculateBitrate`, `computeTargetDimensions`, Rust unit tests). Component integration tests are not currently wired up; don't invent a jsdom setup unless asked.
