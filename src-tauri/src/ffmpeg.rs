use std::collections::HashMap;
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
    // Key: (start_time_ms, end_time_ms)
    clips: HashMap<(u64, u64), ClipCacheEntry>,
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

    fn get(&mut self, key: (u64, u64)) -> Option<Arc<Vec<u8>>> {
        self.clips.get_mut(&key).map(|entry| {
            entry.last_used = std::time::Instant::now();
            Arc::clone(&entry.data)
        })
    }

    fn insert(&mut self, key: (u64, u64), data: Arc<Vec<u8>>) {
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
    entries: std::collections::HashMap<(u64, u64), FrameCacheEntry>,
    max_entries: usize,
}

impl FrameCache {
    fn new(max_entries: usize) -> Self {
        Self {
            entries: std::collections::HashMap::new(),
            max_entries,
        }
    }

    fn get(&mut self, key: (u64, u64)) -> Option<Arc<Vec<u8>>> {
        self.entries.get_mut(&key).map(|entry| {
            entry.last_used = std::time::Instant::now();
            Arc::clone(&entry.data)
        })
    }

    fn insert(&mut self, key: (u64, u64), data: Arc<Vec<u8>>) {
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

pub fn generate_preview(path: &str, time_sec: f64) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    // Round to 0.1 s resolution for cache key
    let time_100ms = (time_sec * 10.0) as u64;
    let cache_key = (path_hash(path), time_100ms);

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
    let ss = format!("{time_sec:.3}");

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args([
        "-y",
        "-hwaccel",
        "auto",
        "-ss",
        ss.as_str(),
        "-i",
        path,
        "-an",
        "-sn",
        "-frames:v",
        "1",
        "-q:v",
        "5",
        "-vf",
        "scale=320:-2:flags=fast_bilinear,setsar=1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-",
    ])
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

    let shared = Arc::new(out.stdout);
    {
        let mut cache = get_frame_cache().lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(cache_key, Arc::clone(&shared));
    }
    Ok(Arc::try_unwrap(shared).unwrap_or_else(|a| (*a).clone()))
}

// ---------------------------------------------------------------------------
// Filmstrip generation — extracts evenly-spaced frames in a single FFmpeg pass
// ---------------------------------------------------------------------------

/// Returns all frames as a single concatenated JPEG stream.
/// The frontend splits it using JPEG SOI/EOI markers (FF D8 / FF D9).
pub fn generate_filmstrip(
    path: &str,
    duration_sec: f64,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    // Target ~60 frames; for very short clips aim for ~1 fps.
    let frame_count = (duration_sec.floor() as usize).clamp(2, 60);
    let fps = frame_count as f64 / duration_sec;

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args([
        "-y",
        "-hwaccel",
        "auto",
        "-i",
        path,
        "-an",
        "-sn",
        "-vf",
        &format!("fps={fps:.6},scale=320:-2:flags=fast_bilinear,setsar=1"),
        "-q:v",
        "7", // slightly lower quality than on-demand; fine for thumbnail strip
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-",
    ])
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

pub fn generate_preview_clip(
    path: &str,
    start_time_sec: f64,
    end_time_sec: f64,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    // Try to get from cache first
    let start_ms = (start_time_sec * 1000.0) as u64;
    let end_ms = (end_time_sec * 1000.0) as u64;
    let cache_key = (start_ms, end_ms);

    {
        let mut cache = get_clip_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = cache.get(cache_key) {
            // Unwrap if we're the last holder (rare when cache keeps it),
            // otherwise clone the inner Vec for the IPC owned-bytes contract.
            return Ok(Arc::try_unwrap(cached).unwrap_or_else(|a| (*a).clone()));
        }
    }

    // Not in cache, generate it
    let clip = generate_preview_clip_internal(path, start_time_sec, end_time_sec)?;
    let shared = Arc::new(clip);

    // Store in cache (refcount bump, no payload copy)
    {
        let mut cache = get_clip_cache().lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(cache_key, Arc::clone(&shared));
    }

    Ok(Arc::try_unwrap(shared).unwrap_or_else(|a| (*a).clone()))
}

fn generate_preview_clip_internal(
    path: &str,
    start_time_sec: f64,
    end_time_sec: f64,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let duration = (end_time_sec - start_time_sec).clamp(0.2, 12.0);

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        &start_time_sec.to_string(),
        "-t",
        &duration.to_string(),
        "-i",
        path,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-sn",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "30",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "-",
    ])
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
