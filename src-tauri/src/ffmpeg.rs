#[cfg(target_os = "linux")]
use crate::log::vidcord_log;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

mod encoders;

pub use encoders::{
    get_available_encoders, get_or_discover_encoder_listing, invalidate_encoder_cache,
};

static VAAPI_CACHE: OnceLock<Option<String>> = OnceLock::new();
#[cfg(target_os = "linux")]
static LINUX_AMD_DRM_DEVICE: OnceLock<bool> = OnceLock::new();

pub const FFMPEG_MISSING_ERROR_MARKER: &str = "FFMPEG_MISSING:";
const PROBE_CANCELLED_ERROR_MARKER: &str = "PROBE_CANCELLED:";
const FFPROBE_TIMEOUT: Duration = Duration::from_secs(6);
#[cfg(target_os = "linux")]
const VAAPI_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(6);
#[cfg(target_os = "linux")]
const VAAPI_DEVICE_TIMEOUT: Duration = Duration::from_secs(2);

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
            terminate_tracked_process(pid);
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

#[cfg(unix)]
fn terminate_tracked_process(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

#[cfg(windows)]
fn terminate_tracked_process(pid: u32) {
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
        terminate_tracked_process(pid);
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
            terminate_tracked_process(pid);
        }
    }
}

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
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("ffprobe");
    cmd.args([
        "-v",
        "error",
        "-probesize",
        "10000000",
        "-analyzeduration",
        "5000000",
        "-print_format",
        "json",
        "-show_entries",
        "format=duration,bit_rate:stream=index,codec_name,codec_type,width,height,avg_frame_rate,r_frame_rate,sample_aspect_ratio,display_aspect_ratio,bit_rate,channels,duration,size,pix_fmt,color_space,color_transfer,color_primaries:stream_tags=title,name,language,handler_name:stream_side_data=rotation",
        "--",
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

    parse_video_probe(&out.stdout)
}

fn parse_video_probe(stdout: &[u8]) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
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

    let data: serde_json::Value = serde_json::from_slice(stdout)?;
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

    let mut width = video["width"].as_u64().unwrap_or(0);
    let mut height = video["height"].as_u64().unwrap_or(0);
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
        // FFmpeg autorotates before applying crop and scale filters.
        std::mem::swap(&mut width, &mut height);
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
        "pix_fmt": video["pix_fmt"].as_str(),
        "color_transfer": video["color_transfer"].as_str(),
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
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotated_probe_dimensions_match_the_autorotated_filter_input() {
        for rotation in [90, -90, 270] {
            let probe = serde_json::json!({
                "format": { "duration": "4.0" },
                "streams": [{
                    "codec_type": "video", "width": 1920, "height": 1080,
                    "sample_aspect_ratio": "1:1", "display_aspect_ratio": "16:9",
                    "side_data_list": [{ "rotation": rotation }]
                }]
            });
            let parsed = parse_video_probe(&serde_json::to_vec(&probe).unwrap()).unwrap();
            assert_eq!(parsed["width"], 1080);
            assert_eq!(parsed["height"], 1920);
            assert_eq!(parsed["display_width"], 1080);
            assert_eq!(parsed["display_height"], 1920);
        }
    }

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
