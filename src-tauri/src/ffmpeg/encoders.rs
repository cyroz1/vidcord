use super::{configure_ffmpeg_command, find_vaapi_device};
use crate::gpu::{get_system_gpus, spawn_captured_command};
use crate::log::vidcord_log;
use std::collections::HashSet;
use std::io::ErrorKind;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

type EncoderList = Vec<(String, String)>;

static ENCODER_RE: OnceLock<regex_lite::Regex> = OnceLock::new();
static ENCODER_CACHE: OnceLock<Mutex<Option<CachedEncoders>>> = OnceLock::new();
const ENCODER_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(8);
const ENCODER_VALIDATION_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct CachedEncoders {
    encoders: EncoderList,
    auto_selectable: HashSet<String>,
}

pub struct AvailableEncoders {
    pub encoders: EncoderList,
    pub auto_selectable: HashSet<String>,
    pub ffmpeg_missing: bool,
    pub ffmpeg_freshly_probed: bool,
}

fn fallback_encoder_list() -> EncoderList {
    vec![("libx264".to_string(), "CPU (libx264)".to_string())]
}

fn fallback_available_encoders(ffmpeg_missing: bool) -> AvailableEncoders {
    AvailableEncoders {
        encoders: fallback_encoder_list(),
        auto_selectable: HashSet::from(["libx264".to_string()]),
        ffmpeg_missing,
        ffmpeg_freshly_probed: false,
    }
}

fn encoder_validation_args(encoder: &str, vaapi_device: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
    ];
    if let Some(device) = vaapi_device {
        args.extend(["-vaapi_device".into(), device.into()]);
    }
    args.extend([
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        "color=c=black:s=64x64:d=0.1".into(),
    ]);
    if vaapi_device.is_some() {
        args.extend(["-vf".into(), "format=nv12,hwupload".into()]);
    }
    args.extend([
        "-frames:v".into(),
        "1".into(),
        "-an".into(),
        "-c:v".into(),
        encoder.into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]);
    args
}

fn encoder_initializes(encoder: &str) -> bool {
    let vaapi_device = if encoder.ends_with("_vaapi") {
        find_vaapi_device()
    } else {
        None
    };
    if encoder.ends_with("_vaapi") && vaapi_device.is_none() {
        return false;
    }

    #[allow(unused_mut)]
    let mut command = std::process::Command::new("ffmpeg");
    command.args(encoder_validation_args(encoder, vaapi_device.as_deref()));
    configure_ffmpeg_command(&mut command);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    match spawn_captured_command(&mut command)
        .and_then(|child| child.wait_for_output(ENCODER_VALIDATION_TIMEOUT))
    {
        Ok(Some(output)) if output.status.success() => true,
        Ok(Some(_)) => {
            vidcord_log(&format!(
                "Encoder validation: {encoder} is listed but could not initialize"
            ));
            false
        }
        Ok(None) => {
            vidcord_log(&format!("Encoder validation: {encoder} timed out"));
            false
        }
        Err(error) => {
            vidcord_log(&format!("Encoder validation: {encoder} failed: {error}"));
            false
        }
    }
}

pub fn get_available_encoders() -> AvailableEncoders {
    let discovery_started = Instant::now();
    let cache = ENCODER_CACHE.get_or_init(|| Mutex::new(None));
    let mut cache_guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cached) = cache_guard.as_ref() {
        vidcord_log(&format!(
            "Encoder discovery: cache hit in {} ms",
            discovery_started.elapsed().as_millis()
        ));
        return AvailableEncoders {
            encoders: cached.encoders.clone(),
            auto_selectable: cached.auto_selectable.clone(),
            ffmpeg_missing: false,
            ffmpeg_freshly_probed: false,
        };
    }

    // GPU discovery is independent of FFmpeg's compiled encoder list. Start it
    // after FFmpeg launches so missing-FFmpeg detection stays fast, then overlap
    // the platform query with encoder enumeration on every OS.
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-encoders"]);
    configure_ffmpeg_command(&mut cmd);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let child = match spawn_captured_command(&mut cmd) {
        Ok(child) => child,
        // Don't cache the fallback: ffmpeg might not be installed *yet*.
        // If the user installs it and retries, we want a fresh probe.
        Err(err) => {
            vidcord_log(&format!(
                "Encoder discovery: FFmpeg launch failed after {} ms",
                discovery_started.elapsed().as_millis()
            ));
            return fallback_available_encoders(err.kind() == ErrorKind::NotFound);
        }
    };

    // Start the slow platform query only after FFmpeg launches successfully.
    // This preserves fast missing-FFmpeg detection without giving up the
    // overlap on systems where both probes are available.
    let gpu_probe = std::thread::spawn(get_system_gpus);

    // Treat the timeout as one end-to-end encoder-enumeration budget.
    let remaining = ENCODER_DISCOVERY_TIMEOUT.saturating_sub(discovery_started.elapsed());
    let out = match child.wait_for_output(remaining) {
        Ok(Some(out)) => out,
        Ok(None) => {
            vidcord_log(&format!(
                "Encoder discovery: FFmpeg timed out after {} ms",
                discovery_started.elapsed().as_millis()
            ));
            return fallback_available_encoders(true);
        }
        Err(error) => {
            vidcord_log(&format!(
                "Encoder discovery: FFmpeg probe failed after {} ms: {error}",
                discovery_started.elapsed().as_millis()
            ));
            return fallback_available_encoders(true);
        }
    };

    if !out.status.success() {
        vidcord_log(&format!(
            "Encoder discovery: FFmpeg exited unsuccessfully after {} ms",
            discovery_started.elapsed().as_millis()
        ));
        return fallback_available_encoders(true);
    }

    let gpus = gpu_probe.join().unwrap_or_else(|_| get_system_gpus());

    let text = String::from_utf8_lossy(&out.stdout);
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

    let mut auto_selectable = HashSet::from(["libx264".to_string()]);
    for (encoder, _) in &result {
        if encoder.starts_with("h264_") && encoder_initializes(encoder) {
            auto_selectable.insert(encoder.clone());
        }
    }

    // Memoise so repeat invocations (initial load + Advanced-mode open +
    // post-install retry) don't re-spawn ffmpeg.
    *cache_guard = Some(CachedEncoders {
        encoders: result.clone(),
        auto_selectable: auto_selectable.clone(),
    });

    vidcord_log(&format!(
        "Encoder discovery: completed in {} ms ({} available)",
        discovery_started.elapsed().as_millis(),
        result.len()
    ));

    AvailableEncoders {
        encoders: result,
        auto_selectable,
        ffmpeg_missing: false,
        ffmpeg_freshly_probed: true,
    }
}

/// Drop the cached encoder list so the next call re-probes ffmpeg. Called
/// after a successful FFmpeg install so the app picks up newly-available
/// hardware encoders without requiring a restart.
pub fn invalidate_encoder_cache() {
    if let Some(cache) = ENCODER_CACHE.get() {
        *cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vaapi_validation_uploads_software_frames() {
        let args = encoder_validation_args("h264_vaapi", Some("/dev/dri/renderD128"));

        assert!(args
            .windows(2)
            .any(|args| args == ["-vaapi_device", "/dev/dri/renderD128"]));
        assert!(args
            .windows(2)
            .any(|args| args == ["-vf", "format=nv12,hwupload"]));
        assert!(args.windows(2).any(|args| args == ["-c:v", "h264_vaapi"]));
    }

    #[test]
    fn non_vaapi_validation_does_not_add_upload_filter() {
        let args = encoder_validation_args("h264_nvenc", None);

        assert!(!args.iter().any(|arg| arg == "format=nv12,hwupload"));
        assert!(args.windows(2).any(|args| args == ["-c:v", "h264_nvenc"]));
    }
}
