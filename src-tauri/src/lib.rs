use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{webview::PageLoadEvent, AppHandle, Emitter, Manager};
use tauri_plugin_window_state::StateFlags;

pub mod commands;
#[cfg(target_os = "linux")]
mod desktop_integration;
mod ffmpeg;
mod gpu;
mod log;
mod preview_source;
mod settings;

use commands::app::exit_app;
use commands::compression::{
    cancel_compression, cancel_lossless_trim_probe, compress_batch, compress_video,
    get_lossless_trim_info, probe, probe_batch,
};
use commands::encoders::{
    check_ffmpeg_available, detect_encoders, get_vaapi_device, install_ffmpeg_dependency,
    list_ffmpeg_video_encoders,
};
use commands::feedback::{collect_bug_report, delete_bug_report};
use commands::files::{
    copy_file_to_clipboard, copy_files_to_clipboard, discard_staged_output, expand_import_paths,
    get_os, publish_batch_staged_outputs, publish_staged_output, resolve_batch_output_paths,
    resolve_output_path, resolve_staging_output_path, save_snapshot_image,
    send_system_notification, show_files_in_file_explorer, show_in_file_explorer, PendingFile,
};
use commands::updates::{
    check_for_updates, download_and_open_update_installer, sweep_stale_update_downloads,
};
use log::vidcord_log;
use settings::SettingsManager;

// Tracks whether React has registered its open-file listener.
// Used to decide whether file-open events can emit immediately or need deferral.
struct WebviewReady(AtomicBool);

struct StartupTiming {
    started_at: Instant,
    logged_frontend_ready: AtomicBool,
}

#[cfg(test)]
mod tests {
    use super::{append_pending_files, existing_open_path, existing_open_paths_with_cwd};

    #[test]
    fn open_paths_resolve_relative_to_the_supplied_cwd() {
        let dir = std::env::temp_dir().join(format!("vidcord-open-paths-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip.mp4");
        std::fs::write(&file, b"x").unwrap();
        let absolute = file.to_string_lossy().into_owned();
        let url = url::Url::from_file_path(&file).unwrap().to_string();

        let resolved = existing_open_paths_with_cwd(
            vec![
                "clip.mp4".to_string(),
                absolute.clone(),
                url,
                "--flag".to_string(),
                "missing.mp4".to_string(),
            ],
            &dir,
        );
        // The relative path resolves against the supplied cwd, the
        // absolute path passes through, the file: URL is decoded without
        // being joined to the cwd, and flags and missing files drop out.
        assert_eq!(resolved, vec![absolute.clone(), absolute.clone(), absolute]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pending_open_files_are_merged_before_frontend_ready() {
        let mut pending = None;
        append_pending_files(&mut pending, vec!["one.mp4".to_string()]);
        append_pending_files(
            &mut pending,
            vec!["two.mp4".to_string(), "three.mp4".to_string()],
        );
        assert_eq!(
            pending,
            Some(vec![
                "one.mp4".to_string(),
                "two.mp4".to_string(),
                "three.mp4".to_string()
            ])
        );
    }

    #[test]
    fn open_paths_accept_plain_paths_and_file_urls_only_when_they_exist() {
        let path =
            std::env::temp_dir().join(format!("vidcord-open-path-test-{}.mp4", std::process::id()));
        std::fs::write(&path, b"video").unwrap();
        let plain = path.to_string_lossy().into_owned();
        assert_eq!(existing_open_path(&plain), Some(plain.clone()));
        let parsed_url = url::Url::from_file_path(&path).unwrap();
        let url = parsed_url.to_string();
        assert_eq!(existing_open_path(&url), Some(plain.clone()));
        // The single-slash file:/ form parses as the same file URL. The
        // URL path component supplies the leading slash on every platform.
        let single_slash = format!("file:{}", parsed_url.path());
        assert_eq!(existing_open_path(&single_slash), Some(plain));
        assert_eq!(existing_open_path("--flag"), None);
        assert_eq!(
            existing_open_path("/definitely/not/a/real/vidcord-file.mp4"),
            None
        );
        assert_eq!(existing_open_path("file:///definitely/not/real.mp4"), None);
        std::fs::remove_file(path).ok();
    }
}

fn append_pending_files(pending: &mut Option<Vec<String>>, paths: Vec<String>) {
    if let Some(existing) = pending {
        existing.extend(paths);
    } else {
        *pending = Some(paths);
    }
}

fn existing_open_path(argument: &str) -> Option<String> {
    if argument.starts_with('-') {
        return None;
    }

    // Only file-URL arguments need URL parsing; everything else is a plain
    // filesystem path and goes straight to PathBuf. Both the `file://` form
    // file managers emit and the single-slash `file:/path` form count:
    // `Url::parse` handles both, and silently treating the latter as a
    // literal path would drop a valid open-file argument.
    let is_file_url = argument
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
        && argument.as_bytes().get(5) == Some(&b'/');
    let path = if is_file_url {
        match url::Url::parse(argument) {
            Ok(url) if url.scheme() == "file" => url.to_file_path().ok()?,
            _ => return None,
        }
    } else {
        std::path::PathBuf::from(argument)
    };

    path.exists().then(|| path.to_string_lossy().into_owned())
}

fn existing_open_paths(arguments: impl IntoIterator<Item = String>) -> Vec<String> {
    arguments
        .into_iter()
        .filter_map(|argument| existing_open_path(&argument))
        .collect()
}

/// Like `existing_open_paths`, but relative plain paths resolve against
/// `cwd` instead of this process's working directory. The single-instance
/// route needs it: a second instance launched from another directory
/// passes paths relative to its own cwd, and checking them against the
/// running process's cwd would drop the open or hit a same-named file.
fn existing_open_paths_with_cwd(
    arguments: impl IntoIterator<Item = String>,
    cwd: &std::path::Path,
) -> Vec<String> {
    arguments
        .into_iter()
        .filter_map(|argument| {
            let path = std::path::PathBuf::from(&argument);
            let is_file_url = argument
                .get(..5)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"));
            if !path.is_absolute() && !is_file_url && !argument.starts_with('-') {
                existing_open_path(&cwd.join(path).to_string_lossy())
            } else {
                existing_open_path(&argument)
            }
        })
        .collect()
}

/// Grant the runtime asset-protocol scope for user-selected open paths.
///
/// The static scope in `tauri.conf.json` no longer pre-authorises broad
/// filesystem patterns, so every route that delivers a user-selected path
/// to the frontend must grant it here first, before the path can reach
/// preview (the Linux loopback server in `preview_source.rs` validates the
/// same scope with `is_allowed`). Files are granted individually; folders
/// are granted recursively so the files a folder import expands to are
/// covered. Grants are process-lifetime and idempotent.
fn grant_asset_protocol_scope(app: &AppHandle, paths: &[String]) {
    let scope = app.asset_protocol_scope();
    for path in paths {
        let path = std::path::Path::new(path);
        let result = if path.is_dir() {
            scope.allow_directory(path, true)
        } else {
            scope.allow_file(path)
        };
        if result.is_err() {
            vidcord_log("Asset scope: could not grant access to an opened file or folder");
        }
    }
}

fn emit_or_defer_open_files(app: &AppHandle, paths: Vec<String>) {
    // Grant before any emit/defer: the frontend may start a preview as soon
    // as it receives these paths (or as soon as `frontend_ready` drains the
    // deferred copies), and preview validates the runtime scope.
    grant_asset_protocol_scope(app, &paths);
    // The pending-file mutex is also the readiness-transition gate. Holding it
    // through the readiness check and emit linearizes file-open delivery with a
    // page reload's Started event, when the old React listener is torn down.
    let pending_file = app.state::<PendingFile>();
    let mut pending = pending_file.0.lock().unwrap_or_else(|e| e.into_inner());
    if app.state::<WebviewReady>().0.load(Ordering::Acquire) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.emit("open-file", &paths);
        }
    } else {
        append_pending_files(&mut pending, paths);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — settings
// ---------------------------------------------------------------------------

#[tauri::command]
async fn load_settings() -> serde_json::Value {
    tokio::task::spawn_blocking(SettingsManager::load)
        .await
        .unwrap_or_else(|_| serde_json::json!({}))
}

#[tauri::command]
async fn save_settings(settings: serde_json::Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || SettingsManager::save(&settings).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn frontend_ready(app: AppHandle) {
    let timing = app.state::<StartupTiming>();
    if !timing.logged_frontend_ready.swap(true, Ordering::AcqRel) {
        vidcord_log(&format!(
            "Startup: frontend ready in {} ms",
            timing.started_at.elapsed().as_millis()
        ));
    }

    let pending_file = app.state::<PendingFile>();
    let mut pending = pending_file.0.lock().unwrap_or_else(|e| e.into_inner());
    app.state::<WebviewReady>().0.store(true, Ordering::Release);
    if let Some(paths) = pending.take() {
        // The routes that queued these paths already granted them (CLI args
        // in setup(), and emit_or_defer_open_files for the rest); grant
        // again here as the last point before delivery so the drain itself
        // never depends on how a path arrived. Grants are idempotent.
        grant_asset_protocol_scope(&app, &paths);
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.emit("open-file", &paths);
        }
    }
}

#[tauri::command]
fn sync_native_window_theme(app: AppHandle, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window is unavailable".to_string())?;
        window
            .with_webview(move |webview| unsafe {
                use objc2_app_kit::{NSColor, NSWindow};

                // The transparent title bar exposes the NSWindow background. Keep
                // these colors aligned with the light/dark --bg values in index.css.
                let background = if dark {
                    NSColor::colorWithSRGBRed_green_blue_alpha(
                        16.0 / 255.0,
                        16.0 / 255.0,
                        20.0 / 255.0,
                        1.0,
                    )
                } else {
                    NSColor::colorWithSRGBRed_green_blue_alpha(
                        236.0 / 255.0,
                        236.0 / 255.0,
                        240.0 / 255.0,
                        1.0,
                    )
                };
                let window: &NSWindow = &*webview.ns_window().cast();
                window.setBackgroundColor(Some(&background));
            })
            .map_err(|error| error.to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, dark);

    Ok(())
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let startup_started_at = Instant::now();
    log::setup_crash_log();

    #[cfg(target_os = "linux")]
    {
        // Prevent GTK from loading system GVfs/GIO modules that may be compiled
        // against a different GLib version (common on Debian/LXQt), causing
        // "undefined symbol" errors and potential startup failures.
        if std::env::var("GIO_USE_VFS").is_err() {
            std::env::set_var("GIO_USE_VFS", "local");
        }

        // Disable WebKitGTK's DMABUF renderer. On KDE Plasma, DMA-BUF frame
        // sharing between WebKit and the KWin compositor can fail silently on
        // many GPU/driver combinations, leaving a white/blank window.
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }

        // Desktop environments (KDE Plasma, LXQt, etc.) inject their own GTK
        // integration modules via GTK_MODULES, but those modules are not present
        // inside the AppImage bundle and will fail to load. Always clear this
        // variable so GTK doesn't attempt to load them.
        if std::env::var("GTK_MODULES").map_or(true, |v| !v.is_empty()) {
            std::env::set_var("GTK_MODULES", "");
        }

        // Disable the AT-SPI accessibility bridge. On LXQt and other lightweight
        // DEs, the AT-SPI2 daemon may not be running or may use an incompatible
        // protocol version, causing "get_device_events_reply: unknown signature"
        // warnings and GLib-GObject-CRITICAL assertion failures at startup.
        if std::env::var("NO_AT_BRIDGE").is_err() {
            std::env::set_var("NO_AT_BRIDGE", "1");
        }

        // Use an in-memory GSettings backend instead of dconf. Without this,
        // GIO attempts to load libdconfsettings.so from the system's GIO module
        // directory; on systems where that module was compiled against a newer
        // GLib than the one bundled in the AppImage it fails with an
        // "undefined symbol" error.
        if std::env::var("GSETTINGS_BACKEND").is_err() {
            std::env::set_var("GSETTINGS_BACKEND", "memory");
        }

        // Prevent GIO (and GStreamer's GIO plugin scanner) from loading system
        // GIO modules such as libgvfsdbus.so and libgioremote-volume-monitor.so.
        // These modules are frequently compiled against a newer GLib than the one
        // available on older distros and fail with "undefined symbol" errors.
        // Pointing GIO_MODULE_DIR at an empty path disables the scan entirely.
        if std::env::var("GIO_MODULE_DIR").is_err() {
            std::env::set_var("GIO_MODULE_DIR", "");
        }

        // On Wayland-only compositors (Sway, Hyprland with XWayland disabled),
        // DISPLAY is unset. Without an explicit hint GTK3 may attempt the X11
        // backend and crash. Set GDK_BACKEND=wayland so GTK connects to the
        // Wayland socket directly.
        if std::env::var("WAYLAND_DISPLAY").is_ok()
            && std::env::var("DISPLAY").is_err()
            && std::env::var("GDK_BACKEND").is_err()
        {
            std::env::set_var("GDK_BACKEND", "wayland");
        }

        // Ensure XDG_RUNTIME_DIR is set. GTK, D-Bus, and the Wayland display
        // socket all rely on this directory. Lightweight WM sessions started
        // from ~/.xinitrc or a bare TTY login often skip the login manager that
        // would normally export it.
        if std::env::var("XDG_RUNTIME_DIR").is_err() {
            let uid = unsafe { libc::getuid() };
            std::env::set_var("XDG_RUNTIME_DIR", format!("/run/user/{uid}"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(path) = std::env::var("PATH") {
            let mut new_path = path;
            if !new_path.contains("/usr/local/bin") {
                new_path = format!("{new_path}:/usr/local/bin");
            }
            if !new_path.contains("/opt/homebrew/bin") {
                new_path = format!("{new_path}:/opt/homebrew/bin");
            }
            std::env::set_var("PATH", new_path);
        } else {
            std::env::set_var(
                "PATH",
                "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
            );
        }
    }

    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // A second instance was launched — focus the existing window.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            // If the second instance was opened with a file (e.g. right-click → Open With),
            // forward that file path to the already-running frontend.
            let paths =
                existing_open_paths_with_cwd(argv.into_iter().skip(1), std::path::Path::new(&cwd));
            if !paths.is_empty() {
                vidcord_log(&format!(
                    "Single-instance: forwarding {} file(s) from second instance",
                    paths.len()
                ));
                emit_or_defer_open_files(app, paths);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    let builder = builder
        .manage(PendingFile(Mutex::new(None)))
        .manage(WebviewReady(AtomicBool::new(false)))
        .manage(StartupTiming {
            started_at: startup_started_at,
            logged_frontend_ready: AtomicBool::new(false),
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Started {
                // A reload destroys the current React listener. Reset readiness
                // before accepting more OS file-open events; the new frontend
                // will mark itself ready after its replacement listener exists.
                {
                    let pending_file = webview.state::<PendingFile>();
                    let _pending = pending_file.0.lock().unwrap_or_else(|e| e.into_inner());
                    webview
                        .state::<WebviewReady>()
                        .0
                        .store(false, Ordering::Release);
                }
                // The old page's preview URLs are dead after a reload; drop
                // their registrations so leaked slots cannot accumulate.
                preview_source::clear_preview_sources();
            }
        })
        .setup(move |app| {
            // Remove partial update downloads left behind by a process that
            // was killed before its cleanup guard could run. PID-liveness
            // checks keep a download in progress in another instance safe;
            // keep the directory scans off the startup path.
            if let Err(error) = std::thread::Builder::new()
                .name("vidcord-update-cleanup".to_string())
                .spawn(sweep_stale_update_downloads)
            {
                vidcord_log(&format!(
                    "Could not start the stale update download cleanup: {error}"
                ));
            }

            // AppImage folder Open With registration scans and writes desktop
            // files; keep that filesystem work off the startup path and run
            // it in the background after setup.
            #[cfg(target_os = "linux")]
            if std::env::var_os("APPIMAGE").is_some() {
                if let Err(error) = std::thread::Builder::new()
                    .name("vidcord-appimage-registration".to_string())
                    .spawn(desktop_integration::register_appimage_folder_open_with)
                {
                    vidcord_log(&format!(
                        "Could not start AppImage folder Open With registration: {error}"
                    ));
                }
            }

            // Handle CLI file argument: `vidcord myfile.mp4`
            // File managers may pass local files as `file://` URLs; normalize
            // those while retaining every selected path for batch mode.
            let paths = existing_open_paths(std::env::args().skip(1));
            if !paths.is_empty() {
                vidcord_log(&format!("Received {} open-file path(s)", paths.len()));
                // Grant the runtime asset scope before these are stored as
                // pending: the frontend_ready drain emits them straight to
                // the frontend, which may immediately request a preview.
                grant_asset_protocol_scope(app.handle(), &paths);
                *app.state::<PendingFile>()
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(paths);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            exit_app,
            frontend_ready,
            sync_native_window_theme,
            probe,
            probe_batch,
            preview_source::prepare_preview_source,
            preview_source::release_preview_source,
            get_lossless_trim_info,
            cancel_lossless_trim_probe,
            detect_encoders,
            check_ffmpeg_available,
            install_ffmpeg_dependency,
            list_ffmpeg_video_encoders,
            compress_video,
            compress_batch,
            cancel_compression,
            check_for_updates,
            download_and_open_update_installer,
            expand_import_paths,
            show_files_in_file_explorer,
            show_in_file_explorer,
            copy_file_to_clipboard,
            copy_files_to_clipboard,
            get_vaapi_device,
            resolve_output_path,
            resolve_staging_output_path,
            resolve_batch_output_paths,
            publish_staged_output,
            publish_batch_staged_outputs,
            discard_staged_output,
            save_snapshot_image,
            get_os,
            send_system_notification,
            collect_bug_report,
            delete_bug_report,
        ]);

    // A build failure must reach the log file: with panic = "abort" an expect()
    // message is invisible, especially in the Windows GUI subsystem.
    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            vidcord_log(&format!(
                "Startup: failed to build the Tauri application: {error}"
            ));
            log::flush_log();
            std::process::exit(1);
        }
    };
    app.run(|app_handle, event| {
        // macOS Finder "Open with" delivers files via Apple Events, not CLI args.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths = urls
                .into_iter()
                .filter_map(|u: url::Url| u.to_file_path().ok())
                .map(|path| path.to_string_lossy().to_string())
                .collect::<Vec<_>>();
            if !paths.is_empty() {
                vidcord_log(&format!("Received {} open-file path(s)", paths.len()));
                emit_or_defer_open_files(app_handle, paths);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app_handle, event);
    });
}
