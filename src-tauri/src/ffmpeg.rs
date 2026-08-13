use crate::log::vidcord_log;
use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Read};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

mod encoders;

pub use encoders::{
    get_available_encoders, get_or_discover_encoder_listing, invalidate_encoder_cache,
};

static VAAPI_CACHE: OnceLock<Option<String>> = OnceLock::new();
#[cfg(target_os = "linux")]
static LINUX_AMD_DRM_DEVICE: OnceLock<bool> = OnceLock::new();

pub const FFMPEG_MISSING_ERROR_MARKER: &str = "FFMPEG_MISSING:";
const PREVIEW_CANCELLED_ERROR_MARKER: &str = "PREVIEW_CANCELLED:";
const PREVIEW_TIMEOUT_ERROR_MARKER: &str = "PREVIEW_TIMEOUT:";
const PROBE_CANCELLED_ERROR_MARKER: &str = "PROBE_CANCELLED:";
const FFPROBE_TIMEOUT: Duration = Duration::from_secs(6);
const PREVIEW_FRAME_TIMEOUT: Duration = Duration::from_secs(10);
const PREVIEW_FILMSTRIP_TIMEOUT: Duration = Duration::from_secs(30);
const PREVIEW_CLIP_TIMEOUT: Duration = Duration::from_secs(30);
const PREVIEW_FRAME_OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;
const PREVIEW_FRAME_CACHE_MAX_ENTRIES: usize = 60;
const PREVIEW_FRAME_CACHE_MAX_BYTES: usize = 16 * 1024 * 1024;
const PREVIEW_FILMSTRIP_OUTPUT_LIMIT: u64 = 32 * 1024 * 1024;
const PREVIEW_CLIP_OUTPUT_LIMIT: u64 = 64 * 1024 * 1024;
const PREVIEW_CLIP_FAILED_PLAN_MAX_ENTRIES: usize = 128;
const PREVIEW_CLIP_FAILED_PLAN_TTL: Duration = Duration::from_secs(10 * 60);
#[cfg(target_os = "linux")]
const VAAPI_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(6);
#[cfg(target_os = "linux")]
const VAAPI_DEVICE_TIMEOUT: Duration = Duration::from_secs(2);

static PREVIEW_GENERATION: AtomicU64 = AtomicU64::new(0);
static PREVIEW_PIDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
static PREVIEW_FRAME_GENERATION: AtomicU64 = AtomicU64::new(0);
static PREVIEW_FRAME_PIDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
static PROBE_GENERATION: AtomicU64 = AtomicU64::new(0);
static PROBE_PIDS: OnceLock<Mutex<HashMap<u32, u64>>> = OnceLock::new();
static LOSSLESS_TRIM_REQUEST: AtomicU64 = AtomicU64::new(0);
static LOSSLESS_TRIM_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn ffmpeg_missing_error() -> String {
    format!(
        "{FFMPEG_MISSING_ERROR_MARKER} FFmpeg was not found on PATH. Install FFmpeg and restart vidcord."
    )
}

fn probe_command_output(
    cmd: &mut Command,
    generation: u64,
) -> Result<Output, Box<dyn std::error::Error>> {
    if PROBE_GENERATION.load(Ordering::Acquire) != generation {
        return Err(format!("{PROBE_CANCELLED_ERROR_MARKER} Probe was cancelled.").into());
    }
    let child = match crate::gpu::spawn_captured_command(cmd) {
        Ok(child) => child,
        Err(err) if err.kind() == ErrorKind::NotFound => return Err(ffmpeg_missing_error().into()),
        Err(err) => return Err(Box::new(err)),
    };
    let pid = child.id();
    let pids = PROBE_PIDS.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let mut guard = pids.lock().unwrap_or_else(|e| e.into_inner());
        if PROBE_GENERATION.load(Ordering::Acquire) != generation {
            terminate_preview_process(pid);
            let _ = child.wait_for_output(Duration::from_secs(1));
            return Err(format!("{PROBE_CANCELLED_ERROR_MARKER} Probe was cancelled.").into());
        }
        guard.insert(pid, generation);
    }
    let output = child.wait_for_output(FFPROBE_TIMEOUT);
    pids.lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
    match output {
        Ok(Some(output)) => {
            if PROBE_GENERATION.load(Ordering::Acquire) != generation {
                Err(format!("{PROBE_CANCELLED_ERROR_MARKER} Probe was cancelled.").into())
            } else {
                Ok(output)
            }
        }
        Ok(None) => Err(format!(
            "ffprobe timed out after {} seconds.",
            FFPROBE_TIMEOUT.as_secs()
        )
        .into()),
        Err(err) => Err(Box::new(err)),
    }
}

fn preview_generation() -> u64 {
    PREVIEW_GENERATION.load(Ordering::Acquire)
}

fn preview_cancelled_error() -> Box<dyn std::error::Error> {
    format!("{PREVIEW_CANCELLED_ERROR_MARKER} Preview generation was cancelled.").into()
}

fn is_preview_cancelled_error(err: &dyn std::error::Error) -> bool {
    err.to_string().starts_with(PREVIEW_CANCELLED_ERROR_MARKER)
}

fn is_preview_timeout_error(err: &dyn std::error::Error) -> bool {
    err.to_string().starts_with(PREVIEW_TIMEOUT_ERROR_MARKER)
}

#[cfg(unix)]
fn terminate_preview_process(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

#[cfg(windows)]
fn terminate_preview_process(pid: u32) {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(0x08000000);
    let Ok(mut child) = command.spawn() else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
}

pub fn cancel_preview_jobs() {
    PREVIEW_GENERATION.fetch_add(1, Ordering::AcqRel);
    PREVIEW_FRAME_GENERATION.fetch_add(1, Ordering::AcqRel);
    for pids in [
        PREVIEW_PIDS.get_or_init(|| Mutex::new(HashSet::new())),
        PREVIEW_FRAME_PIDS.get_or_init(|| Mutex::new(HashSet::new())),
    ] {
        let active: Vec<u32> = pids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .copied()
            .collect();
        for pid in active {
            terminate_preview_process(pid);
        }
    }
}

/// Cancels only single-frame preview requests. Filmstrip and generated-clip
/// work keeps its own generation so rapid scrubbing cannot terminate a strip
/// that is still filling the fallback timeline.
pub fn cancel_preview_frame_jobs() {
    PREVIEW_FRAME_GENERATION.fetch_add(1, Ordering::AcqRel);
    let pids = PREVIEW_FRAME_PIDS.get_or_init(|| Mutex::new(HashSet::new()));
    let active: Vec<u32> = pids
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .copied()
        .collect();
    for pid in active {
        terminate_preview_process(pid);
    }
}

pub fn start_probe_generation() -> u64 {
    PROBE_GENERATION
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1)
}

pub fn register_lossless_trim_probe(request_id: u64, generation: u64) {
    LOSSLESS_TRIM_REQUEST.store(request_id, Ordering::Release);
    LOSSLESS_TRIM_GENERATION.store(generation, Ordering::Release);
}

pub fn cancel_lossless_trim_probe(request_id: u64) {
    if request_id == 0
        || LOSSLESS_TRIM_REQUEST
            .compare_exchange(request_id, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return;
    }
    let generation = LOSSLESS_TRIM_GENERATION.load(Ordering::Acquire);
    if PROBE_GENERATION.load(Ordering::Acquire) == generation {
        PROBE_GENERATION.fetch_add(1, Ordering::AcqRel);
    }
    let pids = PROBE_PIDS.get_or_init(|| Mutex::new(HashMap::new()));
    let active: Vec<u32> = pids
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter_map(|(&pid, &owner)| (owner == generation).then_some(pid))
        .collect();
    for pid in active {
        terminate_preview_process(pid);
    }
}

pub fn cancel_superseded_probe_jobs(generation: u64) {
    if PROBE_GENERATION.load(Ordering::Acquire) != generation {
        return;
    }
    let pids = PROBE_PIDS.get_or_init(|| Mutex::new(HashMap::new()));
    let active: Vec<u32> = {
        let guard = pids.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .iter()
            .filter_map(|(&pid, &owner)| (owner != generation).then_some(pid))
            .collect()
    };
    for pid in active {
        if PROBE_GENERATION.load(Ordering::Acquire) != generation {
            break;
        }
        let still_superseded = pids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&pid)
            .is_some_and(|owner| *owner != generation);
        if still_superseded {
            terminate_preview_process(pid);
        }
    }
}

struct PreviewCommandOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
}

fn preview_command_output(
    cmd: &mut Command,
    generation: u64,
    frame_generation: Option<u64>,
    timeout: Duration,
    output_limit: u64,
) -> Result<PreviewCommandOutput, Box<dyn std::error::Error>> {
    let is_current = || {
        preview_generation() == generation
            && frame_generation
                .map(|value| PREVIEW_FRAME_GENERATION.load(Ordering::Acquire) == value)
                .unwrap_or(true)
    };
    if !is_current() {
        return Err(preview_cancelled_error());
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) if err.kind() == ErrorKind::NotFound => return Err(ffmpeg_missing_error().into()),
        Err(err) => return Err(Box::new(err)),
    };
    let pid = child.id();
    let pids = if frame_generation.is_some() {
        PREVIEW_FRAME_PIDS.get_or_init(|| Mutex::new(HashSet::new()))
    } else {
        PREVIEW_PIDS.get_or_init(|| Mutex::new(HashSet::new()))
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("FFmpeg preview did not expose stdout".into());
    };
    let output_limit = output_limit.min(usize::MAX as u64) as usize;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::with_capacity(output_limit.min(64 * 1024));
        stdout
            .by_ref()
            .take(output_limit.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    {
        let mut guard = pids.lock().unwrap_or_else(|e| e.into_inner());
        if !is_current() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(preview_cancelled_error());
        }
        guard.insert(pid);
    }

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if !is_current() => {
                terminate_preview_process(pid);
                let _ = child.kill();
                let _ = child.wait();
                break Err(preview_cancelled_error());
            }
            Ok(None) if Instant::now() >= deadline => {
                terminate_preview_process(pid);
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!(
                    "{PREVIEW_TIMEOUT_ERROR_MARKER} FFmpeg preview timed out after {} seconds.",
                    timeout.as_secs()
                )
                .into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(err) => break Err(Box::new(err) as Box<dyn std::error::Error>),
        }
    };
    pids.lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
    let status = status?;
    let stdout = reader
        .join()
        .map_err(|_| "FFmpeg preview output reader panicked")??;
    if stdout.len() > output_limit {
        return Err(format!("FFmpeg preview output exceeded {output_limit} bytes").into());
    }
    if !is_current() {
        return Err(preview_cancelled_error());
    }
    Ok(PreviewCommandOutput { status, stdout })
}

fn preview_deadline(timeout: Duration) -> Instant {
    Instant::now()
        .checked_add(timeout)
        .unwrap_or_else(Instant::now)
}

fn remaining_preview_time(deadline: Instant) -> Result<Duration, Box<dyn std::error::Error>> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(
            format!("{PREVIEW_TIMEOUT_ERROR_MARKER} FFmpeg preview operation timed out.").into(),
        );
    }
    Ok(remaining)
}

const PREVIEW_CLIP_BITRATE: &str = "2500k";
const MAX_GENERATED_PREVIEW_CLIP_SECONDS: f64 = 12.0;
const SPARSE_FILMSTRIP_THRESHOLD_SEC: f64 = 3.0 * 60.0;
const DEFAULT_PREVIEW_IMAGE_WIDTH: u32 = 720;
const DEFAULT_PREVIEW_IMAGE_HEIGHT: u32 = 480;
const MIN_PREVIEW_IMAGE_DIM: u32 = 240;
const MAX_PREVIEW_IMAGE_WIDTH: u32 = 960;
const MAX_PREVIEW_IMAGE_HEIGHT: u32 = 1080;

fn should_use_sparse_filmstrip(duration_sec: f64) -> bool {
    duration_sec >= SPARSE_FILMSTRIP_THRESHOLD_SEC
}

fn filmstrip_frame_count(duration_sec: f64, max_frames: Option<usize>) -> usize {
    let frame_limit = max_frames.unwrap_or(30).clamp(2, 30);
    (duration_sec.floor() as usize).clamp(2, frame_limit)
}

fn push_auto_hwaccel_args(args: &mut Vec<String>) {
    args.extend(["-hwaccel".into(), "auto".into()]);
}

fn finite_non_negative(seconds: f64) -> f64 {
    if seconds.is_finite() {
        seconds.max(0.0)
    } else {
        0.0
    }
}

fn format_time_arg(seconds: f64) -> String {
    format!("{:.3}", finite_non_negative(seconds))
}

fn time_to_100ms(seconds: f64) -> u64 {
    (finite_non_negative(seconds) * 10.0).round() as u64
}

fn even_dimension(value: u32) -> u32 {
    value.max(2) & !1
}

fn normalize_preview_dimensions(width: Option<u32>, height: Option<u32>) -> (u32, u32) {
    let width = width
        .unwrap_or(DEFAULT_PREVIEW_IMAGE_WIDTH)
        .clamp(MIN_PREVIEW_IMAGE_DIM, MAX_PREVIEW_IMAGE_WIDTH);
    let height = height
        .unwrap_or(DEFAULT_PREVIEW_IMAGE_HEIGHT)
        .clamp(MIN_PREVIEW_IMAGE_DIM, MAX_PREVIEW_IMAGE_HEIGHT);

    (even_dimension(width), even_dimension(height))
}

fn preview_jpeg_scale_filter(width: u32, height: u32) -> String {
    format!(
        "scale=w={width}:h={height}:flags=fast_bilinear:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1"
    )
}

// ---------------------------------------------------------------------------
// FFmpeg environment
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn linux_has_amd_drm_device() -> bool {
    *LINUX_AMD_DRM_DEVICE.get_or_init(|| {
        let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
            return false;
        };
        entries.flatten().any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("card")
                && !name.contains('-')
                && std::fs::read_to_string(entry.path().join("device/vendor"))
                    .is_ok_and(|vendor| vendor.trim().eq_ignore_ascii_case("0x1002"))
        })
    })
}

#[cfg(any(target_os = "linux", test))]
fn without_appimage_library_paths(appdir: &str, library_path: &str) -> String {
    let appdir = appdir.trim_end_matches('/');
    if appdir.is_empty() {
        return library_path.to_string();
    }
    library_path
        .split(':')
        .filter(|entry| {
            *entry != appdir
                && !entry
                    .strip_prefix(appdir)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
        .collect::<Vec<_>>()
        .join(":")
}

#[allow(unused_variables)]
pub fn configure_ffmpeg_command(command: &mut Command) {
    #[cfg(target_os = "linux")]
    if std::env::var_os("LIBVA_DRIVER_NAME").is_none()
        && (linux_has_amd_drm_device() || crate::gpu::cached_system_has_gpu("amd"))
    {
        // Prefer the zero-process sysfs check on cold imports. The previous
        // implementation synchronously ran lspci before even ffprobe could
        // start, delaying Open With by the full GPU-discovery timeout on a
        // missing or wedged helper.
        command.env("LIBVA_DRIVER_NAME", "radeonsi");
    }

    #[cfg(target_os = "linux")]
    if let (Ok(appdir), Ok(library_path)) =
        (std::env::var("APPDIR"), std::env::var("LD_LIBRARY_PATH"))
    {
        // AppRun prepends bundled libraries so vidcord itself stays portable.
        // Host FFmpeg binaries must use host libraries instead: mixing the two
        // can fail before main() with symbol/version errors on newer distros.
        let library_path = without_appimage_library_paths(&appdir, &library_path);
        command.env_remove("LD_LIBRARY_PATH");
        if !library_path.is_empty() {
            command.env("LD_LIBRARY_PATH", library_path);
        }
    }
}

// ---------------------------------------------------------------------------
// Video probing
// ---------------------------------------------------------------------------

pub fn probe_video(
    path: &str,
    generation: u64,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    fn parse_ratio(ratio: &str) -> Option<(f64, f64)> {
        let mut parts = ratio.split(':');
        let num = parts.next()?.trim().parse::<f64>().ok()?;
        let den = parts.next()?.trim().parse::<f64>().ok()?;
        if num > 0.0 && den > 0.0 {
            Some((num, den))
        } else {
            None
        }
    }

    fn parse_rate(rate: &str) -> Option<f64> {
        let mut parts = rate.split('/');
        let num = parts.next()?.trim().parse::<f64>().ok()?;
        let den = parts.next()?.trim().parse::<f64>().ok()?;
        if num > 0.0 && den > 0.0 {
            Some(num / den)
        } else {
            None
        }
    }

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffprobe");
    cmd.args([
        "-v",
        "quiet",
        "-probesize",
        "10000000",
        "-analyzeduration",
        "5000000",
        "-print_format",
        "json",
        "-show_entries",
        "format=duration,bit_rate:stream=index,codec_name,codec_type,width,height,avg_frame_rate,r_frame_rate,sample_aspect_ratio,display_aspect_ratio,bit_rate,channels,duration,size:stream_tags=title,name,language,handler_name:stream_side_data=rotation",
        path,
    ]);
    configure_ffmpeg_command(&mut cmd);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = probe_command_output(&mut cmd, generation)?;

    if !out.status.success() {
        return Err(format!("ffprobe failed: {}", String::from_utf8_lossy(&out.stderr)).into());
    }

    let data: serde_json::Value = serde_json::from_slice(&out.stdout)?;
    let format = &data["format"];
    let duration: f64 = format["duration"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    let streams = data["streams"].as_array().ok_or("No streams")?;
    let video = streams
        .iter()
        .find(|s| s["codec_type"].as_str() == Some("video"))
        .ok_or("No video stream")?;

    let width = video["width"].as_u64().unwrap_or(0);
    let height = video["height"].as_u64().unwrap_or(0);
    let codec = video["codec_name"].as_str().unwrap_or("unknown");
    let frame_rate = video["avg_frame_rate"]
        .as_str()
        .and_then(parse_rate)
        .or_else(|| video["r_frame_rate"].as_str().and_then(parse_rate))
        .unwrap_or(0.0);

    let mut display_width = width as f64;
    let mut display_height = height as f64;

    if let Some(sar) = video["sample_aspect_ratio"].as_str() {
        if let Some((sar_num, sar_den)) = parse_ratio(sar) {
            display_width *= sar_num / sar_den;
        }
    }

    if let Some(dar) = video["display_aspect_ratio"].as_str() {
        if let Some((dar_num, dar_den)) = parse_ratio(dar) {
            let ratio = dar_num / dar_den;
            if ratio > 0.0 && display_width > 0.0 {
                display_height = display_width / ratio;
            }
        }
    }

    let rotation = video["side_data_list"]
        .as_array()
        .and_then(|items| {
            items.iter().find_map(|item| {
                item["rotation"].as_i64().or_else(|| {
                    item["rotation"]
                        .as_str()
                        .and_then(|s| s.parse::<i64>().ok())
                })
            })
        })
        .unwrap_or(0)
        .rem_euclid(360);

    if rotation == 90 || rotation == 270 {
        std::mem::swap(&mut display_width, &mut display_height);
    }

    let display_width = display_width.max(1.0).round() as u64;
    let display_height = display_height.max(1.0).round() as u64;

    let bitrate = video["bit_rate"]
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .map(|b| b / 1000)
        .or_else(|| {
            format["bit_rate"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .map(|b| b / 1000)
        })
        .unwrap_or(0);

    let audio_tracks = streams
        .iter()
        .filter(|stream| stream["codec_type"].as_str() == Some("audio"))
        .enumerate()
        .map(|(audio_index, stream)| {
            let bitrate_bps = stream["bit_rate"]
                .as_str()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            let track_duration = stream["duration"]
                .as_str()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(duration);
            let estimated_size_bytes = if bitrate_bps > 0 && track_duration > 0.0 {
                ((bitrate_bps as f64 * track_duration / 8.0)
                    .min(u64::MAX as f64)
                    .round()) as u64
            } else {
                0
            };
            let size_bytes = stream["size"]
                .as_str()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(estimated_size_bytes);
            let title = stream["tags"]["title"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::trim)
                .map(str::to_owned);
            let tagged_name = stream["tags"]["name"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(str::trim)
                .map(str::to_owned);
            let handler_name = stream["tags"]["handler_name"]
                .as_str()
                .filter(|value| {
                    let value = value.trim();
                    !value.is_empty()
                        && !value.eq_ignore_ascii_case("soundhandler")
                        && !value.eq_ignore_ascii_case("core media audio")
                })
                .map(str::trim)
                .map(str::to_owned);
            let language = stream["tags"]["language"]
                .as_str()
                .filter(|value| !value.trim().is_empty() && !value.eq_ignore_ascii_case("und"))
                .map(str::trim)
                .map(str::to_owned);
            let name = title
                .or(tagged_name)
                .or(handler_name)
                .or(language)
                .unwrap_or_else(|| format!("Track {}", audio_index + 1));

            serde_json::json!({
                "index": audio_index,
                "name": name,
                "codec": stream["codec_name"].as_str().unwrap_or("unknown"),
                "bitrate_kbps": bitrate_bps as f64 / 1000.0,
                "duration": track_duration,
                "size_bytes": size_bytes,
                "channels": stream["channels"].as_u64().unwrap_or(1)
            })
        })
        .collect::<Vec<_>>();

    Ok(serde_json::json!({
        "duration": duration,
        "width": width,
        "height": height,
        "display_width": display_width,
        "display_height": display_height,
        "frame_rate": frame_rate,
        "bitrate": bitrate,
        "codec": codec,
        "audio_tracks": audio_tracks
    }))
}

fn lossless_container_extension(path: &str, format_name: &str) -> Option<&'static str> {
    if let Some(extension) = std::path::Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        match extension.to_ascii_lowercase().as_str() {
            "mp4" => return Some("mp4"),
            "mov" => return Some("mov"),
            "mkv" => return Some("mkv"),
            "webm" => return Some("webm"),
            "avi" => return Some("avi"),
            "flv" => return Some("flv"),
            "wmv" => return Some("wmv"),
            _ => {}
        }
    }

    format_name.split(',').find_map(|name| match name.trim() {
        "mp4" | "mov" => Some("mp4"),
        "matroska" => Some("mkv"),
        "webm" => Some("webm"),
        "avi" => Some("avi"),
        "flv" => Some("flv"),
        "asf" => Some("wmv"),
        _ => None,
    })
}

pub fn probe_lossless_trim_info(
    path: &str,
    generation: u64,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffprobe");
    cmd.args([
        "-v",
        "quiet",
        "-probesize",
        "10000000",
        "-analyzeduration",
        "5000000",
        "-skip_frame",
        "nokey",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time:format=format_name",
        "-print_format",
        "json",
        path,
    ]);
    configure_ffmpeg_command(&mut cmd);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = probe_command_output(&mut cmd, generation)?;
    if !out.status.success() {
        return Err(format!(
            "ffprobe keyframe discovery failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )
        .into());
    }

    let data: serde_json::Value = serde_json::from_slice(&out.stdout)?;
    let format_name = data["format"]["format_name"]
        .as_str()
        .ok_or("FFprobe did not report a source container")?;
    let source_container_extension = lossless_container_extension(path, format_name);
    let frames = data["frames"]
        .as_array()
        .ok_or("FFprobe did not report keyframes")?;
    let mut keyframe_times = Vec::with_capacity(frames.len());
    for frame in frames {
        let Some(value) = frame["best_effort_timestamp_time"].as_str() else {
            continue;
        };
        let timestamp = value.parse::<f64>()?;
        if timestamp.is_finite() && timestamp >= 0.0 {
            keyframe_times.push(timestamp);
        }
    }
    keyframe_times.sort_by(f64::total_cmp);
    keyframe_times.dedup_by(|left, right| (*left - *right).abs() < 0.0005);
    if keyframe_times.is_empty() {
        return Err("FFprobe did not report usable keyframes".into());
    }

    Ok(serde_json::json!({
        "keyframe_times": keyframe_times,
        "source_container_extension": source_container_extension
    }))
}

#[cfg(test)]
pub fn best_audio_stream_from_json(data: &serde_json::Value) -> Option<usize> {
    let streams = data["streams"].as_array()?;
    if streams.is_empty() {
        return None;
    }

    let mut best_idx = 0;
    let mut max_score: u64 = 0;

    for (a_idx, stream) in streams.iter().enumerate() {
        let bitrate = stream["bit_rate"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let channels = stream["channels"].as_u64().unwrap_or(1);
        let duration = stream["duration"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(1.0);

        let score = if bitrate > 0 {
            (bitrate as f64 * duration) as u64
        } else {
            channels * 1000
        };

        if score > max_score {
            max_score = score;
            best_idx = a_idx;
        }
    }

    Some(best_idx)
}

// ---------------------------------------------------------------------------
// Preview frame cache — avoids re-spawning FFmpeg for recently-seen positions
// ---------------------------------------------------------------------------

use std::hash::{Hash, Hasher};

struct FrameCacheEntry {
    // Arc so cache hits return cheaply; a 15–30 KB JPEG is never memcpy'd
    // when the frontend re-scrubs over the same timecode during a debounce.
    data: Arc<Vec<u8>>,
    last_used: std::time::Instant,
}

struct FrameCache {
    // (path_hash, time_100ms) → JPEG bytes
    entries: std::collections::HashMap<(u64, u64, u32, u32), FrameCacheEntry>,
    max_entries: usize,
    max_bytes: usize,
    total_bytes: usize,
}

impl FrameCache {
    fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: std::collections::HashMap::new(),
            max_entries,
            max_bytes,
            total_bytes: 0,
        }
    }

    fn get(&mut self, key: (u64, u64, u32, u32)) -> Option<Arc<Vec<u8>>> {
        self.entries.get_mut(&key).map(|entry| {
            entry.last_used = std::time::Instant::now();
            Arc::clone(&entry.data)
        })
    }

    fn insert(&mut self, key: (u64, u64, u32, u32), data: Arc<Vec<u8>>) {
        if self.entries.contains_key(&key) {
            return;
        }
        let data_len = data.len();
        if data_len > self.max_bytes {
            return;
        }
        // LRU eviction: pick the least-recently-used entry (not just the
        // oldest inserted) so re-scrubbed frames survive longer. The byte
        // ceiling prevents high-entropy, high-DPI JPEGs from multiplying the
        // cache's memory footprint despite the bounded entry count.
        while self.entries.len() >= self.max_entries
            || self.total_bytes.saturating_add(data_len) > self.max_bytes
        {
            let oldest_key = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(k, _)| *k);
            match oldest_key {
                Some(k) => {
                    if let Some(removed) = self.entries.remove(&k) {
                        self.total_bytes = self.total_bytes.saturating_sub(removed.data.len());
                    }
                }
                None => break,
            }
        }
        self.entries.insert(
            key,
            FrameCacheEntry {
                data,
                last_used: std::time::Instant::now(),
            },
        );
        self.total_bytes += data_len;
    }

    fn clear_path(&mut self, source_hash: u64) {
        let keys: Vec<_> = self
            .entries
            .keys()
            .filter(|(path_hash, _, _, _)| *path_hash == source_hash)
            .copied()
            .collect();
        for key in keys {
            if let Some(removed) = self.entries.remove(&key) {
                self.total_bytes = self.total_bytes.saturating_sub(removed.data.len());
            }
        }
    }
}

static PREVIEW_FRAME_CACHE: OnceLock<Mutex<FrameCache>> = OnceLock::new();
static PREVIEW_SOFTWARE_DECODE_PATHS: OnceLock<Mutex<HashSet<u64>>> = OnceLock::new();
type PreviewClipPlanKey = (u64, String, bool);
static PREVIEW_CLIP_FAILED_PLANS: OnceLock<Mutex<HashMap<PreviewClipPlanKey, Instant>>> =
    OnceLock::new();

fn get_frame_cache() -> &'static Mutex<FrameCache> {
    PREVIEW_FRAME_CACHE.get_or_init(|| {
        Mutex::new(FrameCache::new(
            PREVIEW_FRAME_CACHE_MAX_ENTRIES,
            PREVIEW_FRAME_CACHE_MAX_BYTES,
        ))
    })
}

fn path_hash(path: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    h.finish()
}

fn should_try_preview_hardware_decode(path: &str) -> bool {
    // On WebView2 and WKWebView hosts, the software JPEG/filter pipeline is
    // already resident in system memory. `-hwaccel auto` therefore adds a
    // decode/upload/download round trip for every scrub frame (measured at
    // roughly 40–75% slower on common H.264 sources). Keep the tested software
    // path first on those platforms and retain hardware probing on Linux where
    // VAAPI can avoid that transfer.
    if cfg!(any(target_os = "windows", target_os = "macos")) {
        return false;
    }
    !PREVIEW_SOFTWARE_DECODE_PATHS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&path_hash(path))
}

fn prefer_preview_hardware_decode() -> bool {
    !cfg!(any(target_os = "windows", target_os = "macos"))
}

fn remember_preview_hardware_decode_failure(path: &str) {
    PREVIEW_SOFTWARE_DECODE_PATHS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path_hash(path));
}

fn preview_clip_plan_key(path: &str, plan: &PreviewClipPlan) -> (u64, String, bool) {
    (path_hash(path), plan.encoder.clone(), plan.use_auto_hwaccel)
}

fn preview_clip_plan_failed(path: &str, plan: &PreviewClipPlan) -> bool {
    let now = Instant::now();
    let mut failed_plans = PREVIEW_CLIP_FAILED_PLANS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    failed_plans
        .retain(|_, failed_at| now.duration_since(*failed_at) < PREVIEW_CLIP_FAILED_PLAN_TTL);
    failed_plans.contains_key(&preview_clip_plan_key(path, plan))
}

fn remember_preview_clip_plan_failure(path: &str, plan: &PreviewClipPlan) {
    let now = Instant::now();
    let mut failed_plans = PREVIEW_CLIP_FAILED_PLANS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    failed_plans
        .retain(|_, failed_at| now.duration_since(*failed_at) < PREVIEW_CLIP_FAILED_PLAN_TTL);
    if failed_plans.len() >= PREVIEW_CLIP_FAILED_PLAN_MAX_ENTRIES {
        if let Some(oldest_key) = failed_plans
            .iter()
            .min_by_key(|(_, failed_at)| *failed_at)
            .map(|(key, _)| key.clone())
        {
            failed_plans.remove(&oldest_key);
        }
    }
    failed_plans.insert(preview_clip_plan_key(path, plan), now);
}

pub(crate) fn clear_preview_clip_plan_cache() {
    PREVIEW_CLIP_FAILED_PLANS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
}

// ---------------------------------------------------------------------------
// Preview frame extraction
// ---------------------------------------------------------------------------

pub fn generate_preview(
    path: &str,
    time_sec: f64,
    preview_width: Option<u32>,
    preview_height: Option<u32>,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let generation = preview_generation();
    let frame_generation = PREVIEW_FRAME_GENERATION.load(Ordering::Acquire);
    let (preview_width, preview_height) =
        normalize_preview_dimensions(preview_width, preview_height);
    // Round to 0.1 s resolution for cache key
    let time_100ms = time_to_100ms(time_sec);
    let cache_key = (path_hash(path), time_100ms, preview_width, preview_height);

    {
        let mut cache = get_frame_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = cache.get(cache_key) {
            // Unwrap if we're the last holder, otherwise clone the inner
            // Vec for the IPC owned-bytes contract (same pattern as
            // generate_preview_clip).
            return Ok(Arc::try_unwrap(cached).unwrap_or_else(|a| (*a).clone()));
        }
    }

    // 3-decimal precision is millisecond-accurate — ffmpeg's -ss seek doesn't
    // need more than that and Rust's default `f64::to_string()` can emit a
    // long tail (e.g. 4.800000000000001) that yields a larger allocation.
    let bytes = generate_preview_frame_with_fallback(
        path,
        time_sec,
        "5",
        preview_width,
        preview_height,
        generation,
        frame_generation,
    )?;
    let shared = Arc::new(bytes);
    {
        let mut cache = get_frame_cache().lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(cache_key, Arc::clone(&shared));
    }
    Ok(Arc::try_unwrap(shared).unwrap_or_else(|a| (*a).clone()))
}

// ---------------------------------------------------------------------------
// Filmstrip generation — extracts evenly-spaced frames in a single FFmpeg pass
// ---------------------------------------------------------------------------

fn generate_preview_frame_with_fallback(
    path: &str,
    time_sec: f64,
    quality: &str,
    preview_width: u32,
    preview_height: u32,
    generation: u64,
    frame_generation: u64,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let deadline = preview_deadline(PREVIEW_FRAME_TIMEOUT);
    if !should_try_preview_hardware_decode(path) {
        return generate_preview_frame_internal(
            path,
            time_sec,
            quality,
            (preview_width, preview_height),
            false,
            generation,
            Some(frame_generation),
            deadline,
        );
    }
    match generate_preview_frame_internal(
        path,
        time_sec,
        quality,
        (preview_width, preview_height),
        true,
        generation,
        Some(frame_generation),
        deadline,
    ) {
        Ok(bytes) => Ok(bytes),
        Err(err)
            if err.to_string().starts_with(FFMPEG_MISSING_ERROR_MARKER)
                || is_preview_cancelled_error(err.as_ref())
                || is_preview_timeout_error(err.as_ref()) =>
        {
            Err(err)
        }
        Err(err) => {
            remember_preview_hardware_decode_failure(path);
            vidcord_log(&format!(
                "Hardware preview frame decode failed; retrying software decode: {err}"
            ));
            generate_preview_frame_internal(
                path,
                time_sec,
                quality,
                (preview_width, preview_height),
                false,
                generation,
                Some(frame_generation),
                deadline,
            )
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn generate_preview_frame_internal(
    path: &str,
    time_sec: f64,
    quality: &str,
    preview_dimensions: (u32, u32),
    use_auto_hwaccel: bool,
    generation: u64,
    frame_generation: Option<u64>,
    deadline: Instant,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let (preview_width, preview_height) = preview_dimensions;
    // 3-decimal precision is millisecond-accurate. ffmpeg's -ss seek doesn't
    // need more than that, and Rust's default f64 formatting can emit a long
    // tail such as 4.800000000000001.
    let ss = format_time_arg(time_sec);
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
    ];
    if use_auto_hwaccel {
        push_auto_hwaccel_args(&mut args);
    }
    args.extend([
        "-ss".into(),
        ss,
        "-i".into(),
        path.into(),
        "-an".into(),
        "-sn".into(),
        "-frames:v".into(),
        "1".into(),
        "-q:v".into(),
        quality.into(),
        "-vf".into(),
        preview_jpeg_scale_filter(preview_width, preview_height),
        "-f".into(),
        "image2pipe".into(),
        "-vcodec".into(),
        "mjpeg".into(),
        "-".into(),
    ]);

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    configure_ffmpeg_command(&mut cmd);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = preview_command_output(
        &mut cmd,
        generation,
        frame_generation,
        remaining_preview_time(deadline)?,
        PREVIEW_FRAME_OUTPUT_LIMIT,
    )?;

    if !out.status.success() || out.stdout.is_empty() {
        return Err("FFmpeg preview failed".into());
    }

    Ok(out.stdout)
}

/// Returns all frames as a single concatenated JPEG stream.
/// The frontend splits it using JPEG SOI/EOI markers (FF D8 / FF D9).
pub fn generate_filmstrip(
    path: &str,
    duration_sec: f64,
    max_frames: Option<usize>,
    preview_width: Option<u32>,
    preview_height: Option<u32>,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let generation = preview_generation();
    let deadline = preview_deadline(PREVIEW_FILMSTRIP_TIMEOUT);
    if !duration_sec.is_finite() || duration_sec <= 0.0 {
        return Err("Invalid filmstrip duration".into());
    }
    let (preview_width, preview_height) =
        normalize_preview_dimensions(preview_width, preview_height);

    // Keep the strip intentionally coarse: it is a fallback for environments
    // without direct media seeking, not a full-resolution frame index.
    let frame_count = filmstrip_frame_count(duration_sec, max_frames);

    if should_use_sparse_filmstrip(duration_sec) {
        return generate_sparse_seek_filmstrip(
            path,
            duration_sec,
            frame_count,
            preview_width,
            preview_height,
            generation,
            deadline,
        );
    }

    let try_hardware_decode = should_try_preview_hardware_decode(path);
    generate_filmstrip_single_pass(
        path,
        duration_sec,
        frame_count,
        (preview_width, preview_height),
        try_hardware_decode,
        generation,
        deadline,
    )
    .or_else(|err| {
        if err.to_string().starts_with(FFMPEG_MISSING_ERROR_MARKER)
            || is_preview_cancelled_error(err.as_ref())
            || is_preview_timeout_error(err.as_ref())
            || !try_hardware_decode
        {
            return Err(err);
        }
        if try_hardware_decode {
            remember_preview_hardware_decode_failure(path);
            vidcord_log(&format!(
                "Hardware filmstrip decode failed; retrying software decode: {err}"
            ));
        }
        generate_filmstrip_single_pass(
            path,
            duration_sec,
            frame_count,
            (preview_width, preview_height),
            false,
            generation,
            deadline,
        )
    })
}

fn generate_filmstrip_single_pass(
    path: &str,
    duration_sec: f64,
    frame_count: usize,
    preview_dimensions: (u32, u32),
    use_auto_hwaccel: bool,
    generation: u64,
    deadline: Instant,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let (preview_width, preview_height) = preview_dimensions;
    let fps = frame_count as f64 / duration_sec;
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
    ];
    if use_auto_hwaccel {
        push_auto_hwaccel_args(&mut args);
    }
    args.extend([
        "-skip_frame".into(),
        "nokey".into(),
        "-i".into(),
        path.into(),
        "-an".into(),
        "-sn".into(),
        "-vf".into(),
        format!(
            "fps={fps:.6},{}",
            preview_jpeg_scale_filter(preview_width, preview_height)
        ),
        "-q:v".into(),
        "7".into(),
        "-f".into(),
        "image2pipe".into(),
        "-vcodec".into(),
        "mjpeg".into(),
        "-".into(),
    ]);

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    configure_ffmpeg_command(&mut cmd);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = preview_command_output(
        &mut cmd,
        generation,
        None,
        remaining_preview_time(deadline)?,
        PREVIEW_FILMSTRIP_OUTPUT_LIMIT,
    )?;

    if !out.status.success() || out.stdout.is_empty() {
        return Err("FFmpeg filmstrip failed".into());
    }

    Ok(out.stdout)
}

fn generate_sparse_seek_filmstrip(
    path: &str,
    duration_sec: f64,
    frame_count: usize,
    preview_width: u32,
    preview_height: u32,
    generation: u64,
    deadline: Instant,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let try_hardware_decode = should_try_preview_hardware_decode(path);
    match generate_sparse_seek_filmstrip_internal(
        path,
        duration_sec,
        frame_count,
        (preview_width, preview_height),
        generation,
        deadline,
        try_hardware_decode,
    ) {
        Ok(output) => Ok(output),
        Err(err)
            if err.to_string().starts_with(FFMPEG_MISSING_ERROR_MARKER)
                || is_preview_cancelled_error(err.as_ref())
                || is_preview_timeout_error(err.as_ref())
                || !try_hardware_decode =>
        {
            Err(err)
        }
        Err(err) => {
            remember_preview_hardware_decode_failure(path);
            vidcord_log(&format!(
                "Hardware sparse filmstrip decode failed; retrying software decode: {err}"
            ));
            generate_sparse_seek_filmstrip_internal(
                path,
                duration_sec,
                frame_count,
                (preview_width, preview_height),
                generation,
                deadline,
                false,
            )
        }
    }
}

fn generate_sparse_seek_filmstrip_internal(
    path: &str,
    duration_sec: f64,
    frame_count: usize,
    preview_dimensions: (u32, u32),
    generation: u64,
    deadline: Instant,
    use_auto_hwaccel: bool,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    // Keep all sparse seeks in one FFmpeg process. Each input is bounded to a
    // short window and trimmed to its first decoded frame, avoiding the
    // process-startup cost of one command per thumbnail.
    let max_time = (duration_sec - 0.05).max(0.0);
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
    ];
    if use_auto_hwaccel {
        push_auto_hwaccel_args(&mut args);
    }

    for idx in 0..frame_count {
        let ratio = if frame_count <= 1 {
            0.0
        } else {
            idx as f64 / (frame_count - 1) as f64
        };
        args.extend([
            "-ss".into(),
            format_time_arg(max_time * ratio),
            "-t".into(),
            "0.5".into(),
            "-i".into(),
            path.into(),
        ]);
    }

    let (preview_width, preview_height) = preview_dimensions;
    let scale = preview_jpeg_scale_filter(preview_width, preview_height);
    let mut filters = Vec::with_capacity(frame_count + 1);
    for idx in 0..frame_count {
        filters.push(format!(
            "[{idx}:v]trim=end_frame=1,setpts=PTS-STARTPTS,{scale}[v{idx}]"
        ));
    }
    let concat_inputs = (0..frame_count)
        .map(|idx| format!("[v{idx}]"))
        .collect::<String>();
    filters.push(format!(
        "{concat_inputs}concat=n={frame_count}:v=1:a=0[outv]"
    ));
    args.extend([
        "-filter_complex".into(),
        filters.join(";"),
        "-map".into(),
        "[outv]".into(),
        "-frames:v".into(),
        frame_count.to_string(),
        "-q:v".into(),
        "7".into(),
        "-f".into(),
        "image2pipe".into(),
        "-vcodec".into(),
        "mjpeg".into(),
        "-".into(),
    ]);

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    configure_ffmpeg_command(&mut cmd);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = preview_command_output(
        &mut cmd,
        generation,
        None,
        remaining_preview_time(deadline)?,
        PREVIEW_FILMSTRIP_OUTPUT_LIMIT,
    )?;

    if !out.status.success() || out.stdout.is_empty() {
        return Err("FFmpeg sparse filmstrip failed".into());
    }

    Ok(out.stdout)
}

#[derive(Clone)]
struct PreviewClipPlan {
    encoder: String,
    use_auto_hwaccel: bool,
    vaapi_device: Option<String>,
}

fn preview_clip_hw_encoder_order() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &["h264_videotoolbox"]
    }
    #[cfg(target_os = "windows")]
    {
        &["h264_nvenc", "h264_qsv", "h264_amf"]
    }
    #[cfg(target_os = "linux")]
    {
        &["h264_vaapi", "h264_nvenc", "h264_qsv"]
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        &[
            "h264_nvenc",
            "h264_qsv",
            "h264_amf",
            "h264_videotoolbox",
            "h264_vaapi",
        ]
    }
}

fn preview_clip_plans() -> Vec<PreviewClipPlan> {
    let available = get_available_encoders();
    let auto_selectable = available.auto_selectable.clone();
    let available_names: HashSet<String> = available
        .encoders
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let mut plans = Vec::new();

    for encoder in preview_clip_hw_encoder_order() {
        if !available_names.contains(*encoder) || !auto_selectable.contains(*encoder) {
            continue;
        }

        if *encoder == "h264_vaapi" {
            if let Some(device) = find_vaapi_device() {
                plans.push(PreviewClipPlan {
                    encoder: (*encoder).to_string(),
                    use_auto_hwaccel: false,
                    vaapi_device: Some(device),
                });
            }
            continue;
        }

        let use_auto_hwaccel = prefer_preview_hardware_decode();
        plans.push(PreviewClipPlan {
            encoder: (*encoder).to_string(),
            use_auto_hwaccel,
            vaapi_device: None,
        });
        if use_auto_hwaccel {
            plans.push(PreviewClipPlan {
                encoder: (*encoder).to_string(),
                use_auto_hwaccel: false,
                vaapi_device: None,
            });
        }
    }

    plans.push(PreviewClipPlan {
        encoder: "libx264".into(),
        use_auto_hwaccel: prefer_preview_hardware_decode(),
        vaapi_device: None,
    });
    if prefer_preview_hardware_decode() {
        plans.push(PreviewClipPlan {
            encoder: "libx264".into(),
            use_auto_hwaccel: false,
            vaapi_device: None,
        });
    }

    plans
}

pub fn generate_preview_clip(
    path: &str,
    start_time_sec: f64,
    end_time_sec: f64,
    preview_width: Option<u32>,
    preview_height: Option<u32>,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let generation = preview_generation();
    let (preview_width, preview_height) =
        normalize_preview_dimensions(preview_width, preview_height);
    let start_time_sec = finite_non_negative(start_time_sec);
    let requested_end_time_sec = finite_non_negative(end_time_sec);
    let duration =
        (requested_end_time_sec - start_time_sec).clamp(0.2, MAX_GENERATED_PREVIEW_CLIP_SECONDS);
    let end_time_sec = start_time_sec + duration;

    generate_preview_clip_with_fallbacks(
        path,
        start_time_sec,
        end_time_sec,
        preview_width,
        preview_height,
        generation,
    )
}

fn generate_preview_clip_with_fallbacks(
    path: &str,
    start_time_sec: f64,
    end_time_sec: f64,
    preview_width: u32,
    preview_height: u32,
    generation: u64,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut last_error: Option<String> = None;
    let deadline = preview_deadline(PREVIEW_CLIP_TIMEOUT);

    for plan in preview_clip_plans() {
        if preview_clip_plan_failed(path, &plan) {
            vidcord_log(&format!(
                "Skipping previously failed preview clip plan {} (hwdecode={})",
                plan.encoder, plan.use_auto_hwaccel
            ));
            continue;
        }
        match generate_preview_clip_internal(
            path,
            start_time_sec,
            end_time_sec,
            (preview_width, preview_height),
            &plan,
            generation,
            deadline,
        ) {
            Ok(clip) => return Ok(clip),
            Err(err)
                if err.to_string().starts_with(FFMPEG_MISSING_ERROR_MARKER)
                    || is_preview_cancelled_error(err.as_ref())
                    || is_preview_timeout_error(err.as_ref()) =>
            {
                return Err(err)
            }
            Err(err) => {
                remember_preview_clip_plan_failure(path, &plan);
                vidcord_log(&format!(
                    "Preview clip encode failed with {} (hwdecode={}): {err}",
                    plan.encoder, plan.use_auto_hwaccel
                ));
                last_error = Some(err.to_string());
            }
        }
    }

    Err(last_error
        .unwrap_or_else(|| "FFmpeg preview clip failed".to_string())
        .into())
}

fn generate_preview_clip_internal(
    path: &str,
    start_time_sec: f64,
    end_time_sec: f64,
    preview_dimensions: (u32, u32),
    plan: &PreviewClipPlan,
    generation: u64,
    deadline: Instant,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let duration = (end_time_sec - start_time_sec).max(0.2);
    let start_time = format_time_arg(start_time_sec);
    let duration = format_time_arg(duration);
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
    ];

    if let Some(device) = plan.vaapi_device.as_ref() {
        args.extend(["-vaapi_device".into(), device.clone()]);
    }
    if plan.use_auto_hwaccel {
        push_auto_hwaccel_args(&mut args);
    }

    let (preview_width, preview_height) = preview_dimensions;
    let base_scale = preview_jpeg_scale_filter(preview_width, preview_height);
    let video_filter = if plan.encoder == "h264_vaapi" {
        format!("{base_scale},format=nv12,hwupload")
    } else {
        base_scale
    };

    args.extend([
        "-ss".into(),
        start_time,
        "-t".into(),
        duration,
        "-i".into(),
        path.into(),
        "-map".into(),
        "0:v:0".into(),
        "-an".into(),
        "-sn".into(),
        "-vf".into(),
        video_filter,
        "-c:v".into(),
        plan.encoder.clone(),
    ]);

    match plan.encoder.as_str() {
        "libx264" => args.extend([
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "30".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]),
        "h264_nvenc" => args.extend([
            "-preset".into(),
            "p1".into(),
            "-tune".into(),
            "ll".into(),
            "-b:v".into(),
            PREVIEW_CLIP_BITRATE.into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]),
        "h264_qsv" => args.extend([
            "-preset".into(),
            "veryfast".into(),
            "-b:v".into(),
            PREVIEW_CLIP_BITRATE.into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]),
        "h264_amf" => args.extend([
            "-quality".into(),
            "speed".into(),
            "-usage".into(),
            "transcoding".into(),
            "-b:v".into(),
            PREVIEW_CLIP_BITRATE.into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]),
        "h264_videotoolbox" => args.extend([
            "-b:v".into(),
            PREVIEW_CLIP_BITRATE.into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]),
        "h264_vaapi" => args.extend(["-b:v".into(), PREVIEW_CLIP_BITRATE.into()]),
        _ => args.extend([
            "-b:v".into(),
            PREVIEW_CLIP_BITRATE.into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]),
    }

    args.extend([
        "-movflags".into(),
        "frag_keyframe+empty_moov".into(),
        "-f".into(),
        "mp4".into(),
        "-".into(),
    ]);

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    configure_ffmpeg_command(&mut cmd);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = preview_command_output(
        &mut cmd,
        generation,
        None,
        remaining_preview_time(deadline)?,
        PREVIEW_CLIP_OUTPUT_LIMIT,
    )?;

    if !out.status.success() || out.stdout.is_empty() {
        return Err("FFmpeg preview clip failed".into());
    }

    Ok(out.stdout)
}

// ---------------------------------------------------------------------------
// VAAPI device discovery (Linux)
// ---------------------------------------------------------------------------

pub fn find_vaapi_device() -> Option<String> {
    VAAPI_CACHE
        .get_or_init(|| {
            #[cfg(target_os = "linux")]
            {
                let dri = std::path::Path::new("/dev/dri");
                if !dri.exists() {
                    return None;
                }

                let mut nodes: Vec<std::path::PathBuf> = std::fs::read_dir(dri)
                    .ok()?
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .map(|n| n.starts_with("renderD"))
                            .unwrap_or(false)
                    })
                    .collect();

                // Prefer renderD128
                nodes.sort_by_key(|p| {
                    if p.to_string_lossy().contains("renderD128") {
                        0
                    } else {
                        1
                    }
                });

                let deadline = Instant::now()
                    .checked_add(VAAPI_DISCOVERY_TIMEOUT)
                    .unwrap_or_else(Instant::now);

                for node in &nodes {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        vidcord_log("VAAPI discovery timed out before all devices were checked");
                        break;
                    }
                    let node_str = node.to_string_lossy().to_string();
                    let mut cmd = std::process::Command::new("ffmpeg");
                    cmd.args([
                        "-y",
                        "-hide_banner",
                        "-init_hw_device",
                        &format!("vaapi=va:{node_str}"),
                        "-filter_hw_device",
                        "va",
                        "-f",
                        "lavfi",
                        "-i",
                        "nullsrc=s=64x64",
                        "-frames:v",
                        "1",
                        "-f",
                        "null",
                        "-",
                    ])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                    configure_ffmpeg_command(&mut cmd);
                    let timeout = remaining.min(VAAPI_DEVICE_TIMEOUT);
                    let ok = match crate::gpu::spawn_captured_command(&mut cmd)
                        .and_then(|child| child.wait_for_output(timeout))
                    {
                        Ok(Some(output)) => output.status.success(),
                        Ok(None) => {
                            vidcord_log(&format!(
                                "VAAPI discovery timed out for {}",
                                node.display()
                            ));
                            false
                        }
                        Err(error) => {
                            vidcord_log(&format!(
                                "VAAPI discovery failed for {}: {error}",
                                node.display()
                            ));
                            false
                        }
                    };

                    if ok {
                        return Some(node_str);
                    }
                }
                None
            }
            #[cfg(not(target_os = "linux"))]
            {
                None
            }
        })
        .clone()
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

pub fn clear_preview_caches_for_path(path: &str) {
    let source_hash = path_hash(path);
    get_frame_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear_path(source_hash);
    PREVIEW_SOFTWARE_DECODE_PATHS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&source_hash);
    PREVIEW_CLIP_FAILED_PLANS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|(path_hash, _, _), _| *path_hash != source_hash);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lossless_container_extension_prefers_known_source_extension() {
        assert_eq!(
            lossless_container_extension("clip.mov", "mov,mp4"),
            Some("mov")
        );
        assert_eq!(
            lossless_container_extension("clip.mp4", "mov,mp4"),
            Some("mp4")
        );
        assert_eq!(
            lossless_container_extension("clip.mkv", "matroska,webm"),
            Some("mkv")
        );
        assert_eq!(
            lossless_container_extension("clip.bin", "webm"),
            Some("webm")
        );
        assert_eq!(lossless_container_extension("clip.bin", "unknown"), None);
    }

    #[test]
    fn ffmpeg_missing_error_is_machine_detectable_and_user_actionable() {
        let message = ffmpeg_missing_error();

        assert!(message.starts_with(FFMPEG_MISSING_ERROR_MARKER));
        assert!(message.contains("PATH"));
        assert!(message.contains("Install FFmpeg"));
    }

    #[test]
    fn appimage_library_paths_are_removed_for_host_ffmpeg() {
        let cleaned = without_appimage_library_paths(
            "/tmp/.mount_vidcord",
            "/tmp/.mount_vidcord/usr/lib:/opt/custom/lib:/tmp/.mount_vidcord/usr/lib64:/usr/local/lib",
        );

        assert_eq!(cleaned, "/opt/custom/lib:/usr/local/lib");
        assert_eq!(
            without_appimage_library_paths(
                "/tmp/.mount_vidcord",
                "/tmp/.mount_vidcord-other/lib:/usr/lib",
            ),
            "/tmp/.mount_vidcord-other/lib:/usr/lib"
        );
    }

    #[test]
    fn appimage_only_library_path_is_cleared_for_host_ffmpeg() {
        assert!(without_appimage_library_paths(
            "/tmp/.mount_vidcord",
            "/tmp/.mount_vidcord/usr/lib:/tmp/.mount_vidcord/usr/lib64",
        )
        .is_empty());
        assert_eq!(
            without_appimage_library_paths("", "/opt/custom/lib:/usr/local/lib"),
            "/opt/custom/lib:/usr/local/lib"
        );
    }

    #[test]
    fn long_filmstrips_use_sparse_seeks_before_full_decode_becomes_expensive() {
        assert!(!should_use_sparse_filmstrip(179.9));
        assert!(should_use_sparse_filmstrip(180.0));
        assert!(should_use_sparse_filmstrip(600.0));
    }

    #[test]
    fn filmstrip_frame_count_is_coarse_and_bounded() {
        assert_eq!(filmstrip_frame_count(1.0, None), 2);
        assert_eq!(filmstrip_frame_count(27.1, None), 27);
        assert_eq!(filmstrip_frame_count(120.0, None), 30);
        assert_eq!(filmstrip_frame_count(120.0, Some(16)), 16);
        assert_eq!(filmstrip_frame_count(120.0, Some(200)), 30);
    }

    #[test]
    fn frame_cache_evicts_to_its_byte_budget() {
        let mut cache = FrameCache::new(60, 10);
        cache.insert((1, 1, 1, 1), Arc::new(vec![1; 6]));
        cache.insert((2, 2, 2, 2), Arc::new(vec![2; 6]));

        assert!(cache.get((1, 1, 1, 1)).is_none());
        assert!(cache.get((2, 2, 2, 2)).is_some());
        assert_eq!(cache.total_bytes, 6);
    }

    #[test]
    fn frame_cache_rejects_single_entries_over_its_byte_budget() {
        let mut cache = FrameCache::new(60, 5);
        cache.insert((1, 1, 1, 1), Arc::new(vec![1; 6]));

        assert!(cache.entries.is_empty());
        assert_eq!(cache.total_bytes, 0);
    }

    #[test]
    fn frame_cache_can_clear_one_source_without_dropping_other_sources() {
        let mut cache = FrameCache::new(60, 100);
        cache.insert((1, 1, 1, 1), Arc::new(vec![1; 6]));
        cache.insert((2, 2, 2, 2), Arc::new(vec![2; 7]));

        cache.clear_path(1);

        assert!(cache.get((1, 1, 1, 1)).is_none());
        assert!(cache.get((2, 2, 2, 2)).is_some());
        assert_eq!(cache.total_bytes, 7);
    }

    #[test]
    fn best_audio_stream_selection_prioritizes_first_stream_on_equal_data() {
        let json_equal = serde_json::json!({
            "streams": [
                { "index": 1, "codec_type": "audio", "bit_rate": "192000", "channels": 2, "duration": "60.0" },
                { "index": 2, "codec_type": "audio", "bit_rate": "192000", "channels": 2, "duration": "60.0" }
            ]
        });
        assert_eq!(best_audio_stream_from_json(&json_equal), Some(0));

        let json_second_higher = serde_json::json!({
            "streams": [
                { "index": 1, "codec_type": "audio", "bit_rate": "96000", "channels": 2, "duration": "60.0" },
                { "index": 2, "codec_type": "audio", "bit_rate": "320000", "channels": 2, "duration": "60.0" }
            ]
        });
        assert_eq!(best_audio_stream_from_json(&json_second_higher), Some(1));
    }
}
