use std::sync::{Arc, Mutex, OnceLock};
use std::process::Stdio;
use std::io::{BufRead, BufReader, Write};
use tauri::{AppHandle, Emitter, Manager};

mod settings;
mod ffmpeg;
mod gpu;
mod log;

use settings::SettingsManager;
use ffmpeg::{probe_video, generate_preview, get_available_encoders, get_ffmpeg_env};
use log::vidcord_log;

// ---------------------------------------------------------------------------
// Shared compression-process state (PID + output path for partial cleanup)
// ---------------------------------------------------------------------------
struct CompressionState {
    pid: Option<u32>,
    output_path: Option<String>,
    cancelled: bool,
}

static COMPRESSION_STATE: OnceLock<Arc<Mutex<CompressionState>>> = OnceLock::new();

fn compression_state() -> &'static Arc<Mutex<CompressionState>> {
    COMPRESSION_STATE.get_or_init(|| {
        Arc::new(Mutex::new(CompressionState {
            pid: None,
            output_path: None,
            cancelled: false,
        }))
    })
}

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
// Tauri commands — video info & preview
// ---------------------------------------------------------------------------

#[tauri::command]
async fn probe(path: String) -> Result<serde_json::Value, String> {
    probe_video(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_preview_frame(path: String, time_sec: f64) -> Result<String, String> {
    // Returns base64-encoded JPEG
    generate_preview(&path, time_sec).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands — encoders
// ---------------------------------------------------------------------------

#[tauri::command]
async fn detect_encoders() -> Vec<serde_json::Value> {
    // Verify ffmpeg is on PATH first
    if std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        get_available_encoders()
            .into_iter()
            .map(|(name, label)| serde_json::json!({"name": name, "label": label}))
            .collect()
    } else {
        vidcord_log("FFmpeg not found on PATH — encoder detection skipped");
        vec![serde_json::json!({"name": "libx264", "label": "CPU (libx264)", "ffmpeg_missing": true})]
    }
}

#[tauri::command]
async fn check_ffmpeg_available() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tauri::command]
async fn list_ffmpeg_video_encoders() -> Result<String, String> {
    let env = get_ffmpeg_env();

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-encoders"]).envs(&env);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().map_err(|e| format!("Failed to run ffmpeg: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut lines: Vec<String> = Vec::new();
    let re = regex_lite::Regex::new(r"^\s*V[A-Z.]*\s+(\S+)\s+(.*)").unwrap();
    for line in stdout.lines() {
        if let Some(caps) = re.captures(line) {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let desc = caps.get(2).map(|m| m.as_str().trim()).unwrap_or("");
            if desc.is_empty() {
                lines.push(name.to_string());
            } else {
                lines.push(format!("{name}  —  {desc}"));
            }
        }
    }
    if lines.is_empty() {
        Ok("No video encoders found.".to_string())
    } else {
        Ok(lines.join("\n"))
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — compression
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct CompressOptions {
    pub input_path: String,
    pub output_path: String,
    pub encoder: String,
    pub video_bitrate_k: u32,
    pub start_time: f64,
    pub end_time: f64,
    pub remove_audio: bool,
    pub scale_filter: Option<String>,
    pub vaapi_device: Option<String>,
}

#[tauri::command]
async fn compress_video(app: AppHandle, opts: CompressOptions) -> Result<String, String> {
    let env = get_ffmpeg_env();
    let clip_duration = opts.end_time - opts.start_time;
    if clip_duration <= 0.0 {
        return Err("Invalid clip duration".to_string());
    }

    let mut cmd_args: Vec<String> = Vec::new();
    cmd_args.extend(["-hide_banner".into(), "-y".into()]);

    // VAAPI device init
    if opts.encoder.ends_with("_vaapi") {
        if let Some(ref dev) = opts.vaapi_device {
            cmd_args.extend([
                "-init_hw_device".into(),
                format!("vaapi=va:{dev}"),
                "-filter_hw_device".into(),
                "va".into(),
            ]);
        }
    }

    cmd_args.extend([
        "-ss".into(), opts.start_time.to_string(),
        "-to".into(), opts.end_time.to_string(),
        "-i".into(), opts.input_path.clone(),
        "-c:v".into(), opts.encoder.clone(),
        "-b:v".into(), format!("{}k", opts.video_bitrate_k),
    ]);

    // Video filter
    let vf = if opts.encoder.ends_with("_vaapi") {
        let scale = opts.scale_filter.as_deref().unwrap_or("iw:ih");
        format!("format=nv12,hwupload,scale_vaapi={scale}")
    } else {
        opts.scale_filter
            .clone()
            .unwrap_or_else(|| "scale=trunc(iw/2)*2:trunc(ih/2)*2".into())
    };
    cmd_args.extend(["-vf".into(), vf]);

    if opts.remove_audio {
        cmd_args.push("-an".into());
    } else {
        cmd_args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]);
    }

    cmd_args.push(opts.output_path.clone());

    vidcord_log(&format!("FFmpeg command: ffmpeg {}", cmd_args.join(" ")));

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(&cmd_args)
        .envs(&env)
        .stderr(Stdio::piped())
        .stdout(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| {
        vidcord_log(&format!("Failed to start ffmpeg: {e}"));
        format!("Failed to start ffmpeg: {e}")
    })?;

    // Store PID + output path for cancellation/cleanup
    let pid = child.id();
    {
        let mut state = compression_state().lock().unwrap();
        state.pid = Some(pid);
        state.output_path = Some(opts.output_path.clone());
        state.cancelled = false;
    }

    let stderr = child.stderr.take().unwrap();
    let reader = BufReader::new(stderr);

    let start_instant = std::time::Instant::now();
    let mut last_lines: std::collections::VecDeque<String> = std::collections::VecDeque::new();

    for line in reader.lines().flatten() {
        last_lines.push_back(line.clone());
        if last_lines.len() > 200 {
            last_lines.pop_front();
        }
        if line.to_lowercase().contains("error") || line.to_lowercase().contains("warning") {
            vidcord_log(&format!("FFMPEG: {line}"));
        }
        if line.contains("time=") {
            if let Some(time_str) = parse_ffmpeg_time(&line) {
                let pct = ((time_str / clip_duration) * 100.0).min(100.0);
                let elapsed = start_instant.elapsed().as_secs_f64();
                let eta = if time_str > 0.0 && elapsed > 0.0 {
                    let rate = time_str / elapsed;
                    let remaining = clip_duration - time_str;
                    format_eta(remaining / rate)
                } else {
                    "Calculating...".to_string()
                };
                let _ = app.emit("compress-progress", serde_json::json!({
                    "percent": pct as u32,
                    "eta": eta,
                    "status": "Compressing..."
                }));
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;

    let cancelled = {
        let mut state = compression_state().lock().unwrap();
        let c = state.cancelled;
        state.pid = None;
        state.output_path = None;
        state.cancelled = false;
        c
    };

    if cancelled {
        vidcord_log("Compression cancelled by user.");
        let _ = app.emit("compress-done", serde_json::json!({"success": false, "cancelled": true, "message": "Cancelled."}));
        return Err("Cancelled".to_string());
    }

    if status.success() {
        vidcord_log("Compression finished successfully.");
        let _ = app.emit("compress-done", serde_json::json!({"success": true, "message": "Compression complete!", "output_path": opts.output_path}));
        Ok(opts.output_path)
    } else {
        let err_lines: Vec<&str> = last_lines.iter().rev().take(5).map(|s| s.as_str()).collect();
        let err_msg = format!("Compression failed.\n\nFFmpeg Error:\n{}", err_lines.join("\n"));
        vidcord_log(&format!("Compression failed (rc={:?}):\n{}", status.code(), last_lines.iter().cloned().collect::<Vec<_>>().join("\n")));
        let _ = app.emit("compress-done", serde_json::json!({"success": false, "message": err_msg}));
        Err(err_msg)
    }
}

#[tauri::command]
fn cancel_compression() {
    let (pid, output_path) = {
        let mut state = compression_state().lock().unwrap();
        state.cancelled = true;
        (state.pid.take(), state.output_path.take())
    };

    if let Some(pid) = pid {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .creation_flags(0x08000000)
                .output();
        }
    }

    // Clean up partial output file
    if let Some(path) = output_path {
        let p = std::path::Path::new(&path);
        if p.exists() {
            if let Err(e) = std::fs::remove_file(p) {
                vidcord_log(&format!("Failed to remove partial file {path}: {e}"));
            } else {
                vidcord_log(&format!("Cleaned up partial file: {path}"));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — update check
// ---------------------------------------------------------------------------

#[tauri::command]
async fn check_for_updates(current_version: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .user_agent("vidcord-update-check")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("https://api.github.com/repos/cyroz1/vidcord/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let tag = data["tag_name"].as_str()
        .or_else(|| data["name"].as_str())
        .ok_or("Missing tag_name")?;
    let release_url = data["html_url"].as_str()
        .unwrap_or("https://github.com/cyroz1/vidcord/releases/latest");

    let cur = semver::Version::parse(current_version.trim_start_matches('v'))
        .map_err(|e| e.to_string())?;
    let latest = semver::Version::parse(tag.trim_start_matches('v'))
        .map_err(|e| e.to_string())?;

    if latest > cur {
        Ok(serde_json::json!({
            "update_available": true,
            "latest_version": tag,
            "release_url": release_url
        }))
    } else {
        Ok(serde_json::json!({"update_available": false}))
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — open in file explorer
// ---------------------------------------------------------------------------

#[tauri::command]
fn show_in_file_explorer(path: String) -> Result<(), String> {
    let abs = std::fs::canonicalize(&path)
        .unwrap_or_else(|_| std::path::PathBuf::from(&path));

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", abs.display()))
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &abs.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = abs.parent().map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| abs.to_string_lossy().into_owned());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — output path resolution
// ---------------------------------------------------------------------------

#[tauri::command]
fn resolve_output_path(input_path: String) -> Result<String, String> {
    let p = std::path::Path::new(&input_path);
    let stem = p.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");

    let downloads = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .ok_or("Cannot find Downloads folder")?;

    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;

    let mut candidate = downloads.join(format!("{stem}-vidcord.mp4"));
    let mut counter = 1u32;
    while candidate.exists() {
        candidate = downloads.join(format!("{stem}-vidcord-{counter}.mp4"));
        counter += 1;
    }
    Ok(candidate.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands — VAAPI device (Linux only)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_vaapi_device() -> Option<String> {
    ffmpeg::find_vaapi_device()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_ffmpeg_time(line: &str) -> Option<f64> {
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    let end = rest.find(' ').unwrap_or(rest.len());
    let t = &rest[..end];
    if t == "N/A" {
        return None;
    }
    let parts: Vec<&str> = t.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse().ok()?;
        let m: f64 = parts[1].parse().ok()?;
        let s: f64 = parts[2].parse().ok()?;
        Some(h * 3600.0 + m * 60.0 + s)
    } else {
        None
    }
}

fn format_eta(secs: f64) -> String {
    if secs < 0.0 {
        return "Calculating...".to_string();
    }
    let s = secs as u64;
    let mins = s / 60;
    let secs = s % 60;
    if mins >= 60 {
        let h = mins / 60;
        let m = mins % 60;
        format!("{h}h {m}m {secs}s")
    } else {
        format!("{mins}m {secs}s")
    }
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log::setup_crash_log();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Handle CLI file argument: `vidcord myfile.mp4`
            let args: Vec<String> = std::env::args().collect();
            vidcord_log(&format!("Startup args: {:?}", args));
            if args.len() > 1 {
                let path = args[1].clone();
                // Filter out macOS -psn_* pseudo-args and flag args
                if !path.starts_with('-') && std::path::Path::new(&path).exists() {
                    if let Some(win) = app.get_webview_window("main") {
                        // Delay slightly to let the frontend finish loading
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(500));
                            let _ = win.emit("open-file", &path);
                        });
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
