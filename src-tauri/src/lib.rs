use std::sync::Mutex;
use tauri::Manager;

mod settings;
mod ffmpeg;
mod gpu;
mod log;
pub mod commands;

use settings::SettingsManager;
use commands::compression::{
    compress_video, cancel_compression, probe, get_preview_frame,
};
use commands::encoders::{
    detect_encoders, check_ffmpeg_available, list_ffmpeg_video_encoders, get_vaapi_device,
};
use commands::files::{
    PendingFile, get_pending_file, show_in_file_explorer, resolve_output_path,
    handle_open_path,
};
use commands::updates::check_for_updates;
use log::vidcord_log;

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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingFile(Mutex::new(None)))
        .setup(|app| {
            // Handle CLI file argument: `vidcord myfile.mp4`
            let args: Vec<String> = std::env::args().collect();
            vidcord_log(&format!("Startup args: {:?}", args));
            if args.len() > 1 {
                let path = args[1].clone();
                // Filter out macOS -psn_* pseudo-args and flag args
                if !path.starts_with('-') && std::path::Path::new(&path).exists() {
                    let state = app.state::<PendingFile>();
                    let window = app.get_webview_window("main");
                    handle_open_path(path, &state.0, window.as_ref());
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
            get_pending_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // macOS Finder "Open with" delivers files via Apple Events, not CLI args.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let first_path =
                    urls.into_iter().find_map(|u: url::Url| u.to_file_path().ok());
                if let Some(path) = first_path {
                    let path_str = path.to_string_lossy().to_string();
                    let state = app_handle.state::<PendingFile>();
                    let window = app_handle.get_webview_window("main");
                    handle_open_path(path_str, &state.0, window.as_ref());
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app_handle, event);
        });
}
