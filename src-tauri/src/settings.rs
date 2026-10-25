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
    pub gif_output_format: Option<String>,
    #[serde(skip_serializing)]
    pub gif_quality_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gif_target_mb: Option<u32>,
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
    pub batch_trim_start_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_trim_end_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_output_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_app_after_export: Option<bool>,
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

impl Settings {
    fn migrate_legacy_gif_target(mut self) -> Self {
        if self.gif_target_mb.is_none() {
            self.gif_target_mb = match self.gif_quality_index {
                // Before 7.4 the two choices were 20 MB and 50 MB. The
                // removed 50 MB choice is capped at the largest 7.4 target.
                Some(0) | Some(1) => Some(20),
                _ => None,
            };
        }
        self
    }
}

fn settings_path() -> &'static PathBuf {
    SETTINGS_PATH.get_or_init(|| {
        #[cfg(feature = "e2e")]
        if let Some(directory) = std::env::var_os("VIDCORD_E2E_DATA_DIR") {
            return PathBuf::from(directory)
                .join("vidcord")
                .join("settings.json");
        }
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
        // Create-new so a pre-planted symlink at the temp path is refused
        // instead of followed; a stale leftover from a crashed run of this
        // same process is cleared and the create retried once.
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                std::fs::remove_file(&tmp)?;
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&tmp)?
            }
            Err(error) => return Err(error.into()),
        };
        serde_json::to_writer(&mut file, data)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        replace_file(&tmp, path)?;

        // The replacement is already live at this point, so a directory
        // sync failure must not report the save as failed; it only weakens
        // the durability guarantee, which is worth a log line, not an error.
        #[cfg(unix)]
        if let Err(error) = std::fs::File::open(dir).and_then(|dir_file| dir_file.sync_all()) {
            crate::log::vidcord_log(&format!(
                "Settings: directory sync after save failed: {error}"
            ));
        }

        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    write_result
}

/// Round-trip an outgoing payload through the typed `Settings` struct so a
/// save can never persist a value that the next load would reject wholesale.
/// Unknown keys are dropped, matching load-time migration semantics.
fn normalize_for_save(
    data: &serde_json::Value,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let typed: Settings = serde_json::from_value(data.clone())?;
    Ok(serde_json::to_value(typed.migrate_legacy_gif_target())?)
}

fn typed_to_value(typed: Settings) -> Option<serde_json::Value> {
    match serde_json::to_value(typed.migrate_legacy_gif_target()) {
        Ok(value) => Some(value),
        Err(error) => {
            crate::log::vidcord_log(&format!(
                "Settings: could not serialize loaded settings: {error}"
            ));
            None
        }
    }
}

/// Element-wise salvage for one collection field: keep the elements that
/// parse as the element type and report how many were dropped, so one
/// malformed record cannot discard the whole collection.
fn salvage_collection<T: serde::de::DeserializeOwned>(
    value: &serde_json::Value,
) -> Option<(serde_json::Value, usize)> {
    let array = value.as_array()?;
    let mut kept = Vec::new();
    let mut dropped = 0usize;
    for element in array {
        if serde_json::from_value::<T>(element.clone()).is_ok() {
            kept.push(element.clone());
        } else {
            dropped += 1;
        }
    }
    if kept.is_empty() && dropped > 0 {
        return None;
    }
    Some((serde_json::Value::Array(kept), dropped))
}

/// Fallback for a settings file whose JSON is valid but where one or more
/// fields have the wrong type: keep every field that parses on its own and
/// report the names (never the contents) of the ones dropped.
fn salvage_settings(raw: &serde_json::Value) -> Option<(Settings, Vec<String>)> {
    let object = raw.as_object()?;
    let mut kept = serde_json::Map::new();
    let mut dropped = Vec::new();
    for (key, value) in object {
        let mut trial = serde_json::Map::new();
        trial.insert(key.clone(), value.clone());
        if serde_json::from_value::<Settings>(serde_json::Value::Object(trial)).is_ok() {
            kept.insert(key.clone(), value.clone());
            continue;
        }
        // The whole-field trial failed; for the two collection fields,
        // retry per element before giving up on the field entirely.
        let salvaged = match key.as_str() {
            "presets" => salvage_collection::<PersistedSettingsPreset>(value),
            "encoder_capabilities" => salvage_collection::<PersistedEncoder>(value),
            _ => None,
        };
        match salvaged {
            Some((filtered, dropped_count)) => {
                kept.insert(key.clone(), filtered);
                if dropped_count > 0 {
                    dropped.push(format!("{key} ({dropped_count} invalid record(s))"));
                }
            }
            None => dropped.push(key.clone()),
        }
    }
    let typed = serde_json::from_value::<Settings>(serde_json::Value::Object(kept)).ok()?;
    Some((typed, dropped))
}

fn backup_unparseable_settings(path: &Path) {
    let mut backup_name = path.as_os_str().to_owned();
    backup_name.push(".bak");
    let backup = PathBuf::from(backup_name);
    if let Err(error) = std::fs::copy(path, &backup) {
        crate::log::vidcord_log(&format!(
            "Settings: could not back up the unparseable settings file: {error}"
        ));
    }
}

fn load_settings_value(path: &Path) -> serde_json::Value {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return serde_json::json!({});
        }
        Err(error) => {
            crate::log::vidcord_log(&format!(
                "Settings: could not read the settings file: {error}"
            ));
            return serde_json::json!({});
        }
    };
    // Deserialize through the typed struct to silently drop unknown keys, then
    // re-serialize to plain JSON for the frontend.
    let parse_error = match serde_json::from_str::<Settings>(&content) {
        Ok(typed) => return typed_to_value(typed).unwrap_or_else(|| serde_json::json!({})),
        Err(error) => error,
    };
    if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&content) {
        if let Some((typed, dropped)) = salvage_settings(&raw) {
            if !dropped.is_empty() {
                crate::log::vidcord_log(&format!(
                    "Settings: dropped invalid settings field(s): {}",
                    dropped.join(", ")
                ));
            }
            return typed_to_value(typed).unwrap_or_else(|| serde_json::json!({}));
        }
    }
    // The file cannot be recovered field-by-field. Log the reason (never the
    // contents) and keep a backup copy before a later save overwrites it.
    crate::log::vidcord_log(&format!(
        "Settings: could not parse the settings file ({parse_error}); using defaults"
    ));
    backup_unparseable_settings(path);
    serde_json::json!({})
}

impl SettingsManager {
    pub fn load() -> serde_json::Value {
        load_settings_value(settings_path())
    }

    pub fn save(data: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
        // Normalize (full-payload clone + typed round-trip) before taking
        // the lock: the global write lock only needs to cover the atomic
        // write itself, not the serialization work ahead of it.
        let normalized = normalize_for_save(data)?;
        let _write_guard = SETTINGS_WRITE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let path = settings_path();
        write_atomically(
            &normalized,
            path,
            &format!("settings_{}.tmp", std::process::id()),
        )
    }

    /// Save to an explicit path (used in tests to avoid touching the real settings file).
    #[cfg(test)]
    pub fn save_to(
        data: &serde_json::Value,
        path: &std::path::Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let normalized = normalize_for_save(data)?;
        write_atomically(
            &normalized,
            path,
            &format!("settings_test_{}.tmp", std::process::id()),
        )
    }

    /// Load from an explicit path (used in tests).
    #[cfg(test)]
    pub fn load_from(path: &std::path::Path) -> serde_json::Value {
        load_settings_value(path)
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
            "gif_target_mb": 10,
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
        assert_eq!(loaded["gif_target_mb"], 10);
        assert!(loaded.get("gif_quality_index").is_none());
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
    fn legacy_gif_index_is_capped_to_the_new_largest_target() {
        let dir =
            std::env::temp_dir().join(format!("vidcord_test_gif_migration_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        SettingsManager::save_to(&serde_json::json!({ "gif_quality_index": 1 }), &path).unwrap();
        let loaded = SettingsManager::load_from(&path);

        assert_eq!(loaded["gif_target_mb"], 20);
        assert!(loaded.get("gif_quality_index").is_none());

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
        // The unparseable file is preserved for recovery before any later save.
        let backup = dir.join("settings.json.bak");
        assert_eq!(
            std::fs::read(&backup).unwrap(),
            b"not valid json {{{".to_vec()
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_settings_load_salvages_valid_fields_around_one_bad_field() {
        let dir = std::env::temp_dir().join(format!("vidcord_test_salvage_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            br#"{"quality_index": "not-a-number", "gif_mode": true, "encoder_index": 3}"#,
        )
        .unwrap();

        let loaded = SettingsManager::load_from(&path);
        assert_eq!(loaded["gif_mode"], true);
        assert_eq!(loaded["encoder_index"], 3);
        assert!(loaded.get("quality_index").is_none());
        // Field-level salvage recovers the file, so no backup is needed.
        assert!(!dir.join("settings.json.bak").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_settings_load_salvages_valid_collection_elements() {
        let dir = std::env::temp_dir().join(format!(
            "vidcord_test_salvage_collection_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            br#"{
                "presets": [
                    {"id": "a", "name": "Good", "settings": {"quality_index": 1}},
                    {"id": "b", "name": 42, "settings": {}},
                    {"id": "c", "name": "Also good", "settings": {}}
                ],
                "encoder_capabilities": [
                    {"name": "libx264", "label": "CPU"},
                    {"name": 7, "label": "broken"},
                    {"name": "h264_nvenc", "label": "NVENC"}
                ],
                "gif_mode": true
            }"#,
        )
        .unwrap();

        let loaded = SettingsManager::load_from(&path);
        assert_eq!(loaded["gif_mode"], true);
        let presets = loaded["presets"].as_array().expect("presets salvaged");
        assert_eq!(presets.len(), 2);
        assert_eq!(presets[0]["id"], "a");
        assert_eq!(presets[1]["id"], "c");
        let encoders = loaded["encoder_capabilities"]
            .as_array()
            .expect("encoder capabilities salvaged");
        assert_eq!(encoders.len(), 2);
        assert_eq!(encoders[0]["name"], "libx264");
        assert_eq!(encoders[1]["name"], "h264_nvenc");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_settings_save_round_trips_through_the_typed_struct() {
        let dir =
            std::env::temp_dir().join(format!("vidcord_test_save_typed_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        // A genuine type mismatch is rejected instead of persisted.
        assert!(SettingsManager::save_to(
            &serde_json::json!({ "quality_index": "not-a-number" }),
            &path
        )
        .is_err());
        assert!(!path.exists());

        // Unknown keys are dropped on save, matching load-time semantics.
        SettingsManager::save_to(
            &serde_json::json!({ "quality_index": 2, "removed_legacy_key": true }),
            &path,
        )
        .unwrap();
        let stored = std::fs::read_to_string(&path).unwrap();
        assert!(!stored.contains("removed_legacy_key"));
        assert_eq!(SettingsManager::load_from(&path)["quality_index"], 2);

        std::fs::remove_dir_all(&dir).ok();
    }
}
