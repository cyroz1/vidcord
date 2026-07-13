use super::{configure_ffmpeg_command, find_vaapi_device};
use crate::gpu::get_system_gpus;
use std::collections::HashSet;
use std::io::ErrorKind;
use std::sync::{Mutex, OnceLock};

type EncoderList = Vec<(String, String)>;

static ENCODER_RE: OnceLock<regex_lite::Regex> = OnceLock::new();
static ENCODER_CACHE: OnceLock<Mutex<Option<EncoderList>>> = OnceLock::new();

pub struct AvailableEncoders {
    pub encoders: EncoderList,
    pub ffmpeg_missing: bool,
}

fn fallback_encoder_list() -> EncoderList {
    vec![("libx264".to_string(), "CPU (libx264)".to_string())]
}

pub fn get_available_encoders() -> AvailableEncoders {
    let cache = ENCODER_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.as_ref() {
            return AvailableEncoders {
                encoders: cached.clone(),
                ffmpeg_missing: false,
            };
        }
    }

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-encoders"]);
    configure_ffmpeg_command(&mut cmd);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let out = match cmd.output() {
        Ok(o) => o,
        // Don't cache the fallback: ffmpeg might not be installed *yet*.
        // If the user installs it and retries, we want a fresh probe.
        Err(err) => {
            return AvailableEncoders {
                encoders: fallback_encoder_list(),
                ffmpeg_missing: err.kind() == ErrorKind::NotFound,
            }
        }
    };

    if !out.status.success() {
        return AvailableEncoders {
            encoders: fallback_encoder_list(),
            ffmpeg_missing: true,
        };
    }

    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let gpus = get_system_gpus();
    let system = std::env::consts::OS;

    let re = ENCODER_RE.get_or_init(|| {
        regex_lite::Regex::new(r"^\s*V[A-Z.]*\s+([a-zA-Z0-9_]+)\s+").expect("invalid regex literal")
    });
    let mut ffmpeg_encoders: HashSet<String> = HashSet::new();
    for line in text.lines() {
        if let Some(cap) = re.captures(line) {
            ffmpeg_encoders.insert(cap[1].to_string());
        }
    }

    let mut result: Vec<(String, String)> = Vec::new();

    let candidates = [
        ("libx264", "CPU (libx264)", true, ""),
        ("libx265", "CPU H.265 (libx265)", true, ""),
        ("h264_nvenc", "NVIDIA (h264_nvenc)", false, "nvidia"),
        ("hevc_nvenc", "NVIDIA H.265 (hevc_nvenc)", false, "nvidia"),
        ("h264_amf", "AMD (h264_amf)", false, "amd"),
        ("hevc_amf", "AMD H.265 (hevc_amf)", false, "amd"),
        ("h264_qsv", "Intel (h264_qsv)", false, "intel"),
        ("hevc_qsv", "Intel H.265 (hevc_qsv)", false, "intel"),
        ("h264_vaapi", "Linux Hardware (h264_vaapi)", false, "vaapi"),
        (
            "hevc_vaapi",
            "Linux Hardware H.265 (hevc_vaapi)",
            false,
            "vaapi",
        ),
        (
            "h264_videotoolbox",
            "macOS (h264_videotoolbox)",
            false,
            "apple",
        ),
        (
            "hevc_videotoolbox",
            "macOS H.265 (hevc_videotoolbox)",
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
        result = fallback_encoder_list();
    }

    // Memoise so repeat invocations (initial load + Advanced-mode open +
    // post-install retry) don't re-spawn ffmpeg.
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(result.clone());
    }

    AvailableEncoders {
        encoders: result,
        ffmpeg_missing: false,
    }
}

/// Drop the cached encoder list so the next call re-probes ffmpeg. Called
/// after a successful FFmpeg install so the app picks up newly-available
/// hardware encoders without requiring a restart.
pub fn invalidate_encoder_cache() {
    if let Some(cache) = ENCODER_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            *guard = None;
        }
    }
}
