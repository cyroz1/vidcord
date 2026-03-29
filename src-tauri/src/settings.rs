use std::path::PathBuf;
use std::io::Write;
use std::sync::OnceLock;

static SETTINGS_PATH: OnceLock<PathBuf> = OnceLock::new();

fn settings_path() -> &'static PathBuf {
    SETTINGS_PATH.get_or_init(|| {
        #[cfg(target_os = "windows")]
        {
            let base = std::env::var("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|_| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
            base.join("vidcord_settings.json")
        }
        #[cfg(not(target_os = "windows"))]
        {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".vidcord_settings.json")
        }
    })
}

pub struct SettingsManager;

impl SettingsManager {
    pub fn load() -> serde_json::Value {
        let path = settings_path();
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(v) = serde_json::from_str(&content) {
                    return v;
                }
            }
        }
        serde_json::json!({})
    }

    pub fn save(data: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
        let path = settings_path();
        let dir = path.parent().ok_or("No parent directory")?;

        // Atomic write: write to temp file, then rename
        let tmp = dir.join(format!(".vidcord_settings_{}.tmp", std::process::id()));
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(serde_json::to_string(data)?.as_bytes())?;
            f.flush()?;
        }
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}
