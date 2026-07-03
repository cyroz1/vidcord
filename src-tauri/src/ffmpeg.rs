use crate::log::vidcord_log;
use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex, OnceLock};

mod encoders;

pub use encoders::{get_available_encoders, invalidate_encoder_cache};

static VAAPI_CACHE: OnceLock<Option<String>> = OnceLock::new();
// Cached once at first use — env doesn't change during an app session.
static FFMPEG_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

pub const FFMPEG_MISSING_ERROR_MARKER: &str = "FFMPEG_MISSING:";

pub fn ffmpeg_missing_error() -> String {
    format!(
        "{FFMPEG_MISSING_ERROR_MARKER} FFmpeg was not found on PATH. Install FFmpeg and restart vidcord."
    )
}

fn command_output_or_ffmpeg_missing(
    cmd: &mut Command,
) -> Result<Output, Box<dyn std::error::Error>> {
    match cmd.output() {
        Ok(output) => Ok(output),
        Err(err) if err.kind() == ErrorKind::NotFound => Err(ffmpeg_missing_error().into()),
        Err(err) => Err(Box::new(err)),
    }
}

const PREVIEW_CLIP_SCALE_FILTER: &str =
    "scale=w=1280:h=720:flags=fast_bilinear:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1";
const PREVIEW_CLIP_BITRATE: &str = "2500k";
const SPARSE_FILMSTRIP_THRESHOLD_SEC: f64 = 10.0 * 60.0;
const DEFAULT_PREVIEW_IMAGE_WIDTH: u32 = 720;
const DEFAULT_PREVIEW_IMAGE_HEIGHT: u32 = 480;
const MIN_PREVIEW_IMAGE_DIM: u32 = 240;
const MAX_PREVIEW_IMAGE_WIDTH: u32 = 960;
const MAX_PREVIEW_IMAGE_HEIGHT: u32 = 1080;

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

fn time_to_ms(seconds: f64) -> u64 {
    (finite_non_negative(seconds) * 1000.0).round() as u64
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
// Preview clip cache - LRU-like cache with time-based keys
// ---------------------------------------------------------------------------

struct ClipCacheEntry {
    // Arc so cache hits return cheaply; the heavy Vec<u8> is never memcpy'd
    // by the cache itself, and LRU eviction doesn't need to clone payloads
    // just to pick a victim.
    data: Arc<Vec<u8>>,
    last_used: std::time::Instant,
    size: usize,
}

struct ClipCache {
    // Key: (path_hash, start_time_ms, end_time_ms)
    clips: HashMap<(u64, u64, u64), ClipCacheEntry>,
    total_size: usize,
    max_size: usize,
}

impl ClipCache {
    fn new(max_mb: usize) -> Self {
        Self {
            clips: HashMap::new(),
            total_size: 0,
            max_size: max_mb * 1024 * 1024,
        }
    }

    fn get(&mut self, key: (u64, u64, u64)) -> Option<Arc<Vec<u8>>> {
        self.clips.get_mut(&key).map(|entry| {
            entry.last_used = std::time::Instant::now();
            Arc::clone(&entry.data)
        })
    }

    fn insert(&mut self, key: (u64, u64, u64), data: Arc<Vec<u8>>) {
        let clip_size = data.len();

        // Remove least recently used entries until it fits. Pick the victim
        // key first (without cloning the payload), then remove.
        while self.total_size + clip_size > self.max_size && !self.clips.is_empty() {
            let oldest_key = self
                .clips
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(k, _)| *k);
            match oldest_key {
                Some(k) => {
                    if let Some(removed) = self.clips.remove(&k) {
                        self.total_size = self.total_size.saturating_sub(removed.size);
                    }
                }
                None => break,
            }
        }

        // Only insert if it's not too large by itself
        if clip_size <= self.max_size {
            self.total_size += clip_size;
            self.clips.insert(
                key,
                ClipCacheEntry {
                    data,
                    last_used: std::time::Instant::now(),
                    size: clip_size,
                },
            );
        }
    }

    fn clear(&mut self) {
        self.clips.clear();
        self.total_size = 0;
    }
}

static PREVIEW_CLIP_CACHE: OnceLock<Mutex<ClipCache>> = OnceLock::new();

fn get_clip_cache() -> &'static Mutex<ClipCache> {
    PREVIEW_CLIP_CACHE.get_or_init(|| {
        Mutex::new(ClipCache::new(100)) // 100MB cache
    })
}

// ---------------------------------------------------------------------------
// FFmpeg environment
// ---------------------------------------------------------------------------

pub fn get_ffmpeg_env() -> &'static HashMap<String, String> {
    FFMPEG_ENV.get_or_init(|| {
        #[allow(unused_mut)]
        let mut env: HashMap<String, String> = std::env::vars().collect();

        #[cfg(target_os = "linux")]
        {
            use crate::gpu::get_system_gpus;

            let gpus = get_system_gpus();
            if *gpus.get("amd").unwrap_or(&false) && !env.contains_key("LIBVA_DRIVER_NAME") {
                env.insert("LIBVA_DRIVER_NAME".to_string(), "radeonsi".to_string());
            }
        }

        env
    })
}

// ---------------------------------------------------------------------------
// Video probing
// ---------------------------------------------------------------------------

pub fn probe_video(path: &str) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
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
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        path,
    ])
    .envs(get_ffmpeg_env());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = command_output_or_ffmpeg_missing(&mut cmd)?;

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

    Ok(serde_json::json!({
        "duration": duration,
        "width": width,
        "height": height,
        "display_width": display_width,
        "display_height": display_height,
        "frame_rate": frame_rate,
        "bitrate": bitrate
    }))
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
}

impl FrameCache {
    fn new(max_entries: usize) -> Self {
        Self {
            entries: std::collections::HashMap::new(),
            max_entries,
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
        // LRU eviction: pick the least-recently-used entry (not just the
        // oldest inserted) so re-scrubbed frames survive longer.
        while self.entries.len() >= self.max_entries {
            let oldest_key = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(k, _)| *k);
            match oldest_key {
                Some(k) => {
                    self.entries.remove(&k);
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
    }

    fn clear(&mut self) {
        self.entries.clear();
    }
}

static PREVIEW_FRAME_CACHE: OnceLock<Mutex<FrameCache>> = OnceLock::new();

fn get_frame_cache() -> &'static Mutex<FrameCache> {
    PREVIEW_FRAME_CACHE.get_or_init(|| Mutex::new(FrameCache::new(60)))
}

fn path_hash(path: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    h.finish()
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
    let bytes =
        generate_preview_frame_with_fallback(path, time_sec, "5", preview_width, preview_height)?;
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
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    match generate_preview_frame_internal(
        path,
        time_sec,
        quality,
        preview_width,
        preview_height,
        true,
    ) {
        Ok(bytes) => Ok(bytes),
        Err(err) if err.to_string().starts_with(FFMPEG_MISSING_ERROR_MARKER) => Err(err),
        Err(err) => {
            vidcord_log(&format!(
                "Hardware preview frame decode failed; retrying software decode: {err}"
            ));
            generate_preview_frame_internal(
                path,
                time_sec,
                quality,
                preview_width,
                preview_height,
                false,
            )
        }
    }
}

fn generate_preview_frame_internal(
    path: &str,
    time_sec: f64,
    quality: &str,
    preview_width: u32,
    preview_height: u32,
    use_auto_hwaccel: bool,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
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
        .envs(get_ffmpeg_env())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = command_output_or_ffmpeg_missing(&mut cmd)?;

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
    if !duration_sec.is_finite() || duration_sec <= 0.0 {
        return Err("Invalid filmstrip duration".into());
    }
    let (preview_width, preview_height) =
        normalize_preview_dimensions(preview_width, preview_height);

    // Target ~60 frames by default; callers can lower this for long clips so
    // loading a file does less thumbnail work before the user starts scrubbing.
    let frame_limit = max_frames.unwrap_or(60).clamp(2, 60);
    let frame_count = (duration_sec.floor() as usize).clamp(2, frame_limit);

    if duration_sec >= SPARSE_FILMSTRIP_THRESHOLD_SEC {
        return generate_sparse_seek_filmstrip(
            path,
            duration_sec,
            frame_count,
            preview_width,
            preview_height,
        );
    }

    generate_filmstrip_single_pass(
        path,
        duration_sec,
        frame_count,
        preview_width,
        preview_height,
        true,
    )
    .or_else(|err| {
        if err.to_string().starts_with(FFMPEG_MISSING_ERROR_MARKER) {
            return Err(err);
        }
        vidcord_log(&format!(
            "Hardware filmstrip decode failed; retrying software decode: {err}"
        ));
        generate_filmstrip_single_pass(
            path,
            duration_sec,
            frame_count,
            preview_width,
            preview_height,
            false,
        )
    })
}

fn generate_filmstrip_single_pass(
    path: &str,
    duration_sec: f64,
    frame_count: usize,
    preview_width: u32,
    preview_height: u32,
    use_auto_hwaccel: bool,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
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
        .envs(get_ffmpeg_env())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = command_output_or_ffmpeg_missing(&mut cmd)?;

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
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut output = Vec::new();
    let mut last_error: Option<String> = None;
    let max_time = (duration_sec - 0.05).max(0.0);
    let mut use_auto_hwaccel = true;

    for idx in 0..frame_count {
        let ratio = if frame_count <= 1 {
            0.0
        } else {
            idx as f64 / (frame_count - 1) as f64
        };
        let time_sec = max_time * ratio;
        match generate_preview_frame_internal(
            path,
            time_sec,
            "7",
            preview_width,
            preview_height,
            use_auto_hwaccel,
        ) {
            Ok(frame) => output.extend(frame),
            Err(err) if err.to_string().starts_with(FFMPEG_MISSING_ERROR_MARKER) => {
                return Err(err)
            }
            Err(err) if use_auto_hwaccel => {
                vidcord_log(&format!(
                    "Hardware sparse filmstrip decode failed; using software decode for remaining frames: {err}"
                ));
                use_auto_hwaccel = false;
                match generate_preview_frame_internal(
                    path,
                    time_sec,
                    "7",
                    preview_width,
                    preview_height,
                    false,
                ) {
                    Ok(frame) => output.extend(frame),
                    Err(err) if err.to_string().starts_with(FFMPEG_MISSING_ERROR_MARKER) => {
                        return Err(err)
                    }
                    Err(err) => {
                        last_error = Some(err.to_string());
                    }
                }
            }
            Err(err) => {
                last_error = Some(err.to_string());
            }
        }
    }

    if output.is_empty() {
        return Err(last_error
            .unwrap_or_else(|| "FFmpeg sparse filmstrip failed".to_string())
            .into());
    }

    Ok(output)
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
    let available_names: HashSet<String> = available
        .encoders
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let mut plans = Vec::new();

    for encoder in preview_clip_hw_encoder_order() {
        if !available_names.contains(*encoder) {
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

        plans.push(PreviewClipPlan {
            encoder: (*encoder).to_string(),
            use_auto_hwaccel: true,
            vaapi_device: None,
        });
        plans.push(PreviewClipPlan {
            encoder: (*encoder).to_string(),
            use_auto_hwaccel: false,
            vaapi_device: None,
        });
    }

    plans.push(PreviewClipPlan {
        encoder: "libx264".into(),
        use_auto_hwaccel: true,
        vaapi_device: None,
    });
    plans.push(PreviewClipPlan {
        encoder: "libx264".into(),
        use_auto_hwaccel: false,
        vaapi_device: None,
    });

    plans
}

pub fn generate_preview_clip(
    path: &str,
    start_time_sec: f64,
    end_time_sec: f64,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    // Try to get from cache first
    let start_ms = time_to_ms(start_time_sec);
    let end_ms = time_to_ms(end_time_sec);
    let cache_key = (path_hash(path), start_ms, end_ms);

    {
        let mut cache = get_clip_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = cache.get(cache_key) {
            // Unwrap if we're the last holder (rare when cache keeps it),
            // otherwise clone the inner Vec for the IPC owned-bytes contract.
            return Ok(Arc::try_unwrap(cached).unwrap_or_else(|a| (*a).clone()));
        }
    }

    // Not in cache, generate it.
    let clip = generate_preview_clip_with_fallbacks(path, start_time_sec, end_time_sec)?;
    let shared = Arc::new(clip);

    // Store in cache (refcount bump, no payload copy)
    {
        let mut cache = get_clip_cache().lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(cache_key, Arc::clone(&shared));
    }

    Ok(Arc::try_unwrap(shared).unwrap_or_else(|a| (*a).clone()))
}

fn generate_preview_clip_with_fallbacks(
    path: &str,
    start_time_sec: f64,
    end_time_sec: f64,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut last_error: Option<String> = None;

    for plan in preview_clip_plans() {
        match generate_preview_clip_internal(path, start_time_sec, end_time_sec, &plan) {
            Ok(clip) => return Ok(clip),
            Err(err) if err.to_string().starts_with(FFMPEG_MISSING_ERROR_MARKER) => {
                return Err(err)
            }
            Err(err) => {
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
    plan: &PreviewClipPlan,
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

    let video_filter = if plan.encoder == "h264_vaapi" {
        format!("{PREVIEW_CLIP_SCALE_FILTER},format=nv12,hwupload")
    } else {
        PREVIEW_CLIP_SCALE_FILTER.to_string()
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
        "-map".into(),
        "0:a?".into(),
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
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "96k".into(),
        "-movflags".into(),
        "frag_keyframe+empty_moov".into(),
        "-f".into(),
        "mp4".into(),
        "-".into(),
    ]);

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(&args)
        .envs(get_ffmpeg_env())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = command_output_or_ffmpeg_missing(&mut cmd)?;

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

                for node in &nodes {
                    let node_str = node.to_string_lossy().to_string();
                    let ok = std::process::Command::new("ffmpeg")
                        .args([
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
                        .envs(get_ffmpeg_env())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false);

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

pub fn clear_preview_caches() {
    if let Ok(mut cache) = get_clip_cache().lock() {
        cache.clear();
    }
    if let Ok(mut cache) = get_frame_cache().lock() {
        cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_missing_error_is_machine_detectable_and_user_actionable() {
        let message = ffmpeg_missing_error();

        assert!(message.starts_with(FFMPEG_MISSING_ERROR_MARKER));
        assert!(message.contains("PATH"));
        assert!(message.contains("Install FFmpeg"));
    }
}
