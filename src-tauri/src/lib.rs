use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub mod commands;
mod ffmpeg;
mod gpu;
mod log;
mod settings;

use commands::compression::{cancel_compression, compress_video, get_preview_frame, probe};
use commands::encoders::{
    check_ffmpeg_available, detect_encoders, get_vaapi_device, list_ffmpeg_video_encoders,
};
use commands::files::{resolve_output_path, show_in_file_explorer, PendingFile};
use commands::updates::check_for_updates;
use log::vidcord_log;
use settings::SettingsManager;

// Tracks whether the WebView has fully loaded and React has had time to mount.
// Used to decide whether RunEvent::Opened should emit directly or defer to on_page_load.
struct WebviewReady(AtomicBool);

// ---------------------------------------------------------------------------
// Tauri commands — settings
// ---------------------------------------------------------------------------

#[tauri::command]
fn load_settings() -> serde_json::Value {
    SettingsManager::load()
}

#[tauri::command]
fn save_settings(settings: serde_json::Value) -> Result<(), String> {
    SettingsManager::save(&settings).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
                if let Some(win) = app.get_webview_window("main") {
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        let _ = win.emit("open-file", &path);
                    });
                }
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingFile(Mutex::new(None)))
        .manage(WebviewReady(AtomicBool::new(false)))
        .on_page_load(|webview, payload| {
            // PageLoadEvent::Finished fires once the WebView has fully loaded the app.
            // We wait 200ms for React to mount and register its open-file listener,
            // then emit any file path that arrived before the frontend was ready.
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let handle = webview.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    handle
                        .state::<WebviewReady>()
                        .0
                        .store(true, Ordering::SeqCst);
                    if let Ok(mut guard) = handle.state::<PendingFile>().0.lock() {
                        if let Some(path) = guard.take() {
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.emit("open-file", &path);
                            }
                        }
                    }
                });
            }
        })
        .setup(|app| {
            // Handle CLI file argument: `vidcord myfile.mp4`
            let args: Vec<String> = std::env::args().collect();
            vidcord_log(&format!("Startup args: {:?}", args));
            if args.len() > 1 {
                let path = args[1].clone();
                // Filter out macOS -psn_* pseudo-args and flag args
                if !path.starts_with('-') && std::path::Path::new(&path).exists() {
                    vidcord_log(&format!("Received open-file path: {path}"));
                    if let Ok(mut guard) = app.state::<PendingFile>().0.lock() {
                        *guard = Some(path);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            probe,
            get_preview_frame,
            detect_encoders,
            check_ffmpeg_available,
            list_ffmpeg_video_encoders,
            compress_video,
            cancel_compression,
            check_for_updates,
            show_in_file_explorer,
            get_vaapi_device,
            resolve_output_path,
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
                    if app_handle.state::<WebviewReady>().0.load(Ordering::SeqCst) {
                        // App already running — frontend listener is active, emit directly.
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let _ = win.emit("open-file", &path_str);
                        }
                    } else {
                        // Cold launch — store for on_page_load to emit once React is ready.
                        if let Ok(mut guard) = app_handle.state::<PendingFile>().0.lock() {
                            *guard = Some(path_str);
                        }
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app_handle, event);
        });
}
