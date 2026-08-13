use super::{
    configure_ffmpeg_command, ffmpeg_missing_error, find_vaapi_device, FFMPEG_MISSING_ERROR_MARKER,
};
use crate::gpu::{get_system_gpus, spawn_captured_command};
use crate::log::vidcord_log;
use std::collections::HashSet;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

type EncoderList = Vec<(String, String)>;

static ENCODER_RE: OnceLock<regex_lite::Regex> = OnceLock::new();
static ENCODER_CACHE: OnceLock<(Mutex<EncoderCacheState>, Condvar)> = OnceLock::new();
static ENCODER_LISTING: OnceLock<(Mutex<EncoderListingState>, Condvar)> = OnceLock::new();
const ENCODER_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(8);
const ENCODER_VALIDATION_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct CachedEncoders {
    encoders: EncoderList,
    auto_selectable: HashSet<String>,
}

struct EncoderCacheState {
    cached: Option<CachedEncoders>,
    discovering: bool,
    generation: u64,
}

struct EncoderDiscoveryGuard {
    cache: &'static Mutex<EncoderCacheState>,
    ready: &'static Condvar,
}

struct EncoderListingState {
    cached: Option<String>,
    discovering: bool,
    generation: u64,
}

impl Drop for EncoderDiscoveryGuard {
    fn drop(&mut self) {
        let mut state = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        state.discovering = false;
        self.ready.notify_all();
    }
}

fn encoder_cache() -> (&'static Mutex<EncoderCacheState>, &'static Condvar) {
    let state = ENCODER_CACHE.get_or_init(|| {
        (
            Mutex::new(EncoderCacheState {
                cached: None,
                discovering: false,
                generation: 0,
            }),
            Condvar::new(),
        )
    });
    (&state.0, &state.1)
}

fn encoder_listing() -> (&'static Mutex<EncoderListingState>, &'static Condvar) {
    let state = ENCODER_LISTING.get_or_init(|| {
        (
            Mutex::new(EncoderListingState {
                cached: None,
                discovering: false,
                generation: 0,
            }),
            Condvar::new(),
        )
    });
    (&state.0, &state.1)
}

pub struct AvailableEncoders {
    pub encoders: EncoderList,
    pub auto_selectable: HashSet<String>,
    pub ffmpeg_missing: bool,
    pub ffmpeg_freshly_probed: bool,
}

fn discover_encoder_listing() -> Result<String, String> {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-encoders"]);
    configure_ffmpeg_command(&mut cmd);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let child = spawn_captured_command(&mut cmd).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ffmpeg_missing_error()
        } else {
            format!("Failed to run ffmpeg: {error}")
        }
    })?;
    let output = child
        .wait_for_output(ENCODER_DISCOVERY_TIMEOUT)
        .map_err(|error| format!("Failed while listing FFmpeg encoders: {error}"))?
        .ok_or_else(|| "FFmpeg encoder listing timed out.".to_string())?;
    if !output.status.success() {
        return Err("FFmpeg could not list its video encoders.".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn get_or_discover_encoder_listing() -> Result<String, String> {
    let (listing, ready) = encoder_listing();
    let mut state = listing.lock().unwrap_or_else(|e| e.into_inner());
    let discovery_generation = loop {
        if let Some(cached) = state.cached.as_ref() {
            return Ok(cached.clone());
        }
        if !state.discovering {
            state.discovering = true;
            break state.generation;
        }
        state = ready.wait(state).unwrap_or_else(|e| e.into_inner());
    };
    drop(state);

    let result = discover_encoder_listing();
    let mut state = listing.lock().unwrap_or_else(|e| e.into_inner());
    state.discovering = false;
    if state.generation == discovery_generation {
        if let Ok(text) = &result {
            state.cached = Some(text.clone());
        }
    }
    ready.notify_all();
    result
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
    let (cache, ready) = encoder_cache();
    let discovery_generation = {
        let mut state = cache.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(cached) = state.cached.as_ref() {
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
            if !state.discovering {
                state.discovering = true;
                break state.generation;
            }
            state = ready.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    };
    let _discovery_guard = EncoderDiscoveryGuard { cache, ready };

    // GPU discovery and the shared FFmpeg listing run concurrently, while the
    // listing's in-flight state prevents Advanced mode from spawning a second
    // `ffmpeg -encoders` process during cold startup.
    let gpu_probe = std::thread::spawn(get_system_gpus);
    let text = match get_or_discover_encoder_listing() {
        Ok(text) => text,
        Err(error) => {
            vidcord_log(&format!(
                "Encoder discovery: FFmpeg listing failed after {} ms: {error}",
                discovery_started.elapsed().as_millis()
            ));
            return fallback_available_encoders(error.starts_with(FFMPEG_MISSING_ERROR_MARKER));
        }
    };
    let gpus = gpu_probe.join().unwrap_or_else(|_| get_system_gpus());
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
    let discovered = CachedEncoders {
        encoders: result.clone(),
        auto_selectable: auto_selectable.clone(),
    };
    let cached = {
        let mut cache_guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if cache_guard.generation == discovery_generation && cache_guard.cached.is_none() {
            cache_guard.cached = Some(discovered.clone());
        }
        cache_guard.cached.clone().unwrap_or(discovered)
    };

    vidcord_log(&format!(
        "Encoder discovery: completed in {} ms ({} available)",
        discovery_started.elapsed().as_millis(),
        result.len()
    ));

    AvailableEncoders {
        encoders: cached.encoders,
        auto_selectable: cached.auto_selectable,
        ffmpeg_missing: false,
        ffmpeg_freshly_probed: true,
    }
}

/// Drop the cached encoder list so the next call re-probes ffmpeg. Called
/// after a successful FFmpeg install so the app picks up newly-available
/// hardware encoders without requiring a restart.
pub fn invalidate_encoder_cache() {
    if let Some((cache, ready)) = ENCODER_CACHE.get() {
        let mut state = cache.lock().unwrap_or_else(|e| e.into_inner());
        state.cached = None;
        state.generation = state.generation.wrapping_add(1);
        ready.notify_all();
    }
    if let Some((listing, ready)) = ENCODER_LISTING.get() {
        let mut state = listing.lock().unwrap_or_else(|e| e.into_inner());
        state.cached = None;
        state.generation = state.generation.wrapping_add(1);
        ready.notify_all();
    }
    super::clear_preview_clip_plan_cache();
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
