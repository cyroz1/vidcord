use std::collections::HashMap;
use std::sync::OnceLock;
use crate::gpu::get_system_gpus;

static VAAPI_CACHE: OnceLock<Option<String>> = OnceLock::new();
// Cached once at first use — env doesn't change during an app session.
static FFMPEG_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
// Cached regex for encoder list parsing.
static ENCODER_RE: OnceLock<regex_lite::Regex> = OnceLock::new();

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
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffprobe");
    cmd.args(["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", path])
        .envs(get_ffmpeg_env());
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }

    let out = cmd.output()?;

    if !out.status.success() {
        return Err(format!("ffprobe failed: {}", String::from_utf8_lossy(&out.stderr)).into());
    }

    let data: serde_json::Value = serde_json::from_slice(&out.stdout)?;
    let format = &data["format"];
    let duration: f64 = format["duration"].as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    let streams = data["streams"].as_array().ok_or("No streams")?;
    let video = streams.iter()
        .find(|s| s["codec_type"].as_str() == Some("video"))
        .ok_or("No video stream")?;

    let width = video["width"].as_u64().unwrap_or(0);
    let height = video["height"].as_u64().unwrap_or(0);
    let bitrate = video["bit_rate"].as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .map(|b| b / 1000)
        .or_else(|| format["bit_rate"].as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .map(|b| b / 1000))
        .unwrap_or(0);

    Ok(serde_json::json!({
        "duration": duration,
        "width": width,
        "height": height,
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
        "-y", "-ss", &time_sec.to_string(), "-i", path, 
        "-an", "-sn", "-frames:v", "1", "-q:v", "4", 
        "-vf", "scale=320:-1:flags=fast_bilinear",
        "-f", "image2pipe", "-vcodec", "mjpeg", "-"
    ])
    .envs(get_ffmpeg_env())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }

    let out = cmd.output()?;

    if !out.status.success() {
        return Err("FFmpeg preview failed".into());
    }

    Ok(out.stdout)
}

// ---------------------------------------------------------------------------
// Encoder detection
// ---------------------------------------------------------------------------

pub fn get_available_encoders() -> Vec<(String, String)> {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-encoders"]).envs(get_ffmpeg_env());
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }

    let out = match cmd.output() {
        Ok(o) => o,
        Err(_) => return vec![("libx264".to_string(), "CPU (libx264)".to_string())],
    };

    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let gpus = get_system_gpus();
    let system = std::env::consts::OS;

    let re = ENCODER_RE.get_or_init(|| {
        regex_lite::Regex::new(r"^\s*V[A-Z.]*\s+([a-zA-Z0-9_]+)\s+").unwrap()
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
        ("h264_videotoolbox", "Apple Silicon (h264_videotoolbox)", false, "apple"),
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

        if include && (*enc == "libx264" || *enc == "h264_vaapi" || ffmpeg_encoders.contains(*enc)) {
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
    VAAPI_CACHE.get_or_init(|| {
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
                .filter(|p| p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("renderD")).unwrap_or(false))
                .collect();

            // Prefer renderD128
            nodes.sort_by_key(|p| if p.to_string_lossy().contains("renderD128") { 0 } else { 1 });

            for node in &nodes {
                let node_str = node.to_string_lossy().to_string();
                let ok = std::process::Command::new("ffmpeg")
                    .args([
                        "-y", "-hide_banner",
                        "-init_hw_device", &format!("vaapi=va:{node_str}"),
                        "-filter_hw_device", "va",
                        "-f", "lavfi",
                        "-i", "nullsrc=s=64x64",
                        "-frames:v", "1",
                        "-f", "null",
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
    }).clone()
}

