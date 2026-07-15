use crate::ffmpeg::{
    configure_ffmpeg_command, ffmpeg_missing_error, get_available_encoders,
    invalidate_encoder_cache,
};
use crate::gpu::spawn_captured_command;
use crate::log::vidcord_log;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// Cached regex for the "show encoders" dialog — compiled once, reused on repeat calls.
static LIST_ENCODER_RE: OnceLock<regex_lite::Regex> = OnceLock::new();

// Cache the result of the ffmpeg availability probe for 30 seconds to avoid
// spawning a new process on every call during startup / rapid re-checks.
static FFMPEG_AVAIL_CACHE: OnceLock<Mutex<Option<(bool, Instant)>>> = OnceLock::new();
const FFMPEG_CACHE_TTL: Duration = Duration::from_secs(30);
const COMMAND_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const ENCODER_LIST_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FfmpegInstallResult {
    pub status: String,
    pub message: String,
    pub hint_command: Option<String>,
    pub guide_url: Option<String>,
}

#[derive(Deserialize)]
pub struct FfmpegInstallOptions {
    pub allow_privileged: Option<bool>,
}

fn command_exists(cmd: &str) -> bool {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(cmd);
    command
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    matches!(
        spawn_captured_command(&mut command)
            .and_then(|child| child.wait_for_output(COMMAND_PROBE_TIMEOUT)),
        Ok(Some(output)) if output.status.success()
    )
}

fn ffmpeg_tool_probe(tool: &str) -> bool {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(tool);
    cmd.arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_ffmpeg_command(&mut cmd);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    match spawn_captured_command(&mut cmd)
        .and_then(|child| child.wait_for_output(COMMAND_PROBE_TIMEOUT))
    {
        Ok(Some(output)) => output.status.success(),
        Ok(None) => {
            vidcord_log(&format!("FFmpeg tool probe timed out: {tool}"));
            false
        }
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                vidcord_log(&format!("FFmpeg tool probe failed for {tool}: {error}"));
            }
            false
        }
    }
}

fn ffmpeg_probe() -> bool {
    ffmpeg_tool_probe("ffmpeg") && ffmpeg_tool_probe("ffprobe")
}

fn ffmpeg_available() -> bool {
    let cache = FFMPEG_AVAIL_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((result, checked_at)) = *guard {
        if checked_at.elapsed() < FFMPEG_CACHE_TTL {
            return result;
        }
    }
    let result = ffmpeg_probe();
    *guard = Some((result, Instant::now()));
    result
}

// `get_available_encoders` has already run `ffmpeg -encoders` successfully.
// Reuse that proof and probe only the companion ffprobe executable instead of
// launching both version commands again. A cached false is deliberately
// re-checked because FFmpeg may have been installed outside vidcord meanwhile.
fn ffprobe_available_after_ffmpeg_success() -> bool {
    let cache = FFMPEG_AVAIL_CACHE.get_or_init(|| Mutex::new(None));
    {
        let guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((true, checked_at)) = *guard {
            if checked_at.elapsed() < FFMPEG_CACHE_TTL {
                return true;
            }
        }
    }

    let result = ffmpeg_tool_probe("ffprobe");
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some((result, Instant::now()));
    result
}

// Used after an install attempt to bypass the TTL and get a fresh answer.
// Called from platform-specific install branches (Windows, Linux).
#[allow(dead_code)]
fn ffmpeg_available_fresh() -> bool {
    let cache = FFMPEG_AVAIL_CACHE.get_or_init(|| Mutex::new(None));
    let result = ffmpeg_probe();
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some((result, Instant::now()));
    drop(guard);
    // A fresh ffmpeg install may expose new hardware encoders; drop the
    // encoder-list cache so `detect_encoders` re-probes on next call.
    if result {
        invalidate_encoder_cache();
    }
    result
}

#[cfg(target_os = "linux")]
fn run_shell(command: &str) -> std::io::Result<std::process::ExitStatus> {
    std::process::Command::new("sh")
        .args(["-lc", command])
        .status()
}

#[tauri::command]
pub async fn detect_encoders() -> Vec<serde_json::Value> {
    tokio::task::spawn_blocking(|| {
        let detected = get_available_encoders();
        let ffmpeg_missing = detected.ffmpeg_missing
            || if detected.ffmpeg_freshly_probed {
                !ffprobe_available_after_ffmpeg_success()
            } else {
                !ffmpeg_available()
            };
        detected
            .encoders
            .into_iter()
            .enumerate()
            .map(|(index, (name, label))| {
                if index == 0 && ffmpeg_missing {
                    serde_json::json!({"name": name, "label": label, "ffmpeg_missing": true})
                } else {
                    serde_json::json!({"name": name, "label": label})
                }
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_else(|_| vec![serde_json::json!({"name": "libx264", "label": "CPU (libx264)", "ffmpeg_missing": true})])
}

#[tauri::command]
pub async fn check_ffmpeg_available() -> bool {
    tokio::task::spawn_blocking(ffmpeg_available_fresh)
        .await
        .unwrap_or(false)
}

#[tauri::command]
#[allow(unused_variables)]
pub async fn install_ffmpeg_dependency(opts: Option<FfmpegInstallOptions>) -> FfmpegInstallResult {
    tokio::task::spawn_blocking(move || {
        if ffmpeg_available() {
            return FfmpegInstallResult {
                status: "already_available".to_string(),
                message: "FFmpeg is already installed and available on PATH.".to_string(),
                hint_command: None,
                guide_url: None,
            };
        }

        #[cfg(target_os = "windows")]
        {
            if !command_exists("winget") {
                return FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: "winget was not found. Install FFmpeg manually from the setup guide."
                        .to_string(),
                    hint_command: Some("winget install Gyan.FFmpeg".to_string()),
                    guide_url: Some("https://aka.ms/getwinget".to_string()),
                };
            }

            #[allow(unused_mut)]
            let mut cmd = std::process::Command::new("winget");
            cmd.args([
                "install",
                "--id",
                "Gyan.FFmpeg",
                "--exact",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--silent",
            ]);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }

            match cmd.status() {
                Ok(status) if status.success() => {
                    if ffmpeg_available_fresh() {
                        FfmpegInstallResult {
                            status: "installed".to_string(),
                            message: "FFmpeg installed successfully.".to_string(),
                            hint_command: None,
                            guide_url: None,
                        }
                    } else {
                        FfmpegInstallResult {
                            status: "installed".to_string(),
                            message:
                                "FFmpeg install completed. If it is still not detected, restart vidcord."
                                    .to_string(),
                            hint_command: None,
                            guide_url: None,
                        }
                    }
                }
                Ok(status) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: format!(
                        "winget failed with exit code {}. Install FFmpeg manually from the setup guide.",
                        status.code().unwrap_or(-1)
                    ),
                    hint_command: Some("winget install Gyan.FFmpeg".to_string()),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
                Err(err) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: format!("Failed to run winget: {err}"),
                    hint_command: Some("winget install Gyan.FFmpeg".to_string()),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
            }
        }

        #[cfg(target_os = "macos")]
        {
            if !command_exists("brew") {
                return FfmpegInstallResult {
                    status: "failed".to_string(),
                    message:
                        "Homebrew is not installed. Install Homebrew first, then try again."
                            .to_string(),
                    hint_command: Some("brew install ffmpeg".to_string()),
                    guide_url: Some("https://brew.sh".to_string()),
                };
            }

            match std::process::Command::new("brew")
                .args(["install", "ffmpeg"])
                .status()
            {
                Ok(status) if status.success() => {
                    if ffmpeg_available_fresh() {
                        FfmpegInstallResult {
                            status: "installed".to_string(),
                            message: "FFmpeg installed successfully with Homebrew.".to_string(),
                            hint_command: None,
                            guide_url: None,
                        }
                    } else {
                        FfmpegInstallResult {
                            status: "installed".to_string(),
                            message: "FFmpeg install completed. If it is still not detected, restart vidcord."
                                .to_string(),
                            hint_command: None,
                            guide_url: None,
                        }
                    }
                }
                Ok(status) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: format!(
                        "brew install ffmpeg failed with exit code {}.",
                        status.code().unwrap_or(-1)
                    ),
                    hint_command: Some("brew install ffmpeg".to_string()),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
                Err(err) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: format!("Failed to run brew: {err}"),
                    hint_command: Some("brew install ffmpeg".to_string()),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
            }
        }

        #[cfg(target_os = "linux")]
        {
            let allow_privileged = opts
                .as_ref()
                .and_then(|o| o.allow_privileged)
                .unwrap_or(false);

            let install_cmd = if command_exists("apt") {
                Some("apt install -y ffmpeg")
            } else if command_exists("dnf") {
                Some("dnf install -y ffmpeg")
            } else if command_exists("pacman") {
                Some("pacman -S --noconfirm ffmpeg")
            } else {
                None
            };

            let Some(install_cmd) = install_cmd else {
                return FfmpegInstallResult {
                    status: "unsupported".to_string(),
                    message: "Unsupported Linux package manager. Install ffmpeg manually."
                        .to_string(),
                    hint_command: None,
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                };
            };

            if !allow_privileged {
                return FfmpegInstallResult {
                    status: "requires_privileged".to_string(),
                    message:
                        "Linux install needs elevated privileges. Confirm to run the install command."
                            .to_string(),
                    hint_command: Some(format!("sudo {install_cmd}")),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                };
            }

            let status_result = if command_exists("pkexec") {
                run_shell(&format!("pkexec sh -lc '{}'", install_cmd.replace('\'', "'\\''")))
            } else if command_exists("sudo") {
                run_shell(&format!("sudo -n sh -lc '{}'", install_cmd.replace('\'', "'\\''")))
            } else {
                return FfmpegInstallResult {
                    status: "failed".to_string(),
                    message:
                        "No privilege escalation tool found (pkexec/sudo). Install FFmpeg manually."
                            .to_string(),
                    hint_command: Some(format!("sudo {install_cmd}")),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                };
            };

            match status_result {
                Ok(status) if status.success() => {
                    if ffmpeg_available_fresh() {
                        FfmpegInstallResult {
                            status: "installed".to_string(),
                            message: "FFmpeg installed successfully.".to_string(),
                            hint_command: None,
                            guide_url: None,
                        }
                    } else {
                        FfmpegInstallResult {
                            status: "installed".to_string(),
                            message:
                                "Install completed. If FFmpeg is still not detected, restart vidcord."
                                    .to_string(),
                            hint_command: None,
                            guide_url: None,
                        }
                    }
                }
                Ok(status) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: format!(
                        "Linux install command failed with exit code {}.",
                        status.code().unwrap_or(-1)
                    ),
                    hint_command: Some(format!("sudo {install_cmd}")),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
                Err(err) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: format!("Failed to run Linux install command: {err}"),
                    hint_command: Some(format!("sudo {install_cmd}")),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
            }
        }
    })
    .await
    .unwrap_or(FfmpegInstallResult {
        status: "failed".to_string(),
        message: "Installer task crashed unexpectedly.".to_string(),
        hint_command: None,
        guide_url: None,
    })
}

#[tauri::command]
pub async fn list_ffmpeg_video_encoders() -> Result<String, String> {
    tokio::task::spawn_blocking(|| -> Result<String, String> {
        #[allow(unused_mut)]
        let mut cmd = std::process::Command::new("ffmpeg");
        cmd.args(["-hide_banner", "-encoders"]);
        configure_ffmpeg_command(&mut cmd);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        let child = spawn_captured_command(&mut cmd).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ffmpeg_missing_error()
            } else {
                format!("Failed to run ffmpeg: {e}")
            }
        })?;
        let output = child
            .wait_for_output(ENCODER_LIST_TIMEOUT)
            .map_err(|e| format!("Failed while listing FFmpeg encoders: {e}"))?
            .ok_or_else(|| "FFmpeg encoder listing timed out.".to_string())?;
        if !output.status.success() {
            return Err("FFmpeg could not list its video encoders.".to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();

        let re = LIST_ENCODER_RE.get_or_init(|| {
            regex_lite::Regex::new(r"^\s*V[A-Z.]*\s+(\S+)\s+(.*)").expect("invalid regex literal")
        });
        let mut lines: Vec<String> = Vec::new();
        for line in stdout.lines() {
            if let Some(caps) = re.captures(line) {
                let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let desc = caps.get(2).map(|m| m.as_str().trim()).unwrap_or("");
                if desc.is_empty() {
                    lines.push(name.to_string());
                } else {
                    lines.push(format!("{name}  —  {desc}"));
                }
            }
        }
        if lines.is_empty() {
            Ok("No video encoders found.".to_string())
        } else {
            Ok(lines.join("\n"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_vaapi_device() -> Option<String> {
    tokio::task::spawn_blocking(crate::ffmpeg::find_vaapi_device)
        .await
        .unwrap_or(None)
}
