use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{webview::PageLoadEvent, AppHandle, Emitter, Manager};
use tauri_plugin_window_state::StateFlags;

pub mod commands;
mod ffmpeg;
mod gpu;
mod log;
mod settings;

use commands::compression::{
    cancel_compression, cancel_lossless_trim_probe, cancel_preview_frame_generation,
    cancel_preview_generation, capture_snapshot, compress_video, get_filmstrip,
    get_lossless_trim_info, get_preview_clip, get_preview_frame, probe,
};
use commands::encoders::{
    check_ffmpeg_available, detect_encoders, get_vaapi_device, install_ffmpeg_dependency,
    list_ffmpeg_video_encoders,
};
use commands::files::{
    copy_file_to_clipboard, discard_staged_output, get_os, publish_staged_output,
    resolve_output_path, resolve_staging_output_path, send_system_notification,
    show_in_file_explorer, PendingFile,
};
use commands::updates::{check_for_updates, download_and_open_update_installer};
use log::vidcord_log;
use settings::SettingsManager;

// Tracks whether React has registered its open-file listener.
// Used to decide whether file-open events can emit immediately or need deferral.
struct WebviewReady(AtomicBool);

struct StartupTiming {
    started_at: Instant,
    logged_frontend_ready: AtomicBool,
}

fn emit_or_defer_open_file(app: &AppHandle, path: String) {
    // The pending-file mutex is also the readiness-transition gate. Holding it
    // through the readiness check and emit linearizes file-open delivery with a
    // page reload's Started event, when the old React listener is torn down.
    let pending_file = app.state::<PendingFile>();
    let mut pending = pending_file.0.lock().unwrap_or_else(|e| e.into_inner());
    if app.state::<WebviewReady>().0.load(Ordering::Acquire) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.emit("open-file", &path);
        }
    } else {
        *pending = Some(path);
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
    if let Some(path) = pending.take() {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.emit("open-file", &path);
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

    tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second instance was launched — focus the existing window.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            // If the second instance was opened with a file (e.g. right-click → Open With),
            // forward that file path to the already-running frontend.
            let path = argv
                .into_iter()
                .skip(1)
                .find(|a| !a.starts_with('-') && std::path::Path::new(a).exists());
            if let Some(path) = path {
                vidcord_log(&format!(
                    "Single-instance: forwarding file from second instance: {path}"
                ));
                emit_or_defer_open_file(app, path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
                let pending_file = webview.state::<PendingFile>();
                let _pending = pending_file.0.lock().unwrap_or_else(|e| e.into_inner());
                webview
                    .state::<WebviewReady>()
                    .0
                    .store(false, Ordering::Release);
            }
        })
        .setup(|app| {
            // Handle CLI file argument: `vidcord myfile.mp4`
            // Filter out macOS -psn_* pseudo-args and flag args. Avoid collecting
            // every argument because only the first existing file is actionable.
            let path = std::env::args()
                .skip(1)
                .find(|arg| !arg.starts_with('-') && std::path::Path::new(arg).exists());
            if let Some(path) = path {
                vidcord_log(&format!("Received open-file path: {path}"));
                *app.state::<PendingFile>()
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            frontend_ready,
            sync_native_window_theme,
            probe,
            get_lossless_trim_info,
            get_preview_frame,
            get_preview_clip,
            get_filmstrip,
            cancel_preview_generation,
            cancel_preview_frame_generation,
            cancel_lossless_trim_probe,
            detect_encoders,
            check_ffmpeg_available,
            install_ffmpeg_dependency,
            list_ffmpeg_video_encoders,
            compress_video,
            cancel_compression,
            capture_snapshot,
            check_for_updates,
            download_and_open_update_installer,
            show_in_file_explorer,
            copy_file_to_clipboard,
            get_vaapi_device,
            resolve_output_path,
            resolve_staging_output_path,
            publish_staged_output,
            discard_staged_output,
            get_os,
            send_system_notification,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // macOS Finder "Open with" delivers files via Apple Events, not CLI args.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let first_path = urls
                    .into_iter()
                    .find_map(|u: url::Url| u.to_file_path().ok());
                if let Some(path) = first_path {
                    let path_str = path.to_string_lossy().to_string();
                    vidcord_log(&format!("Received open-file path: {path_str}"));
                    emit_or_defer_open_file(app_handle, path_str);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app_handle, event);
        });
}
