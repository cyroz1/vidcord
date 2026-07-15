use crate::ffmpeg::{
    cancel_preview_jobs, clear_preview_caches, configure_ffmpeg_command, ffmpeg_missing_error,
    generate_filmstrip, generate_preview, generate_preview_clip, probe_video,
};
use crate::log::vidcord_log;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

const MAX_FFMPEG_STDERR_RECORD_BYTES: usize = 16 * 1024;
const MAX_FFMPEG_DIAGNOSTIC_BYTES: usize = 256 * 1024;
const MAX_FFMPEG_DIAGNOSTIC_LINES: usize = 200;

fn read_bounded_records<R, F>(reader: &mut R, mut on_record: F) -> std::io::Result<()>
where
    R: BufRead,
    F: FnMut(&[u8], bool),
{
    let mut record = Vec::with_capacity(4096);
    let mut truncated = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            break;
        }
        let consumed = available.len();
        for &byte in available {
            if byte == b'\r' || byte == b'\n' {
                if !record.is_empty() || truncated {
                    on_record(&record, truncated);
                    record.clear();
                    truncated = false;
                }
            } else if record.len() < MAX_FFMPEG_STDERR_RECORD_BYTES {
                record.push(byte);
            } else {
                truncated = true;
            }
        }
        reader.consume(consumed);
    }

    if !record.is_empty() || truncated {
        on_record(&record, truncated);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared compression-process state (PID + output path for partial cleanup)
// ---------------------------------------------------------------------------

struct CompressionState {
    next_job_id: u64,
    active_job_id: Option<u64>,
    pid: Option<u32>,
    output_path: Option<String>,
    cancelled: bool,
}

impl CompressionState {
    fn try_begin_job(&mut self) -> Option<u64> {
        if self.active_job_id.is_some() {
            return None;
        }
        self.next_job_id = self.next_job_id.wrapping_add(1).max(1);
        let job_id = self.next_job_id;
        self.active_job_id = Some(job_id);
        self.pid = None;
        self.output_path = None;
        self.cancelled = false;
        Some(job_id)
    }

    fn is_cancelled(&self, job_id: u64) -> bool {
        self.active_job_id != Some(job_id) || self.cancelled
    }

    fn register_process(&mut self, job_id: u64, pid: u32, output_path: String) -> bool {
        if self.is_cancelled(job_id) {
            return false;
        }
        self.pid = Some(pid);
        self.output_path = Some(output_path);
        true
    }

    fn clear_process(&mut self, job_id: u64) {
        if self.active_job_id == Some(job_id) {
            self.pid = None;
            self.output_path = None;
        }
    }

    fn cancel_active(&mut self) -> Option<u32> {
        self.active_job_id?;
        self.cancelled = true;
        self.pid.take()
    }

    fn finish_job(&mut self, job_id: u64) {
        if self.active_job_id == Some(job_id) {
            self.active_job_id = None;
            self.pid = None;
            self.output_path = None;
            self.cancelled = false;
        }
    }
}

static COMPRESSION_STATE: OnceLock<Arc<Mutex<CompressionState>>> = OnceLock::new();

fn compression_state() -> &'static Arc<Mutex<CompressionState>> {
    COMPRESSION_STATE.get_or_init(|| {
        Arc::new(Mutex::new(CompressionState {
            next_job_id: 0,
            active_job_id: None,
            pid: None,
            output_path: None,
            cancelled: false,
        }))
    })
}

fn begin_compression_job() -> Result<u64, String> {
    compression_state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .try_begin_job()
        .ok_or_else(|| "A compression job is already running.".to_string())
}

fn finish_compression_job(job_id: u64) {
    compression_state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .finish_job(job_id);
}

struct CompressionJobGuard(u64);

impl Drop for CompressionJobGuard {
    fn drop(&mut self) {
        finish_compression_job(self.0);
    }
}

struct OutputReservation {
    path: std::path::PathBuf,
    committed: bool,
}

impl OutputReservation {
    fn create(path: String) -> Result<Self, String> {
        let path = std::path::PathBuf::from(path);
        match std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
        {
            Ok(_) => Ok(Self {
                path,
                committed: false,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(
                "The output filename became unavailable. Try Compress again to choose a new name."
                    .to_string(),
            ),
            Err(error) => Err(format!("Could not reserve the output file: {error}")),
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for OutputReservation {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — video info & preview
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn probe(path: String) -> Result<serde_json::Value, String> {
    let started_at = Instant::now();
    let result = tokio::task::spawn_blocking(move || {
        cancel_preview_jobs();
        // Clear both preview caches when loading a new file
        clear_preview_caches();
        probe_video(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    vidcord_log(&format!(
        "File import: probe {} in {} ms",
        if result.is_ok() {
            "completed"
        } else {
            "failed"
        },
        started_at.elapsed().as_millis()
    ));
    result
}

#[tauri::command]
pub async fn get_preview_frame(
    path: String,
    time_sec: f64,
    preview_width: Option<u32>,
    preview_height: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    tokio::task::spawn_blocking(move || {
        generate_preview(&path, time_sec, preview_width, preview_height)
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
    max_frames: Option<usize>,
    preview_width: Option<u32>,
    preview_height: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    tokio::task::spawn_blocking(move || {
        generate_filmstrip(
            &path,
            duration_sec,
            max_frames,
            preview_width,
            preview_height,
        )
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cancel_preview_generation() -> Result<(), String> {
    tokio::task::spawn_blocking(cancel_preview_jobs)
        .await
        .map_err(|e| e.to_string())
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
    pub output_fps: Option<f64>,
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

fn valid_output_fps(fps: Option<f64>) -> bool {
    match fps {
        Some(value) => value.is_finite() && value > 0.0 && value <= 1000.0,
        None => true,
    }
}

fn valid_scale_filter(filter: Option<&str>) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    if filter == "scale=trunc(iw/2)*2:trunc(ih/2)*2" || filter == "iw:ih" {
        return true;
    }

    let dimensions = filter.strip_prefix("scale=").unwrap_or(filter);
    let mut parts = dimensions.split(':');
    let (Some(width), Some(height), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    [width, height].into_iter().all(|value| {
        value
            .parse::<u32>()
            .is_ok_and(|dimension| (1..=32_768).contains(&dimension))
    })
}

fn valid_vaapi_device(device: Option<&str>) -> bool {
    if device.is_none() {
        return true;
    }

    #[cfg(target_os = "linux")]
    {
        let device = device.expect("device was checked above");
        let path = std::path::Path::new(device);
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return false;
        };
        path.parent() == Some(std::path::Path::new("/dev/dri"))
            && name.strip_prefix("renderD").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())
            })
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

fn format_fps_filter_value(fps: f64) -> String {
    let mut value = format!("{fps:.3}");
    while value.contains('.') && value.ends_with('0') {
        value.pop();
    }
    if value.ends_with('.') {
        value.pop();
    }
    value
}

fn video_filter_for_encoder(opts: &CompressOptions, encoder: &str) -> String {
    let mut filters = Vec::new();
    if let Some(fps) = opts.output_fps {
        filters.push(format!("fps={}", format_fps_filter_value(fps)));
    }

    if encoder.ends_with("_vaapi") {
        let scale = opts
            .scale_filter
            .as_deref()
            .map(|filter| filter.strip_prefix("scale=").unwrap_or(filter))
            .unwrap_or("iw:ih");
        filters.extend([
            "format=nv12".to_string(),
            "hwupload".to_string(),
            format!("scale_vaapi={scale}"),
        ]);
    } else {
        filters.push(match opts.scale_filter.as_deref() {
            Some(filter) if filter.contains('=') => filter.to_string(),
            Some(filter) => format!("scale={filter}"),
            None => "scale=trunc(iw/2)*2:trunc(ih/2)*2".into(),
        });
    }
    filters.join(",")
}

const OVERSIZE_RETRY_LIMIT_PER_ENCODER: usize = 1;
const OVERSIZE_RETRY_SAFETY: f64 = 0.96;

fn initial_attempt(opts: &CompressOptions) -> CompressionAttempt {
    CompressionAttempt {
        encoder: opts.encoder.clone(),
        video_bitrate_k: opts.video_bitrate_k.max(100),
        status: "Compressing...".into(),
    }
}

fn max_adaptive_attempts(opts: &CompressOptions, has_target: bool) -> usize {
    // A hardware selection has two encoder phases: the requested encoder and
    // a CPU fallback. Each phase gets its initial encode, and target-size jobs
    // get the same bounded number of adaptive bitrate retries per encoder.
    // Deriving the cap from that policy keeps it aligned with
    // `next_oversize_attempt` instead of silently discarding its final CPU
    // retry.
    let encoder_phases = if opts.encoder == "libx264" { 1 } else { 2 };
    let attempts_per_encoder = if has_target {
        1 + OVERSIZE_RETRY_LIMIT_PER_ENCODER
    } else {
        1
    };
    encoder_phases * attempts_per_encoder
}

fn cpu_fallback_attempt(video_bitrate_k: u32, status: String) -> CompressionAttempt {
    CompressionAttempt {
        encoder: "libx264".into(),
        video_bitrate_k: video_bitrate_k.max(100),
        status,
    }
}

fn adaptive_bitrate_for_oversize(
    current_bitrate_k: u32,
    target_bytes: u64,
    output_bytes: u64,
) -> u32 {
    if output_bytes == 0 {
        return current_bitrate_k.max(100);
    }
    let ratio = target_bytes as f64 / output_bytes as f64;
    ((current_bitrate_k as f64 * ratio * OVERSIZE_RETRY_SAFETY).floor() as u32).max(100)
}

fn next_oversize_attempt(
    current: &CompressionAttempt,
    target_bytes: u64,
    output_bytes: u64,
    oversize_retries_for_encoder: usize,
    cpu_fallback_used: bool,
) -> Option<(CompressionAttempt, usize, bool)> {
    let next_bitrate =
        adaptive_bitrate_for_oversize(current.video_bitrate_k, target_bytes, output_bytes);

    if oversize_retries_for_encoder < OVERSIZE_RETRY_LIMIT_PER_ENCODER
        && next_bitrate < current.video_bitrate_k
    {
        return Some((
            CompressionAttempt {
                encoder: current.encoder.clone(),
                video_bitrate_k: next_bitrate,
                status: format!("Retrying at {next_bitrate} kbps after size check..."),
            },
            oversize_retries_for_encoder + 1,
            cpu_fallback_used,
        ));
    }

    if !cpu_fallback_used && current.encoder != "libx264" {
        return Some((
            cpu_fallback_attempt(
                next_bitrate.min(current.video_bitrate_k),
                format!(
                    "Retrying with CPU encoder at {} kbps...",
                    next_bitrate.min(current.video_bitrate_k)
                ),
            ),
            0,
            true,
        ));
    }

    None
}

fn target_size_bytes(target_size_mb: Option<f64>) -> Result<Option<u64>, String> {
    match target_size_mb {
        Some(size)
            if size.is_finite() && size > 0.0 && size <= u64::MAX as f64 / (1024.0 * 1024.0) =>
        {
            Ok(Some((size * 1024.0 * 1024.0) as u64))
        }
        Some(_) => Err("Invalid target size".to_string()),
        None => Ok(None),
    }
}

fn valid_time_range(start_time: f64, end_time: f64) -> bool {
    start_time.is_finite() && end_time.is_finite() && start_time >= 0.0 && end_time > start_time
}

struct ChildProcessGuard {
    child: std::process::Child,
    finished: bool,
}

impl ChildProcessGuard {
    fn new(child: std::process::Child) -> Self {
        Self {
            child,
            finished: false,
        }
    }

    fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let result = self.child.wait();
        if result.is_ok() {
            self.finished = true;
        }
        result
    }
}

impl Drop for ChildProcessGuard {
    fn drop(&mut self) {
        if self.finished {
            return;
        }

        // Dropping std::process::Child does not terminate or reap it. Ensure a
        // stderr read error, wait error, or panic cannot leave an unowned
        // encoder running after the compression job state is released.
        let _ = self.child.kill();
        let _ = self.child.wait();
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

fn was_cancelled(job_id: u64) -> bool {
    let state = compression_state()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    state.is_cancelled(job_id)
}

async fn run_ffmpeg_attempt(
    app: &AppHandle,
    opts: &CompressOptions,
    attempt: &CompressionAttempt,
    attempt_index: usize,
    total_attempts: usize,
    clip_duration: f64,
    job_id: u64,
) -> Result<FfmpegRunResult, String> {
    if was_cancelled(job_id) {
        return Ok(FfmpegRunResult {
            exit_status: cancelled_exit_status(),
            last_lines: std::collections::VecDeque::new(),
            cancelled: true,
        });
    }

    let mut cmd_args: Vec<String> = Vec::new();
    cmd_args.extend(["-hide_banner".into(), "-nostdin".into(), "-y".into()]);

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

    let vf = video_filter_for_encoder(opts, &attempt.encoder);
    let preset_args = encoder_preset_args(&attempt.encoder);
    let duration = format!("{clip_duration:.3}");
    let start_time = format!("{:.3}", opts.start_time);

    cmd_args.extend([
        "-ss".into(),
        start_time,
        "-t".into(),
        duration,
        "-i".into(),
        opts.input_path.clone(),
        "-map".into(),
        "0:v:0".into(),
        "-sn".into(),
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
        cmd_args.extend([
            "-map".into(),
            "0:a?".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "128k".into(),
        ]);
    }

    cmd_args.extend([
        "-metadata".into(),
        "comment=Compressed with vidcord - vidcord.app".into(),
    ]);
    cmd_args.push(opts.output_path.clone());

    vidcord_log(&format!("FFmpeg command: ffmpeg {}", cmd_args.join(" ")));

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(&cmd_args)
        .stderr(Stdio::piped())
        .stdout(Stdio::null());
    configure_ffmpeg_command(&mut cmd);

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
    let registered = {
        let mut state = compression_state()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        state.register_process(job_id, pid, opts.output_path.clone())
    };
    if !registered {
        let _ = child.kill();
        let exit_status = child.wait().map_err(|e| e.to_string())?;
        return Ok(FfmpegRunResult {
            exit_status,
            last_lines: std::collections::VecDeque::new(),
            cancelled: true,
        });
    }

    let stderr = child.stderr.take().unwrap();
    let app_for_progress = app.clone();
    let attempt_number = attempt_index + 1;
    let attempt_total = total_attempts;
    let encoder_name = attempt.encoder.clone();
    let video_bitrate_k = attempt.video_bitrate_k;
    let status_text = attempt.status.clone();

    let run_result = tokio::task::spawn_blocking(move || -> Result<_, std::io::Error> {
        let mut child = ChildProcessGuard::new(child);
        let mut reader = BufReader::new(stderr);
        let start_instant = std::time::Instant::now();
        let mut last_progress_emit: Option<std::time::Instant> = None;
        let mut completion_emitted = false;
        let mut last_lines: std::collections::VecDeque<String> =
            std::collections::VecDeque::with_capacity(MAX_FFMPEG_DIAGNOSTIC_LINES);
        let mut last_lines_bytes = 0usize;

        read_bounded_records(&mut reader, |record, truncated| {
            let line = String::from_utf8_lossy(record);
            let line = line.trim();
            if line.is_empty() {
                return;
            }

            let is_progress = line.contains("time=");
            let diagnostic = if truncated {
                format!("{line} … [truncated]")
            } else {
                line.to_string()
            };
            let line_has_issue =
                !is_progress && contains_ascii_ci_any(line, &[b"error", b"warning"]);
            if line_has_issue {
                vidcord_log(&format!("FFMPEG: {diagnostic}"));
            }

            if !is_progress {
                while !last_lines.is_empty()
                    && (last_lines.len() >= MAX_FFMPEG_DIAGNOSTIC_LINES
                        || last_lines_bytes.saturating_add(diagnostic.len())
                            > MAX_FFMPEG_DIAGNOSTIC_BYTES)
                {
                    if let Some(removed) = last_lines.pop_front() {
                        last_lines_bytes = last_lines_bytes.saturating_sub(removed.len());
                    }
                }
                if diagnostic.len() <= MAX_FFMPEG_DIAGNOSTIC_BYTES {
                    last_lines_bytes += diagnostic.len();
                    last_lines.push_back(diagnostic);
                }
                return;
            }

            let Some(time_str) = parse_ffmpeg_time(line) else {
                return;
            };
            let pct = ((time_str / clip_duration) * 100.0).min(100.0);
            let now = std::time::Instant::now();
            let should_emit = last_progress_emit
                .map(|last| now.duration_since(last).as_millis() >= 250)
                .unwrap_or(true)
                || (pct >= 99.9 && !completion_emitted);
            if !should_emit {
                return;
            }
            if pct >= 99.9 {
                completion_emitted = true;
            }
            last_progress_emit = Some(now);
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
        })?;

        let status = child.wait()?;
        Ok((status, last_lines))
    })
    .await;

    let cancelled = {
        let mut state = compression_state()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let c = state.is_cancelled(job_id);
        state.clear_process(job_id);
        c
    };

    let (exit_status, last_lines) = run_result
        .map_err(|e| format!("FFmpeg worker failed: {e}"))?
        .map_err(|e| format!("Failed while monitoring FFmpeg: {e}"))?;

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
    if !valid_output_fps(opts.output_fps) {
        return Err("Invalid output FPS".to_string());
    }
    if !valid_scale_filter(opts.scale_filter.as_deref()) {
        return Err("Invalid scale filter".to_string());
    }
    if !valid_vaapi_device(opts.vaapi_device.as_deref()) {
        return Err("Invalid VAAPI device".to_string());
    }
    if !valid_time_range(opts.start_time, opts.end_time) {
        return Err("Invalid clip time range".to_string());
    }
    let clip_duration = opts.end_time - opts.start_time;

    let target_bytes = target_size_bytes(opts.target_size_mb)?;
    let job_id = begin_compression_job()?;
    let _job_guard = CompressionJobGuard(job_id);

    // resolve_output_path is advisory; atomically reserve the selected name
    // before FFmpeg's `-y` can touch it. The reservation remains owned across
    // adaptive retries, so another process cannot claim a retry gap. Begin the
    // owned job first so an immediate Cancel cannot race this async reservation.
    let reservation_path = opts.output_path.clone();
    let mut output_reservation =
        tokio::task::spawn_blocking(move || OutputReservation::create(reservation_path))
            .await
            .map_err(|error| error.to_string())??;
    tokio::task::spawn_blocking(cancel_preview_jobs)
        .await
        .map_err(|e| e.to_string())?;
    let total_attempts = max_adaptive_attempts(&opts, target_bytes.is_some());
    let mut smallest_oversize_bytes: Option<u64> = None;
    let mut attempt = initial_attempt(&opts);
    let mut attempt_index = 0usize;
    let mut oversize_retries_for_encoder = 0usize;
    let mut cpu_fallback_used = opts.encoder == "libx264";
    let mut seen_attempts: std::collections::HashSet<(String, u32)> =
        std::collections::HashSet::new();

    loop {
        if attempt_index >= total_attempts {
            break;
        }
        if !seen_attempts.insert((attempt.encoder.clone(), attempt.video_bitrate_k)) {
            break;
        }

        let _ = app.emit(
            "compress-progress",
            serde_json::json!({
                "percent": 0,
                "eta": "Calculating...",
                "status": attempt.status.as_str(),
                "attempt": attempt_index + 1,
                "attempt_total": total_attempts,
                "encoder": attempt.encoder.as_str(),
                "video_bitrate_k": attempt.video_bitrate_k
            }),
        );

        let run = match run_ffmpeg_attempt(
            &app,
            &opts,
            &attempt,
            attempt_index,
            total_attempts,
            clip_duration,
            job_id,
        )
        .await
        {
            Ok(run) => run,
            Err(error) => {
                vidcord_log(&format!("Compression worker failed: {error}"));
                remove_partial_output(&opts.output_path);
                let _ = app.emit(
                    "compress-done",
                    serde_json::json!({"success": false, "message": error}),
                );
                return Err(error);
            }
        };
        if run.cancelled {
            vidcord_log("Compression cancelled by user.");
            remove_partial_output(&opts.output_path);
            let _ = app.emit(
                "compress-done",
                serde_json::json!({"success": false, "cancelled": true, "message": "Cancelled."}),
            );
            return Err("Cancelled".to_string());
        }

        if !run.exit_status.success() {
            if !cpu_fallback_used && attempt.encoder != "libx264" {
                let all_lines: Vec<&str> = run.last_lines.iter().map(String::as_str).collect();
                vidcord_log(&format!(
                    "Compression attempt failed with {}; retrying CPU fallback. rc={:?}\n{}",
                    attempt.encoder,
                    run.exit_status.code(),
                    all_lines.join("\n")
                ));
                cpu_fallback_used = true;
                oversize_retries_for_encoder = 0;
                attempt_index += 1;
                attempt = cpu_fallback_attempt(
                    attempt.video_bitrate_k,
                    "Retrying with CPU encoder...".into(),
                );
                continue;
            }

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
            remove_partial_output(&opts.output_path);
            let _ = app.emit(
                "compress-done",
                serde_json::json!({"success": false, "message": err_msg}),
            );
            return Err(err_msg);
        }

        let output_size = match std::fs::metadata(&opts.output_path) {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                let message =
                    format!("Compression finished but output file could not be read: {error}");
                vidcord_log(&message);
                remove_partial_output(&opts.output_path);
                let _ = app.emit(
                    "compress-done",
                    serde_json::json!({"success": false, "message": message}),
                );
                return Err(message);
            }
        };
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
            let _ = app.emit(
                "compress-done",
                serde_json::json!({
                    "success": true,
                    "message": message,
                    "output_path": &opts.output_path,
                    "output_size_bytes": output_size,
                    "target_size_bytes": target_bytes,
                    "attempt": attempt_index + 1,
                    "attempt_total": total_attempts,
                    "encoder": attempt.encoder.as_str(),
                    "video_bitrate_k": attempt.video_bitrate_k
                }),
            );
            output_reservation.commit();
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

        let Some(limit) = target_bytes else {
            break;
        };
        let Some((next_attempt, next_oversize_retries, next_cpu_fallback_used)) =
            next_oversize_attempt(
                &attempt,
                limit,
                output_size,
                oversize_retries_for_encoder,
                cpu_fallback_used,
            )
        else {
            break;
        };
        attempt_index += 1;
        attempt = next_attempt;
        oversize_retries_for_encoder = next_oversize_retries;
        cpu_fallback_used = next_cpu_fallback_used;
    }

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
pub async fn cancel_compression() -> bool {
    let pid = {
        let mut state = compression_state()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let had_active_job = state.active_job_id.is_some();
        let pid = state.cancel_active();
        if !had_active_job {
            return false;
        }
        pid
    };

    if let Some(pid) = pid {
        let _ = tokio::task::spawn_blocking(move || terminate_compression_process(pid)).await;
    }
    true
}

#[cfg(unix)]
fn terminate_compression_process(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

#[cfg(windows)]
fn terminate_compression_process(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .output();
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
    fn bounded_record_reader_splits_cr_and_lf() {
        let mut reader = std::io::Cursor::new(b"first\nsecond\r\nthird".as_slice());
        let mut records = Vec::new();
        read_bounded_records(&mut reader, |record, truncated| {
            records.push((record.to_vec(), truncated));
        })
        .unwrap();

        assert_eq!(
            records,
            vec![
                (b"first".to_vec(), false),
                (b"second".to_vec(), false),
                (b"third".to_vec(), false),
            ]
        );
    }

    #[test]
    fn bounded_record_reader_discards_oversized_record_tail() {
        let mut input = vec![b'x'; MAX_FFMPEG_STDERR_RECORD_BYTES + 4096];
        input.extend_from_slice(b"\nnext\r");
        let mut reader = std::io::Cursor::new(input);
        let mut records = Vec::new();
        read_bounded_records(&mut reader, |record, truncated| {
            records.push((record.len(), truncated));
        })
        .unwrap();

        assert_eq!(
            records,
            vec![(MAX_FFMPEG_STDERR_RECORD_BYTES, true), (4, false)]
        );
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

    fn retry_test_options(encoder: &str, target_size_mb: Option<f64>) -> CompressOptions {
        CompressOptions {
            input_path: "input.mp4".into(),
            output_path: "output.mp4".into(),
            encoder: encoder.into(),
            video_bitrate_k: 900,
            target_size_mb,
            start_time: 0.0,
            end_time: 60.0,
            remove_audio: false,
            output_fps: None,
            scale_filter: None,
            vaapi_device: None,
        }
    }

    #[test]
    fn test_video_filter_adds_fps_before_software_scale() {
        let mut opts = retry_test_options("libx264", None);
        opts.output_fps = Some(30.0);
        opts.scale_filter = Some("scale=1280:720".into());

        assert_eq!(
            video_filter_for_encoder(&opts, "libx264"),
            "fps=30,scale=1280:720"
        );
    }

    #[test]
    fn test_video_filter_adds_fps_before_vaapi_upload() {
        let mut opts = retry_test_options("h264_vaapi", None);
        opts.output_fps = Some(24.0);
        opts.scale_filter = Some("1280:720".into());

        assert_eq!(
            video_filter_for_encoder(&opts, "h264_vaapi"),
            "fps=24,format=nv12,hwupload,scale_vaapi=1280:720"
        );
    }

    #[test]
    fn test_output_fps_validation_rejects_invalid_values() {
        assert!(valid_output_fps(None));
        assert!(valid_output_fps(Some(60.0)));
        assert!(!valid_output_fps(Some(0.0)));
        assert!(!valid_output_fps(Some(f64::INFINITY)));
        assert!(!valid_output_fps(Some(1000.1)));
    }

    #[test]
    fn test_scale_filter_validation_accepts_only_generated_forms() {
        assert!(valid_scale_filter(None));
        assert!(valid_scale_filter(Some("scale=1280:720")));
        assert!(valid_scale_filter(Some("1280:720")));
        assert!(valid_scale_filter(Some(
            "scale=trunc(iw/2)*2:trunc(ih/2)*2"
        )));
        assert!(valid_scale_filter(Some("iw:ih")));
        assert!(!valid_scale_filter(Some("scale=0:720")));
        assert!(!valid_scale_filter(Some("scale=1280:720,movie=secret")));
        assert!(!valid_scale_filter(Some("movie=/tmp/secret")));
    }

    #[test]
    fn test_vaapi_device_validation_rejects_untrusted_values() {
        assert!(valid_vaapi_device(None));
        #[cfg(target_os = "linux")]
        {
            assert!(valid_vaapi_device(Some("/dev/dri/renderD128")));
            assert!(!valid_vaapi_device(Some("/dev/dri/card0")));
            assert!(!valid_vaapi_device(Some("/tmp/renderD128")));
            assert!(!valid_vaapi_device(Some("/dev/dri/renderD128,extra=value")));
        }
        #[cfg(not(target_os = "linux"))]
        assert!(!valid_vaapi_device(Some("/dev/dri/renderD128")));
    }

    #[test]
    fn test_time_range_validation_rejects_non_finite_and_negative_values() {
        assert!(valid_time_range(0.0, 60.0));
        assert!(valid_time_range(10.0, 10.001));
        assert!(!valid_time_range(-1.0, 60.0));
        assert!(!valid_time_range(10.0, 10.0));
        assert!(!valid_time_range(10.0, 9.0));
        assert!(!valid_time_range(f64::NAN, 60.0));
        assert!(!valid_time_range(0.0, f64::INFINITY));
    }

    #[test]
    fn test_target_size_validation_rejects_invalid_and_overflowing_values() {
        assert_eq!(target_size_bytes(None), Ok(None));
        assert_eq!(target_size_bytes(Some(1.0)), Ok(Some(1024 * 1024)));
        assert!(target_size_bytes(Some(0.0)).is_err());
        assert!(target_size_bytes(Some(f64::NAN)).is_err());
        assert!(target_size_bytes(Some(f64::MAX)).is_err());
    }

    #[test]
    fn test_adaptive_retry_reduces_selected_encoder_before_cpu_fallback() {
        let mut attempt = CompressionAttempt {
            encoder: "h264_nvenc".into(),
            video_bitrate_k: 900,
            status: "Compressing...".into(),
        };

        let (next, retries, cpu_used) =
            next_oversize_attempt(&attempt, 1_000, 2_000, 0, false).unwrap();
        assert_eq!(next.encoder, "h264_nvenc");
        assert_eq!(next.video_bitrate_k, 432);
        assert_eq!(retries, 1);
        assert!(!cpu_used);

        attempt = next;
        let (next, retries, cpu_used) =
            next_oversize_attempt(&attempt, 1_000, 1_500, retries, cpu_used).unwrap();
        assert_eq!(next.encoder, "libx264");
        assert_eq!(next.video_bitrate_k, 276);
        assert_eq!(retries, 0);
        assert!(cpu_used);
    }

    #[test]
    fn test_cpu_adaptive_retry_caps_without_cpu_fallback_duplication() {
        let first = CompressionAttempt {
            encoder: "libx264".into(),
            video_bitrate_k: 900,
            status: "Compressing...".into(),
        };
        let (second, retries, cpu_used) =
            next_oversize_attempt(&first, 1_000, 2_000, 0, true).unwrap();
        assert_eq!(second.encoder, "libx264");
        assert_eq!(second.video_bitrate_k, 432);
        assert_eq!(retries, 1);
        assert!(cpu_used);

        assert!(next_oversize_attempt(&second, 1_000, 2_000, retries, cpu_used).is_none());
    }

    #[test]
    fn test_adaptive_bitrate_has_safety_margin_and_minimum() {
        assert_eq!(adaptive_bitrate_for_oversize(1_000, 900, 1_000), 864);
        assert_eq!(adaptive_bitrate_for_oversize(120, 1, 10_000), 100);
    }

    #[test]
    fn test_adaptive_attempt_caps() {
        let hardware = retry_test_options("h264_nvenc", Some(100.0));
        let cpu = retry_test_options("libx264", Some(100.0));
        let no_target = retry_test_options("h264_nvenc", None);

        assert_eq!(max_adaptive_attempts(&hardware, true), 4);
        assert_eq!(max_adaptive_attempts(&cpu, true), 2);
        assert_eq!(max_adaptive_attempts(&no_target, false), 2);
        assert_eq!(max_adaptive_attempts(&cpu, false), 1);
        assert_eq!(initial_attempt(&no_target).video_bitrate_k, 900);
    }

    #[test]
    fn test_hardware_target_policy_runs_cpu_adjusted_retry() {
        let opts = retry_test_options("h264_nvenc", Some(100.0));
        let mut attempts = vec![initial_attempt(&opts)];
        let mut oversize_retries = 0;
        let mut cpu_fallback_used = false;

        for output_size in [2_000, 1_500, 1_300] {
            let (next, next_retries, next_cpu_used) = next_oversize_attempt(
                attempts.last().unwrap(),
                1_000,
                output_size,
                oversize_retries,
                cpu_fallback_used,
            )
            .unwrap();
            attempts.push(next);
            oversize_retries = next_retries;
            cpu_fallback_used = next_cpu_used;
        }

        assert_eq!(attempts.len(), max_adaptive_attempts(&opts, true));
        assert_eq!(
            attempts
                .iter()
                .map(|attempt| attempt.encoder.as_str())
                .collect::<Vec<_>>(),
            vec!["h264_nvenc", "h264_nvenc", "libx264", "libx264"]
        );
        assert!(attempts[3].video_bitrate_k < attempts[2].video_bitrate_k);
        assert!(next_oversize_attempt(
            attempts.last().unwrap(),
            1_000,
            1_300,
            oversize_retries,
            cpu_fallback_used,
        )
        .is_none());
    }

    #[test]
    fn compression_state_prevents_overlapping_jobs_and_stale_cleanup() {
        let mut state = CompressionState {
            next_job_id: 0,
            active_job_id: None,
            pid: None,
            output_path: None,
            cancelled: false,
        };

        let first = state.try_begin_job().unwrap();
        assert!(state.try_begin_job().is_none());
        assert!(state.register_process(first, 42, "first.mp4".into()));
        assert_eq!(state.cancel_active(), Some(42));
        assert!(state.is_cancelled(first));

        state.finish_job(first);
        let second = state.try_begin_job().unwrap();
        assert_ne!(first, second);
        state.finish_job(first);
        assert_eq!(state.active_job_id, Some(second));
    }

    #[test]
    fn output_reservation_never_clobbers_and_cleans_uncommitted_files() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vidcord-output-reservation-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let existing = dir.join("existing.mp4");
        std::fs::write(&existing, b"original").unwrap();
        assert!(OutputReservation::create(existing.to_string_lossy().into_owned()).is_err());
        assert_eq!(std::fs::read(&existing).unwrap(), b"original");

        let temporary = dir.join("temporary.mp4");
        let reservation =
            OutputReservation::create(temporary.to_string_lossy().into_owned()).unwrap();
        assert!(temporary.exists());
        drop(reservation);
        assert!(!temporary.exists());

        let completed = dir.join("completed.mp4");
        let mut reservation =
            OutputReservation::create(completed.to_string_lossy().into_owned()).unwrap();
        std::fs::write(&completed, b"encoded").unwrap();
        reservation.commit();
        drop(reservation);
        assert_eq!(std::fs::read(&completed).unwrap(), b"encoded");

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn test_encoder_name_valid() {
        assert!(valid_encoder_name("libx264"));
        assert!(valid_encoder_name("h264_nvenc"));
        assert!(valid_encoder_name("h264_vaapi"));
    }

    #[test]
    fn test_encoder_name_invalid() {
        assert!(!valid_encoder_name(""));
        assert!(!valid_encoder_name("libx264; rm -rf /"));
        assert!(!valid_encoder_name("../../../bin/sh"));
        assert!(!valid_encoder_name("libx264 -vf evil"));
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
