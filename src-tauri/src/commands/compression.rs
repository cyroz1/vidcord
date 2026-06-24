use crate::ffmpeg::{
    clear_preview_caches, ffmpeg_missing_error, generate_filmstrip, generate_preview,
    generate_preview_clip, get_ffmpeg_env, probe_video,
};
use crate::log::vidcord_log;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

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
    tokio::task::spawn_blocking(move || {
        // Clear both preview caches when loading a new file
        clear_preview_caches();
        probe_video(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_preview_frame(
    path: String,
    time_sec: f64,
) -> Result<tauri::ipc::Response, String> {
    tokio::task::spawn_blocking(move || {
        generate_preview(&path, time_sec)
            .map(tauri::ipc::Response::new)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_preview_clip(
    path: String,
    start_time_sec: f64,
    end_time_sec: f64,
) -> Result<tauri::ipc::Response, String> {
    tokio::task::spawn_blocking(move || {
        generate_preview_clip(&path, start_time_sec, end_time_sec)
            .map(tauri::ipc::Response::new)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns evenly-spaced JPEG frames as a single concatenated binary stream.
/// The frontend splits frames by scanning for JPEG SOI (FF D8) / EOI (FF D9) markers.
#[tauri::command]
pub async fn get_filmstrip(
    path: String,
    duration_sec: f64,
) -> Result<tauri::ipc::Response, String> {
    tokio::task::spawn_blocking(move || {
        generate_filmstrip(&path, duration_sec)
            .map(tauri::ipc::Response::new)
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
    pub target_size_mb: Option<f64>,
    pub start_time: f64,
    pub end_time: f64,
    pub remove_audio: bool,
    pub scale_filter: Option<String>,
    pub vaapi_device: Option<String>,
}

/// Returns encoder-specific preset arguments. Without these, software encoders
/// (libx264/libx265) default to "medium" / "slow" and hardware encoders use
/// conservative built-in defaults — measurably slower than "fast" / "p4" for
/// the same target bitrate. Empty vec falls back to the encoder's default.
fn encoder_preset_args(encoder: &str) -> Vec<String> {
    match encoder {
        "libx264" | "libx265" => vec!["-preset".into(), "fast".into()],
        // NVENC uses p1 (fastest) .. p7 (slowest). p4 is a balanced default
        // that's still significantly faster than the old "medium" preset.
        "h264_nvenc" | "hevc_nvenc" | "av1_nvenc" => {
            vec!["-preset".into(), "p4".into(), "-tune".into(), "hq".into()]
        }
        // QSV / AMF expose libx264-style named presets.
        "h264_qsv" | "hevc_qsv" | "av1_qsv" => vec!["-preset".into(), "veryfast".into()],
        "h264_amf" | "hevc_amf" | "av1_amf" => {
            vec!["-quality".into(), "speed".into()]
        }
        // VAAPI and videotoolbox don't expose a meaningful -preset; their
        // hardware path is already fast. Leave defaults.
        _ => Vec::new(),
    }
}

struct CompressionAttempt {
    encoder: String,
    video_bitrate_k: u32,
    status: String,
}

struct FfmpegRunResult {
    exit_status: std::process::ExitStatus,
    last_lines: std::collections::VecDeque<String>,
    cancelled: bool,
}

fn valid_encoder_name(encoder: &str) -> bool {
    !encoder.is_empty()
        && encoder
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn scale_filter_for_encoder(opts: &CompressOptions, encoder: &str) -> String {
    if encoder.ends_with("_vaapi") {
        let scale = opts
            .scale_filter
            .as_deref()
            .map(|filter| filter.strip_prefix("scale=").unwrap_or(filter))
            .unwrap_or("iw:ih");
        format!("format=nv12,hwupload,scale_vaapi={scale}")
    } else {
        match opts.scale_filter.as_deref() {
            Some(filter) if filter.contains('=') => filter.to_string(),
            Some(filter) => format!("scale={filter}"),
            None => "scale=trunc(iw/2)*2:trunc(ih/2)*2".into(),
        }
    }
}

fn video_bitrate_for_safety(base_bitrate_k: f64, safety: f64) -> u32 {
    ((base_bitrate_k * safety).floor() as u32).max(100)
}

fn retry_attempts(opts: &CompressOptions, clip_duration: f64) -> Vec<CompressionAttempt> {
    let mut attempts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push_attempt = |encoder: String, video_bitrate_k: u32, status: String| {
        if seen.insert((encoder.clone(), video_bitrate_k)) {
            attempts.push(CompressionAttempt {
                encoder,
                video_bitrate_k,
                status,
            });
        }
    };

    push_attempt(
        opts.encoder.clone(),
        opts.video_bitrate_k.max(100),
        "Compressing...".into(),
    );

    let Some(target_size_mb) = opts.target_size_mb else {
        return attempts;
    };
    let use_cpu_fallback = opts.encoder != "libx264";
    if use_cpu_fallback {
        push_attempt(
            "libx264".into(),
            opts.video_bitrate_k.max(100),
            "Retrying with CPU encoder...".into(),
        );
    }

    let total_kbits = target_size_mb * 1024.0 * 8.0;
    let audio_kbits = if opts.remove_audio {
        0.0
    } else {
        128.0 * clip_duration
    };
    let nominal_base = ((total_kbits - audio_kbits) / clip_duration).max(100.0);
    let initial_base = (opts.video_bitrate_k as f64 / 0.9).max(100.0);
    let base_bitrate_k = nominal_base.min(initial_base);

    for safety_percent in (10..=80).rev().step_by(10) {
        let safety = safety_percent as f64 / 100.0;
        let bitrate = video_bitrate_for_safety(base_bitrate_k, safety);
        push_attempt(
            opts.encoder.clone(),
            bitrate,
            format!("Retrying at {safety_percent}% size safety..."),
        );
        if use_cpu_fallback {
            push_attempt(
                "libx264".into(),
                bitrate,
                format!("Retrying with CPU encoder at {safety_percent}% size safety..."),
            );
        }
    }

    attempts
}

fn target_size_bytes(target_size_mb: Option<f64>) -> Result<Option<u64>, String> {
    match target_size_mb {
        Some(size) if size.is_finite() && size > 0.0 => Ok(Some((size * 1024.0 * 1024.0) as u64)),
        Some(_) => Err("Invalid target size".to_string()),
        None => Ok(None),
    }
}

fn remove_partial_output(output_path: &str) {
    let p = std::path::Path::new(output_path);
    if p.exists() {
        if let Err(e) = std::fs::remove_file(p) {
            vidcord_log(&format!("Failed to remove partial file {output_path}: {e}"));
        } else {
            vidcord_log(&format!("Cleaned up partial file: {output_path}"));
        }
    }
}

fn was_cancelled() -> bool {
    let state = compression_state()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    state.cancelled
}

fn reset_cancelled() {
    let mut state = compression_state()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    state.cancelled = false;
}

async fn run_ffmpeg_attempt(
    app: &AppHandle,
    opts: &CompressOptions,
    attempt: &CompressionAttempt,
    attempt_index: usize,
    total_attempts: usize,
    clip_duration: f64,
) -> Result<FfmpegRunResult, String> {
    if was_cancelled() {
        return Ok(FfmpegRunResult {
            exit_status: cancelled_exit_status(),
            last_lines: std::collections::VecDeque::new(),
            cancelled: true,
        });
    }

    let mut cmd_args: Vec<String> = Vec::new();
    cmd_args.extend(["-hide_banner".into(), "-y".into()]);

    if attempt.encoder.ends_with("_vaapi") {
        if let Some(ref dev) = opts.vaapi_device {
            cmd_args.extend([
                "-init_hw_device".into(),
                format!("vaapi=va:{dev}"),
                "-filter_hw_device".into(),
                "va".into(),
            ]);
        }
    }

    let vf = scale_filter_for_encoder(opts, &attempt.encoder);
    let preset_args = encoder_preset_args(&attempt.encoder);

    cmd_args.extend([
        "-ss".into(),
        opts.start_time.to_string(),
        "-to".into(),
        opts.end_time.to_string(),
        "-i".into(),
        opts.input_path.clone(),
        "-c:v".into(),
        attempt.encoder.clone(),
        "-b:v".into(),
        format!("{}k", attempt.video_bitrate_k),
        "-vf".into(),
        vf,
    ]);
    cmd_args.extend(preset_args);

    if opts.remove_audio {
        cmd_args.push("-an".into());
    } else {
        cmd_args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]);
    }

    cmd_args.extend([
        "-metadata".into(),
        "comment=Compressed with vidcord - cyroz.net/vidcord".into(),
    ]);
    cmd_args.push(opts.output_path.clone());

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
            ffmpeg_missing_error()
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
        state.output_path = Some(opts.output_path.clone());
    }

    let stderr = child.stderr.take().unwrap();
    let app_for_progress = app.clone();
    let attempt_number = attempt_index + 1;
    let attempt_total = total_attempts;
    let encoder_name = attempt.encoder.clone();
    let video_bitrate_k = attempt.video_bitrate_k;
    let status_text = attempt.status.clone();

    let (exit_status, last_lines) =
        tokio::task::spawn_blocking(move || -> Result<_, std::io::Error> {
            let mut reader = BufReader::new(stderr);
            let start_instant = std::time::Instant::now();
            let mut last_lines: std::collections::VecDeque<String> =
                std::collections::VecDeque::with_capacity(200);
            let mut chunk_buf = Vec::with_capacity(4096);

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
                    let is_progress = line.contains("time=");
                    let line_has_issue =
                        !is_progress && contains_ascii_ci_any(line, &[b"error", b"warning"]);
                    if line_has_issue {
                        vidcord_log(&format!("FFMPEG: {line}"));
                    }
                    if !is_progress {
                        last_lines.push_back(line.to_string());
                        if last_lines.len() > 200 {
                            last_lines.pop_front();
                        }
                    }
                    if is_progress {
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
                                    "status": status_text.as_str(),
                                    "attempt": attempt_number,
                                    "attempt_total": attempt_total,
                                    "encoder": encoder_name.as_str(),
                                    "video_bitrate_k": video_bitrate_k
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
        c
    };

    Ok(FfmpegRunResult {
        exit_status,
        last_lines,
        cancelled,
    })
}

#[cfg(unix)]
fn cancelled_exit_status() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(130 << 8)
}

#[cfg(windows)]
fn cancelled_exit_status() -> std::process::ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(1)
}

fn format_size_mb(bytes: u64) -> String {
    let mb = bytes as f64 / (1024.0 * 1024.0);
    if mb >= 100.0 {
        format!("{mb:.0} MB")
    } else if mb >= 10.0 {
        format!("{mb:.1} MB")
    } else {
        format!("{mb:.2} MB")
    }
}

#[tauri::command]
pub async fn compress_video(app: AppHandle, opts: CompressOptions) -> Result<String, String> {
    // Validate encoder name: only alphanumeric characters and underscores are valid.
    if !valid_encoder_name(&opts.encoder) {
        return Err(format!("Invalid encoder name: {}", opts.encoder));
    }
    let clip_duration = opts.end_time - opts.start_time;
    if clip_duration <= 0.0 {
        return Err("Invalid clip duration".to_string());
    }

    let target_bytes = target_size_bytes(opts.target_size_mb)?;
    let attempts = retry_attempts(&opts, clip_duration);
    let total_attempts = attempts.len();
    let mut smallest_oversize_bytes: Option<u64> = None;
    reset_cancelled();

    for (idx, attempt) in attempts.iter().enumerate() {
        let _ = app.emit(
            "compress-progress",
            serde_json::json!({
                "percent": 0,
                "eta": "Calculating...",
                "status": attempt.status.as_str(),
                "attempt": idx + 1,
                "attempt_total": total_attempts,
                "encoder": attempt.encoder.as_str(),
                "video_bitrate_k": attempt.video_bitrate_k
            }),
        );

        let run =
            run_ffmpeg_attempt(&app, &opts, attempt, idx, total_attempts, clip_duration).await?;
        if run.cancelled {
            vidcord_log("Compression cancelled by user.");
            remove_partial_output(&opts.output_path);
            reset_cancelled();
            let _ = app.emit(
                "compress-done",
                serde_json::json!({"success": false, "cancelled": true, "message": "Cancelled."}),
            );
            return Err("Cancelled".to_string());
        }

        if !run.exit_status.success() {
            let err_lines: Vec<&str> = run
                .last_lines
                .iter()
                .rev()
                .take(5)
                .map(String::as_str)
                .collect();
            let err_msg = format!(
                "Compression failed.\n\nFFmpeg Error:\n{}",
                err_lines.join("\n")
            );
            let all_lines: Vec<&str> = run.last_lines.iter().map(String::as_str).collect();
            vidcord_log(&format!(
                "Compression failed (rc={:?}):\n{}",
                run.exit_status.code(),
                all_lines.join("\n")
            ));
            let _ = app.emit(
                "compress-done",
                serde_json::json!({"success": false, "message": err_msg}),
            );
            return Err(err_msg);
        }

        let output_size = std::fs::metadata(&opts.output_path)
            .map_err(|e| format!("Compression finished but output file could not be read: {e}"))?
            .len();
        let output_is_small_enough = match target_bytes {
            Some(limit) => output_size <= limit,
            None => true,
        };
        if output_is_small_enough {
            let message = match target_bytes {
                Some(limit) => format!(
                    "Compressed to {} (target {}).",
                    format_size_mb(output_size),
                    format_size_mb(limit)
                ),
                None => format!("Compressed to {}.", format_size_mb(output_size)),
            };
            vidcord_log(&format!(
                "Compression finished successfully: {} bytes with {} at {}k.",
                output_size, attempt.encoder, attempt.video_bitrate_k
            ));
            reset_cancelled();
            let _ = app.emit(
                "compress-done",
                serde_json::json!({
                    "success": true,
                    "message": message,
                    "output_path": &opts.output_path,
                    "output_size_bytes": output_size,
                    "target_size_bytes": target_bytes,
                    "attempt": idx + 1,
                    "attempt_total": total_attempts,
                    "encoder": attempt.encoder.as_str(),
                    "video_bitrate_k": attempt.video_bitrate_k
                }),
            );
            return Ok(opts.output_path);
        }

        smallest_oversize_bytes = match smallest_oversize_bytes {
            Some(current) if current <= output_size => Some(current),
            _ => Some(output_size),
        };

        vidcord_log(&format!(
            "Output too large ({} bytes > {} bytes); retrying.",
            output_size,
            target_bytes.unwrap_or(0)
        ));
        remove_partial_output(&opts.output_path);
    }

    reset_cancelled();
    let err_msg = match (smallest_oversize_bytes, target_bytes) {
        (Some(smallest), Some(limit)) => format!(
            "Compression could not reach target size. Smallest result was {}, above target {}.",
            format_size_mb(smallest),
            format_size_mb(limit)
        ),
        _ => "Compression could not reach the requested target size after retrying lower bitrates."
            .to_string(),
    };
    let _ = app.emit(
        "compress-done",
        serde_json::json!({
            "success": false,
            "message": err_msg,
            "smallest_output_size_bytes": smallest_oversize_bytes,
            "target_size_bytes": target_bytes
        }),
    );
    Err(err_msg)
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

/// Case-insensitive ASCII substring search that avoids allocating a lowercased
/// copy of the haystack. Hot path during FFmpeg progress parsing.
pub fn contains_ascii_ci(haystack: &str, needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    let hb = haystack.as_bytes();
    if hb.len() < needle.len() {
        return false;
    }
    hb.windows(needle.len())
        .any(|w| w.eq_ignore_ascii_case(needle))
}

/// Case-insensitive ASCII substring search against multiple needles in a
/// single pass. Returns true if ANY needle is found. This avoids walking the
/// same line twice when checking for both "error" and "warning".
pub fn contains_ascii_ci_any(haystack: &str, needles: &[&[u8]]) -> bool {
    let hb = haystack.as_bytes();
    for i in 0..hb.len() {
        for needle in needles {
            if needle.is_empty() {
                return true;
            }
            if hb.len() - i < needle.len() {
                continue;
            }
            if hb[i..i + needle.len()].eq_ignore_ascii_case(needle) {
                return true;
            }
        }
    }
    false
}

pub fn parse_ffmpeg_time(line: &str) -> Option<f64> {
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    let end = rest.find(' ').unwrap_or(rest.len());
    let t = &rest[..end];
    if t == "N/A" {
        return None;
    }
    // Avoid the per-line Vec<&str> allocation from `.split(':').collect()`.
    // FFmpeg emits dozens of progress lines per second; this runs on every one.
    let mut it = t.split(':');
    let h: f64 = it.next()?.parse().ok()?;
    let m: f64 = it.next()?.parse().ok()?;
    let s: f64 = it.next()?.parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some(h * 3600.0 + m * 60.0 + s)
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

    fn retry_test_options(encoder: &str) -> CompressOptions {
        CompressOptions {
            input_path: "input.mp4".into(),
            output_path: "output.mp4".into(),
            encoder: encoder.into(),
            video_bitrate_k: 900,
            target_size_mb: Some(100.0),
            start_time: 0.0,
            end_time: 60.0,
            remove_audio: false,
            scale_filter: None,
            vaapi_device: None,
        }
    }

    #[test]
    fn test_retry_attempts_try_cpu_before_reducing_original_encoder() {
        let opts = retry_test_options("h264_nvenc");
        let attempts = retry_attempts(&opts, 60.0);
        let first_attempts: Vec<(&str, u32, &str)> = attempts
            .iter()
            .take(6)
            .map(|attempt| {
                (
                    attempt.encoder.as_str(),
                    attempt.video_bitrate_k,
                    attempt.status.as_str(),
                )
            })
            .collect();

        assert_eq!(
            first_attempts,
            vec![
                ("h264_nvenc", 900, "Compressing..."),
                ("libx264", 900, "Retrying with CPU encoder..."),
                ("h264_nvenc", 800, "Retrying at 80% size safety..."),
                (
                    "libx264",
                    800,
                    "Retrying with CPU encoder at 80% size safety..."
                ),
                ("h264_nvenc", 700, "Retrying at 70% size safety..."),
                (
                    "libx264",
                    700,
                    "Retrying with CPU encoder at 70% size safety..."
                ),
            ]
        );
    }

    #[test]
    fn test_retry_attempts_do_not_duplicate_cpu_encoder() {
        let opts = retry_test_options("libx264");
        let attempts = retry_attempts(&opts, 60.0);
        let bitrates: Vec<u32> = attempts
            .iter()
            .map(|attempt| {
                assert_eq!(attempt.encoder, "libx264");
                attempt.video_bitrate_k
            })
            .collect();

        assert_eq!(bitrates, vec![900, 800, 700, 600, 500, 400, 300, 200, 100]);
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

    #[test]
    fn test_contains_ascii_ci_any() {
        assert!(contains_ascii_ci_any(
            "ERROR: something broke",
            &[b"error", b"warning"]
        ));
        assert!(contains_ascii_ci_any(
            "WaRnInG: deprecated",
            &[b"error", b"warning"]
        ));
        assert!(contains_ascii_ci_any("warning only", &[b"warning"]));
        assert!(!contains_ascii_ci_any(
            "nothing matches",
            &[b"error", b"warning"]
        ));
        assert!(!contains_ascii_ci_any("", &[b"error", b"warning"]));
        assert!(!contains_ascii_ci_any("err", &[b"error"]));
        // Empty needle is vacuously contained
        assert!(contains_ascii_ci_any("anything", &[b""]));
        // No needles
        assert!(!contains_ascii_ci_any("anything", &[]));
    }

    #[test]
    fn test_contains_ascii_ci() {
        assert!(contains_ascii_ci("frame=120 time=00:00:04", b"time"));
        assert!(contains_ascii_ci("ERROR: something broke", b"error"));
        assert!(contains_ascii_ci("WaRnInG: deprecated", b"warning"));
        assert!(contains_ascii_ci("error", b"error"));
        assert!(!contains_ascii_ci("nothing matches", b"error"));
        assert!(!contains_ascii_ci("", b"error"));
        assert!(!contains_ascii_ci("err", b"error"));
        // Empty needle is vacuously contained
        assert!(contains_ascii_ci("anything", b""));
    }
}
