use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static SETTINGS_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Typed schema for persisted settings.
/// Unknown keys in the JSON file are silently dropped on load by deserializing
/// through this struct and re-serializing, preventing corrupt or stale data
/// from accumulating in the live settings object.
#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct Settings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_target_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advanced_encoder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remove_audio: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_last_check: Option<f64>,
}

fn settings_path() -> &'static PathBuf {
    SETTINGS_PATH.get_or_init(|| {
        let base = dirs::data_local_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
        let dir = base.join("vidcord");
        let _ = std::fs::create_dir_all(&dir);
        dir.join("settings.json")
    })
}

pub struct SettingsManager;

impl SettingsManager {
    pub fn load() -> serde_json::Value {
        let path = settings_path();
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                // Deserialize through the typed struct to silently drop unknown or
                // invalid keys, then re-serialize to plain JSON for the frontend.
                if let Ok(typed) = serde_json::from_str::<Settings>(&content) {
                    if let Ok(v) = serde_json::to_value(typed) {
                        return v;
                    }
                }
            }
        }
        serde_json::json!({})
    }

    pub fn save(data: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
        let path = settings_path();
        let dir = path.parent().ok_or("No parent directory")?;

        // Atomic write: write to temp file, then rename
        let tmp = dir.join(format!("settings_{}.tmp", std::process::id()));
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(serde_json::to_string(data)?.as_bytes())?;
            f.flush()?;
        }
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Save to an explicit path (used in tests to avoid touching the real settings file).
    #[cfg(test)]
    pub fn save_to(
        data: &serde_json::Value,
        path: &std::path::Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let dir = path.parent().ok_or("No parent directory")?;
        let tmp = dir.join(format!("settings_test_{}.tmp", std::process::id()));
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(serde_json::to_string(data)?.as_bytes())?;
            f.flush()?;
        }
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Load from an explicit path (used in tests).
    #[cfg(test)]
    pub fn load_from(path: &std::path::Path) -> serde_json::Value {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(typed) = serde_json::from_str::<Settings>(&content) {
                    if let Ok(v) = serde_json::to_value(typed) {
                        return v;
                    }
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
            "advanced_mode": true,
            "remove_audio": false,
            "encoder_label": "CPU (libx264)"
        });

        SettingsManager::save_to(&original, &path).unwrap();
        let loaded = SettingsManager::load_from(&path);

        assert_eq!(loaded["quality_index"], 2);
        assert_eq!(loaded["advanced_mode"], true);
        assert_eq!(loaded["remove_audio"], false);
        assert_eq!(loaded["encoder_label"], "CPU (libx264)");

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
