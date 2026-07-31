use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static SETTINGS_PATH: OnceLock<PathBuf> = OnceLock::new();
static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(serde::Serialize, serde::Deserialize)]
pub struct PersistedEncoder {
    pub name: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_selectable: Option<bool>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct PersistedSettingsPreset {
    pub id: String,
    pub name: String,
    pub settings: serde_json::Value,
}

/// Typed schema for persisted settings.
/// Unknown keys in the JSON file are silently dropped on load by deserializing
/// through this struct and re-serializing, preventing corrupt or stale data
/// from accumulating in the live settings object.
#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gif_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gif_quality_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gif_fps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lossless_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_target_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps_option: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_fps: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_encoder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remove_audio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_normalize: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crop_aspect_ratio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_output_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder_capabilities: Option<Vec<PersistedEncoder>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presets: Option<Vec<PersistedSettingsPreset>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_last_check: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_dismissed_version: Option<String>,
}

fn settings_path() -> &'static PathBuf {
    SETTINGS_PATH.get_or_init(|| {
        let base = dirs::data_local_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
        base.join("vidcord").join("settings.json")
    })
}

pub struct SettingsManager;

pub(crate) fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::iter::once;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(once(0)).collect();
        let destination_wide: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(once(0))
            .collect();

        // std::fs::rename does not replace an existing destination on Windows.
        // MoveFileExW keeps the old file intact if replacement fails and asks
        // Windows to flush the move before returning.
        let replaced = unsafe {
            MoveFileExW(
                source_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if replaced == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::fs::rename(source, destination)
    }
}

fn write_atomically(
    data: &serde_json::Value,
    path: &Path,
    temp_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = path.parent().ok_or("No parent directory")?;
    std::fs::create_dir_all(dir)?;

    let tmp = dir.join(temp_name);
    let write_result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut file = std::fs::File::create(&tmp)?;
        serde_json::to_writer(&mut file, data)?;
        file.flush()?;
        file.sync_all()?;
        replace_file(&tmp, path)?;

        #[cfg(unix)]
        std::fs::File::open(dir)?.sync_all()?;

        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    write_result
}

impl SettingsManager {
    pub fn load() -> serde_json::Value {
        let path = settings_path();
        if let Ok(content) = std::fs::read_to_string(path) {
            // Deserialize through the typed struct to silently drop unknown or
            // invalid keys, then re-serialize to plain JSON for the frontend.
            if let Ok(typed) = serde_json::from_str::<Settings>(&content) {
                if let Ok(v) = serde_json::to_value(typed) {
                    return v;
                }
            }
        }
        serde_json::json!({})
    }

    pub fn save(data: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
        let _write_guard = SETTINGS_WRITE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let path = settings_path();
        write_atomically(data, path, &format!("settings_{}.tmp", std::process::id()))
    }

    /// Save to an explicit path (used in tests to avoid touching the real settings file).
    #[cfg(test)]
    pub fn save_to(
        data: &serde_json::Value,
        path: &std::path::Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        write_atomically(
            data,
            path,
            &format!("settings_test_{}.tmp", std::process::id()),
        )
    }

    /// Load from an explicit path (used in tests).
    #[cfg(test)]
    pub fn load_from(path: &std::path::Path) -> serde_json::Value {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(typed) = serde_json::from_str::<Settings>(&content) {
                if let Ok(v) = serde_json::to_value(typed) {
                    return v;
                }
            }
        }
        serde_json::json!({})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_settings_round_trip() {
        let dir = std::env::temp_dir().join(format!("vidcord_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        let original = serde_json::json!({
            "quality_index": 2,
            "gif_mode": true,
            "gif_quality_index": 1,
            "gif_fps": 50,
            "advanced_mode": true,
            "lossless_mode": false,
            "advanced_target_size": "12.5",
            "advanced_resolution": "1080p",
            "fps_option": "30",
            "advanced_fps": "24",
            "advanced_encoder": "libx264",
            "remove_audio": false,
            "audio_normalize": true,
            "crop_aspect_ratio": "9:16",
            "output_destination": "custom",
            "custom_output_directory": "/tmp/vidcord-exports",
            "completion_action": "copy",
            "encoder_label": "CPU (libx264)",
            "encoder_capabilities": [
                { "name": "libx264", "label": "CPU (libx264)", "auto_selectable": false },
                {
                    "name": "h264_videotoolbox",
                    "label": "macOS (h264_videotoolbox)",
                    "auto_selectable": true
                }
            ],
            "presets": [
                {
                    "id": "discord-mobile",
                    "name": "Discord mobile",
                    "settings": { "quality_index": 1, "advanced_mode": false }
                }
            ]
        });

        SettingsManager::save_to(&original, &path).unwrap();
        let loaded = SettingsManager::load_from(&path);

        assert_eq!(loaded["quality_index"], 2);
        assert_eq!(loaded["gif_mode"], true);
        assert_eq!(loaded["gif_quality_index"], 1);
        assert_eq!(loaded["gif_fps"], 50);
        assert_eq!(loaded["advanced_mode"], true);
        assert_eq!(loaded["lossless_mode"], false);
        assert_eq!(loaded["advanced_target_size"], "12.5");
        assert_eq!(loaded["advanced_resolution"], "1080p");
        assert_eq!(loaded["fps_option"], "30");
        assert_eq!(loaded["advanced_fps"], "24");
        assert_eq!(loaded["advanced_encoder"], "libx264");
        assert_eq!(loaded["remove_audio"], false);
        assert_eq!(loaded["audio_normalize"], true);
        assert_eq!(loaded["crop_aspect_ratio"], "9:16");
        assert_eq!(loaded["output_destination"], "custom");
        assert_eq!(loaded["custom_output_directory"], "/tmp/vidcord-exports");
        assert_eq!(loaded["completion_action"], "copy");
        assert_eq!(loaded["encoder_label"], "CPU (libx264)");
        assert_eq!(
            loaded["encoder_capabilities"][1]["name"],
            "h264_videotoolbox"
        );
        assert_eq!(loaded["encoder_capabilities"][1]["auto_selectable"], true);
        assert_eq!(loaded["presets"][0]["id"], "discord-mobile");
        assert_eq!(loaded["presets"][0]["settings"]["quality_index"], 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_settings_repeated_save_replaces_existing_file() {
        let dir = std::env::temp_dir().join(format!("vidcord_test_replace_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        SettingsManager::save_to(&serde_json::json!({ "quality_index": 1 }), &path).unwrap();
        SettingsManager::save_to(&serde_json::json!({ "quality_index": 4 }), &path).unwrap();

        assert_eq!(SettingsManager::load_from(&path)["quality_index"], 4);
        assert!(!dir
            .join(format!("settings_test_{}.tmp", std::process::id()))
            .exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_settings_load_missing_file_returns_empty_object() {
        let path = std::path::Path::new("/tmp/vidcord_nonexistent_settings_xyz.json");
        let loaded = SettingsManager::load_from(path);
        assert_eq!(loaded, serde_json::json!({}));
    }

    #[test]
    fn test_settings_load_corrupt_file_returns_empty_object() {
        let dir = std::env::temp_dir().join(format!("vidcord_test_corrupt_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, b"not valid json {{{").unwrap();

        let loaded = SettingsManager::load_from(&path);
        assert_eq!(loaded, serde_json::json!({}));

        std::fs::remove_dir_all(&dir).ok();
    }
}
