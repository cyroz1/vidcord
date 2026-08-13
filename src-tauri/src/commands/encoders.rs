use crate::ffmpeg::{
    configure_ffmpeg_command, get_available_encoders, get_or_discover_encoder_listing,
    invalidate_encoder_cache,
};
use crate::gpu::spawn_captured_command;
use crate::log::vidcord_log;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
#[cfg(target_os = "windows")]
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

// Cached regex for the "show encoders" dialog — compiled once, reused on repeat calls.
static LIST_ENCODER_RE: OnceLock<regex_lite::Regex> = OnceLock::new();

// Cache the result of the ffmpeg availability probe for 30 seconds to avoid
// spawning a new process on every call during startup / rapid re-checks.
static FFMPEG_AVAIL_CACHE: OnceLock<Mutex<Option<(bool, Instant)>>> = OnceLock::new();
const FFMPEG_CACHE_TTL: Duration = Duration::from_secs(30);
const COMMAND_PROBE_TIMEOUT: Duration = Duration::from_secs(4);

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

#[cfg(target_os = "windows")]
fn ffmpeg_tools_exist(directory: &Path) -> bool {
    directory.join("ffmpeg.exe").is_file() && directory.join("ffprobe.exe").is_file()
}

#[cfg(target_os = "windows")]
fn find_ffmpeg_bin_within(directory: &Path, remaining_depth: usize) -> Option<PathBuf> {
    if ffmpeg_tools_exist(directory) {
        return Some(directory.to_path_buf());
    }
    if remaining_depth == 0 {
        return None;
    }

    let mut child_directories = std::fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    // Prefer the newest version-named directory while remaining deterministic.
    child_directories.sort_by(|left, right| right.file_name().cmp(&left.file_name()));

    child_directories
        .into_iter()
        .find_map(|path| find_ffmpeg_bin_within(&path, remaining_depth - 1))
}

#[cfg(target_os = "windows")]
fn find_winget_ffmpeg_bin(winget_roots: &[PathBuf]) -> Option<PathBuf> {
    for root in winget_roots {
        let links = root.join("Links");
        if ffmpeg_tools_exist(&links) {
            return Some(links);
        }

        let packages = root.join("Packages");
        let mut package_directories = std::fs::read_dir(packages)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("Gyan.FFmpeg_")
            })
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();
        package_directories.sort_by(|left, right| right.file_name().cmp(&left.file_name()));

        if let Some(bin) = package_directories
            .into_iter()
            .find_map(|path| find_ffmpeg_bin_within(&path, 3))
        {
            return Some(bin);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn windows_winget_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        roots.push(
            PathBuf::from(local_app_data)
                .join("Microsoft")
                .join("WinGet"),
        );
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(program_files) = std::env::var_os(variable) {
            let root = PathBuf::from(program_files).join("WinGet");
            if !roots.iter().any(|existing| existing == &root) {
                roots.push(root);
            }
        }
    }
    roots
}

#[cfg(target_os = "windows")]
fn recover_windows_ffmpeg_path() -> bool {
    let Some(bin) = find_winget_ffmpeg_bin(&windows_winget_roots()) else {
        return false;
    };

    let old_path = std::env::var_os("PATH").unwrap_or_default();
    let already_present = std::env::split_paths(&old_path).any(|entry| {
        entry
            .to_string_lossy()
            .eq_ignore_ascii_case(&bin.to_string_lossy())
    });
    if !already_present {
        let mut new_path = OsString::from(bin);
        if !old_path.is_empty() {
            new_path.push(";");
            new_path.push(old_path);
        }
        std::env::set_var("PATH", new_path);
        vidcord_log("Recovered FFmpeg from its WinGet installation directory.");
    }
    true
}

fn ffmpeg_probe() -> bool {
    if ffmpeg_tool_probe("ffmpeg") && ffmpeg_tool_probe("ffprobe") {
        return true;
    }

    #[cfg(target_os = "windows")]
    if recover_windows_ffmpeg_path() {
        return ffmpeg_tool_probe("ffmpeg") && ffmpeg_tool_probe("ffprobe");
    }

    false
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
    #[cfg(target_os = "windows")]
    let result = if !result && recover_windows_ffmpeg_path() {
        ffmpeg_tool_probe("ffprobe")
    } else {
        result
    };
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

        // WinGet updates the registry PATH but cannot update this running
        // process. If normal discovery fails, recover its known package
        // directory and retry so first-launch installation works without a
        // reboot. A working custom FFmpeg earlier on PATH remains preferred.
        #[cfg(target_os = "windows")]
        let detected = if detected.ffmpeg_missing && recover_windows_ffmpeg_path() {
            get_available_encoders()
        } else {
            detected
        };

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
                let auto_selectable = detected.auto_selectable.contains(&name);
                if index == 0 && ffmpeg_missing {
                    serde_json::json!({
                        "name": name,
                        "label": label,
                        "auto_selectable": auto_selectable,
                        "ffmpeg_missing": true
                    })
                } else {
                    serde_json::json!({
                        "name": name,
                        "label": label,
                        "auto_selectable": auto_selectable
                    })
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
                            status: "failed".to_string(),
                            message: "FFmpeg was installed, but vidcord could not locate both ffmpeg.exe and ffprobe.exe. Open the setup guide to repair PATH."
                                .to_string(),
                            hint_command: Some(
                                "Get-Command ffmpeg; Get-Command ffprobe".to_string(),
                            ),
                            guide_url: Some(
                                "https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md"
                                    .to_string(),
                            ),
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
        let stdout = get_or_discover_encoder_listing()?;

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

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::find_winget_ffmpeg_bin;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after the Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "vidcord-encoders-{label}-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("test directory should be created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn create_tool_pair(directory: &Path) {
        std::fs::create_dir_all(directory).expect("tool directory should be created");
        std::fs::write(directory.join("ffmpeg.exe"), b"test")
            .expect("ffmpeg fixture should be written");
        std::fs::write(directory.join("ffprobe.exe"), b"test")
            .expect("ffprobe fixture should be written");
    }

    #[test]
    fn finds_winget_portable_links() {
        let root = TestDirectory::new("links");
        let links = root.path().join("Links");
        create_tool_pair(&links);

        assert_eq!(
            find_winget_ffmpeg_bin(&[root.path().to_path_buf()]),
            Some(links)
        );
    }

    #[test]
    fn finds_nested_gyan_ffmpeg_package_bin() {
        let root = TestDirectory::new("package");
        let bin = root
            .path()
            .join("Packages")
            .join("Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join("ffmpeg-8.0-full_build")
            .join("bin");
        create_tool_pair(&bin);

        assert_eq!(
            find_winget_ffmpeg_bin(&[root.path().to_path_buf()]),
            Some(bin)
        );
    }

    #[test]
    fn ignores_incomplete_or_unrelated_packages() {
        let root = TestDirectory::new("invalid");
        let incomplete = root
            .path()
            .join("Packages")
            .join("Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join("ffmpeg-8.0-full_build")
            .join("bin");
        std::fs::create_dir_all(&incomplete).expect("tool directory should be created");
        std::fs::write(incomplete.join("ffmpeg.exe"), b"test")
            .expect("ffmpeg fixture should be written");
        create_tool_pair(
            &root
                .path()
                .join("Packages")
                .join("Someone.Else")
                .join("bin"),
        );

        assert_eq!(find_winget_ffmpeg_bin(&[root.path().to_path_buf()]), None);
    }
}
