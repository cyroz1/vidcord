use crate::ffmpeg::{get_available_encoders, get_ffmpeg_env};
use std::process::Stdio;
use std::sync::OnceLock;

// Cached regex for the "show encoders" dialog — compiled once, reused on repeat calls.
static LIST_ENCODER_RE: OnceLock<regex_lite::Regex> = OnceLock::new();

#[tauri::command]
pub async fn detect_encoders() -> Vec<serde_json::Value> {
    tokio::task::spawn_blocking(|| {
        get_available_encoders()
            .into_iter()
            .map(|(name, label)| serde_json::json!({"name": name, "label": label}))
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_else(|_| vec![serde_json::json!({"name": "libx264", "label": "CPU (libx264)", "ffmpeg_missing": true})])
}

#[tauri::command]
pub async fn check_ffmpeg_available() -> bool {
    tokio::task::spawn_blocking(|| {
        #[allow(unused_mut)]
        let mut cmd = std::process::Command::new("ffmpeg");
        cmd.arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        cmd.status().map(|s| s.success()).unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
pub async fn list_ffmpeg_video_encoders() -> Result<String, String> {
    tokio::task::spawn_blocking(|| -> Result<String, String> {
        #[allow(unused_mut)]
        let mut cmd = std::process::Command::new("ffmpeg");
        cmd.args(["-hide_banner", "-encoders"])
            .envs(get_ffmpeg_env());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run ffmpeg: {e}"))?;
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
pub fn get_vaapi_device() -> Option<String> {
    crate::ffmpeg::find_vaapi_device()
}
