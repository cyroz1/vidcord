use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use crate::ffmpeg::{probe_video, generate_preview, get_ffmpeg_env};
use crate::log::vidcord_log;

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
// Tauri commands — video info & preview
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn probe(path: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || probe_video(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_preview_frame(path: String, time_sec: f64) -> Result<tauri::ipc::Response, String> {
    tokio::task::spawn_blocking(move || {
        generate_preview(&path, time_sec)
            .map(|bytes| tauri::ipc::Response::new(bytes))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
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
pub async fn compress_video(app: AppHandle, opts: CompressOptions) -> Result<String, String> {
    // Validate encoder name: only alphanumeric characters and underscores are valid.
    if opts.encoder.is_empty()
        || !opts.encoder.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(format!("Invalid encoder name: {}", opts.encoder));
    }
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

    // Video filter
    let vf = if opts.encoder.ends_with("_vaapi") {
        let scale = opts.scale_filter.as_deref().unwrap_or("iw:ih");
        format!("format=nv12,hwupload,scale_vaapi={scale}")
    } else {
        opts.scale_filter
            .clone()
            .unwrap_or_else(|| "scale=trunc(iw/2)*2:trunc(ih/2)*2".into())
    };

    cmd_args.extend([
        "-ss".into(), opts.start_time.to_string(),
        "-to".into(), opts.end_time.to_string(),
        "-i".into(), opts.input_path,
        "-c:v".into(), opts.encoder,
        "-b:v".into(), format!("{}k", opts.video_bitrate_k),
        "-vf".into(), vf,
    ]);

    if opts.remove_audio {
        cmd_args.push("-an".into());
    } else {
        cmd_args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]);
    }

    let output_path = opts.output_path;
    cmd_args.push(output_path.clone());

    vidcord_log(&format!("FFmpeg command: ffmpeg {}", cmd_args.join(" ")));

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(&cmd_args)
        .envs(get_ffmpeg_env())
        .stderr(Stdio::piped())
        .stdout(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| {
        vidcord_log(&format!("Failed to start ffmpeg: {e}"));
        if e.kind() == std::io::ErrorKind::NotFound {
            "FFmpeg not found on PATH. Install FFmpeg and restart vidcord.".to_string()
        } else {
            format!("Failed to start ffmpeg: {e}")
        }
    })?;

    let pid = child.id();
    {
        let mut state = compression_state()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        state.pid = Some(pid);
        state.output_path = Some(output_path.clone());
        state.cancelled = false;
    }

    let stderr = child.stderr.take().unwrap();
    let app_for_progress = app.clone();

    let (exit_status, last_lines) =
        tokio::task::spawn_blocking(move || -> Result<_, std::io::Error> {
            let mut reader = BufReader::new(stderr);
            let start_instant = std::time::Instant::now();
            let mut last_lines: std::collections::VecDeque<String> =
                std::collections::VecDeque::new();
            let mut chunk_buf = Vec::new();

            loop {
                chunk_buf.clear();
                let n = reader.read_until(b'\r', &mut chunk_buf)?;
                if n == 0 {
                    break;
                }
                for seg in chunk_buf.split(|&b| b == b'\r' || b == b'\n') {
                    let line = std::str::from_utf8(seg).unwrap_or("").trim();
                    if line.is_empty() {
                        continue;
                    }
                    last_lines.push_back(line.to_string());
                    if last_lines.len() > 200 {
                        last_lines.pop_front();
                    }
                    let lower = line.to_lowercase();
                    if lower.contains("error") || lower.contains("warning") {
                        vidcord_log(&format!("FFMPEG: {line}"));
                    }
                    if line.contains("time=") {
                        if let Some(time_str) = parse_ffmpeg_time(line) {
                            let pct = ((time_str / clip_duration) * 100.0).min(100.0);
                            let elapsed = start_instant.elapsed().as_secs_f64();
                            let eta = if time_str > 0.0 && elapsed > 0.0 {
                                let rate = time_str / elapsed;
                                let remaining = clip_duration - time_str;
                                format_eta(remaining / rate)
                            } else {
                                "Calculating...".to_string()
                            };
                            let _ = app_for_progress.emit(
                                "compress-progress",
                                serde_json::json!({
                                    "percent": pct as u32,
                                    "eta": eta,
                                    "status": "Compressing..."
                                }),
                            );
                        }
                    }
                }
            }

            let status = child.wait()?;
            Ok((status, last_lines))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let cancelled = {
        let mut state = compression_state()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let c = state.cancelled;
        state.pid = None;
        state.output_path = None;
        state.cancelled = false;
        c
    };

    if cancelled {
        vidcord_log("Compression cancelled by user.");
        let p = std::path::Path::new(&output_path);
        if p.exists() {
            if let Err(e) = std::fs::remove_file(p) {
                vidcord_log(&format!("Failed to remove partial file {output_path}: {e}"));
            } else {
                vidcord_log(&format!("Cleaned up partial file: {output_path}"));
            }
        }
        let _ = app.emit(
            "compress-done",
            serde_json::json!({"success": false, "cancelled": true, "message": "Cancelled."}),
        );
        return Err("Cancelled".to_string());
    }

    if exit_status.success() {
        vidcord_log("Compression finished successfully.");
        let _ = app.emit(
            "compress-done",
            serde_json::json!({"success": true, "message": "Compression complete!", "output_path": output_path}),
        );
        Ok(output_path)
    } else {
        let err_lines: Vec<&str> = last_lines.iter().rev().take(5).map(|s| s.as_str()).collect();
        let err_msg = format!("Compression failed.\n\nFFmpeg Error:\n{}", err_lines.join("\n"));
        let all_lines: Vec<&str> = last_lines.iter().map(|s| s.as_str()).collect();
        vidcord_log(&format!(
            "Compression failed (rc={:?}):\n{}",
            exit_status.code(),
            all_lines.join("\n")
        ));
        let _ = app.emit(
            "compress-done",
            serde_json::json!({"success": false, "message": err_msg}),
        );
        Err(err_msg)
    }
}

#[tauri::command]
pub fn cancel_compression() {
    let (pid, output_path) = {
        let mut state = compression_state()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .creation_flags(0x08000000)
                .output();
        }
    }

    drop(output_path);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn parse_ffmpeg_time(line: &str) -> Option<f64> {
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

pub fn format_eta(secs: f64) -> String {
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
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ffmpeg_time_normal() {
        let line = "frame=  120 fps= 30 q=28.0 size=    512kB time=00:00:04.00 bitrate=1048.6kbits/s speed=1.5x";
        assert_eq!(parse_ffmpeg_time(line), Some(4.0));
    }

    #[test]
    fn test_parse_ffmpeg_time_with_hours() {
        let line = "time=01:02:03.50 bitrate=500kbits/s";
        assert_eq!(parse_ffmpeg_time(line), Some(3723.5));
    }

    #[test]
    fn test_parse_ffmpeg_time_na() {
        let line = "time=N/A bitrate=N/A";
        assert_eq!(parse_ffmpeg_time(line), None);
    }

    #[test]
    fn test_parse_ffmpeg_time_missing() {
        let line = "frame=  10 fps=30";
        assert_eq!(parse_ffmpeg_time(line), None);
    }

    #[test]
    fn test_format_eta_seconds_only() {
        assert_eq!(format_eta(45.0), "0m 45s");
    }

    #[test]
    fn test_format_eta_minutes_and_seconds() {
        assert_eq!(format_eta(125.0), "2m 5s");
    }

    #[test]
    fn test_format_eta_hours() {
        assert_eq!(format_eta(3661.0), "1h 1m 1s");
    }

    #[test]
    fn test_format_eta_negative() {
        assert_eq!(format_eta(-1.0), "Calculating...");
    }

    #[test]
    fn test_encoder_name_valid() {
        let valid =
            |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        assert!(valid("libx264"));
        assert!(valid("h264_nvenc"));
        assert!(valid("h264_vaapi"));
    }

    #[test]
    fn test_encoder_name_invalid() {
        let valid =
            |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        assert!(!valid(""));
        assert!(!valid("libx264; rm -rf /"));
        assert!(!valid("../../../bin/sh"));
        assert!(!valid("libx264 -vf evil"));
    }
}
