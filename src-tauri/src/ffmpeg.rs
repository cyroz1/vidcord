use crate::gpu::get_system_gpus;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static VAAPI_CACHE: OnceLock<Option<String>> = OnceLock::new();
// Cached once at first use — env doesn't change during an app session.
static FFMPEG_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
// Cached regex for encoder list parsing.
static ENCODER_RE: OnceLock<regex_lite::Regex> = OnceLock::new();

// ---------------------------------------------------------------------------
// Preview clip cache - LRU-like cache with time-based keys
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ClipCacheEntry {
    data: Vec<u8>,
    last_used: std::time::Instant,
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

    fn get(&mut self, key: (u64, u64)) -> Option<Vec<u8>> {
        if let Some(entry) = self.clips.get_mut(&key) {
            entry.last_used = std::time::Instant::now();
            return Some(entry.data.clone());
        }
        None
    }

    fn insert(&mut self, key: (u64, u64), data: Vec<u8>) {
        let clip_size = data.len();

        // Remove least recently used entries until it fits
        while self.total_size + clip_size > self.max_size && !self.clips.is_empty() {
            if let Some((removed_key, _)) = self
                .clips
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(k, v)| (*k, v.clone()))
            {
                if let Some(removed) = self.clips.remove(&removed_key) {
                    self.total_size = self.total_size.saturating_sub(removed.data.len());
                }
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

    let out = cmd.output()?;

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
// Preview frame extraction
// ---------------------------------------------------------------------------

pub fn generate_preview(path: &str, time_sec: f64) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args([
        "-y",
        "-ss",
        &time_sec.to_string(),
        "-i",
        path,
        "-an",
        "-sn",
        "-frames:v",
        "1",
        "-q:v",
        "5", // Optimized: was 4, now 5 for 10-15% faster with imperceptible quality difference on 320px
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

    let out = cmd.output()?;

    if !out.status.success() {
        return Err("FFmpeg preview failed".into());
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
            return Ok(cached);
        }
    }

    // Not in cache, generate it
    let clip = generate_preview_clip_internal(path, start_time_sec, end_time_sec)?;

    // Store in cache
    {
        let mut cache = get_clip_cache().lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(cache_key, clip.clone());
    }

    Ok(clip)
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

    let out = cmd.output()?;

    if !out.status.success() || out.stdout.is_empty() {
        return Err("FFmpeg preview clip failed".into());
    }

    Ok(out.stdout)
}

// ---------------------------------------------------------------------------
// Encoder detection
// ---------------------------------------------------------------------------

pub fn get_available_encoders() -> Vec<(String, String)> {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-encoders"])
        .envs(get_ffmpeg_env());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = match cmd.output() {
        Ok(o) => o,
        Err(_) => return vec![("libx264".to_string(), "CPU (libx264)".to_string())],
    };

    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let gpus = get_system_gpus();
    let system = std::env::consts::OS;

    let re = ENCODER_RE.get_or_init(|| {
        regex_lite::Regex::new(r"^\s*V[A-Z.]*\s+([a-zA-Z0-9_]+)\s+").expect("invalid regex literal")
    });
    let mut ffmpeg_encoders: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in text.lines() {
        if let Some(cap) = re.captures(line) {
            ffmpeg_encoders.insert(cap[1].to_string());
        }
    }

    let mut result: Vec<(String, String)> = Vec::new();

    let candidates = [
        ("libx264", "CPU (libx264)", true, ""),
        ("h264_nvenc", "NVIDIA (h264_nvenc)", false, "nvidia"),
        ("h264_amf", "AMD (h264_amf)", false, "amd"),
        ("h264_qsv", "Intel (h264_qsv)", false, "intel"),
        ("h264_vaapi", "Linux Hardware (h264_vaapi)", false, "vaapi"),
        (
            "h264_videotoolbox",
            "Apple Silicon (h264_videotoolbox)",
            false,
            "apple",
        ),
    ];

    for (enc, label, always, gpu_key) in &candidates {
        let include = if *always {
            true
        } else if *gpu_key == "vaapi" {
            system == "linux" && find_vaapi_device().is_some()
        } else if *gpu_key == "apple" {
            system == "macos"
        } else {
            *gpus.get(*gpu_key).unwrap_or(&false)
        };

        if include && (*enc == "libx264" || ffmpeg_encoders.contains(*enc)) {
            result.push((enc.to_string(), label.to_string()));
        }
    }

    if result.is_empty() {
        result.push(("libx264".to_string(), "CPU (libx264)".to_string()));
    }
    result
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

pub fn clear_preview_clip_cache() {
    if let Ok(mut cache) = get_clip_cache().lock() {
        cache.clear();
    }
}
