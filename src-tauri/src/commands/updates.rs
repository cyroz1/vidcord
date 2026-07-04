use crate::log::vidcord_log;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static DOWNLOAD_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(6))
            .user_agent(concat!("vidcord-update-check/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("failed to build HTTP client")
    })
}

fn download_client() -> &'static reqwest::Client {
    DOWNLOAD_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10 * 60))
            .user_agent(concat!(
                "vidcord-update-install/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .expect("failed to build download HTTP client")
    })
}

fn normalize_semver(input: &str) -> String {
    let trimmed = input.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.').collect::<Vec<_>>();
    while parts.len() < 3 {
        parts.push("0");
    }
    parts.into_iter().take(3).collect::<Vec<_>>().join(".")
}

#[derive(Clone, Debug, serde::Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
struct GitHubRelease {
    tag_name: Option<String>,
    name: Option<String>,
    html_url: Option<String>,
    assets: Vec<ReleaseAsset>,
}

#[derive(Clone, Debug)]
struct SelectedAsset {
    name: String,
    browser_download_url: String,
}

fn platform_asset_suffixes() -> Result<&'static [&'static str], String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok(&["_x64-setup.exe"]),
        ("windows", "aarch64") => Ok(&["_arm64-setup.exe"]),
        ("macos", _) => Ok(&["_universal.dmg"]),
        ("linux", "x86_64") => Ok(&["_amd64.AppImage"]),
        ("linux", "aarch64") => Ok(&["_aarch64.AppImage"]),
        (os, arch) => Err(format!("No update installer is available for {os}/{arch}.")),
    }
}

fn select_platform_asset(release: &GitHubRelease) -> Result<SelectedAsset, String> {
    let suffixes = platform_asset_suffixes()?;
    release
        .assets
        .iter()
        .find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.starts_with("vidcord_")
                && suffixes
                    .iter()
                    .any(|suffix| name.ends_with(&suffix.to_ascii_lowercase()))
        })
        .map(|asset| SelectedAsset {
            name: asset.name.clone(),
            browser_download_url: asset.browser_download_url.clone(),
        })
        .ok_or_else(|| "No update installer was found for this platform.".to_string())
}

async fn fetch_latest_release() -> Result<GitHubRelease, String> {
    let resp = http_client()
        .get("https://api.github.com/repos/cyroz1/vidcord/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| {
            let msg = e.to_string();
            vidcord_log(&format!("update check: request failed: {msg}"));
            msg
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        vidcord_log(&format!("update check: HTTP {status}"));
        return Err(format!("HTTP {status}"));
    }

    resp.json::<GitHubRelease>().await.map_err(|e| {
        let msg = e.to_string();
        vidcord_log(&format!("update check: response parse failed: {msg}"));
        msg
    })
}

fn safe_asset_filename(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains(std::path::MAIN_SEPARATOR)
    {
        Err("Release asset has an invalid filename.".to_string())
    } else {
        Ok(name)
    }
}

fn download_target_path(asset_name: &str) -> Result<PathBuf, String> {
    let file_name = safe_asset_filename(asset_name)?;
    let dir = dirs::download_dir()
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("vidcord-updates");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(file_name))
}

fn write_download(path: PathBuf, bytes: Vec<u8>) -> Result<PathBuf, String> {
    let dir = path
        .parent()
        .ok_or_else(|| "Update download path has no parent directory.".to_string())?;
    let tmp = dir.join(format!(
        ".{}.{}.download",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("vidcord-update"),
        std::process::id()
    ));
    {
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
    }
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn open_installer(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(path)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.extension().and_then(|ext| ext.to_str()) == Some("AppImage") {
            let mut perms = std::fs::metadata(path)
                .map_err(|e| e.to_string())?
                .permissions();
            perms.set_mode(perms.mode() | 0o755);
            std::fs::set_permissions(path, perms).map_err(|e| e.to_string())?;
        }
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn check_for_updates(current_version: String) -> Result<serde_json::Value, String> {
    let release = fetch_latest_release().await?;
    let tag = release
        .tag_name
        .as_deref()
        .or(release.name.as_deref())
        .ok_or_else(|| {
            vidcord_log("update check: response missing tag_name/name");
            "Missing tag_name".to_string()
        })?;
    let release_url = release
        .html_url
        .as_deref()
        .unwrap_or("https://github.com/cyroz1/vidcord/releases/latest");

    let cur = semver::Version::parse(&normalize_semver(&current_version)).map_err(|e| {
        let msg = e.to_string();
        vidcord_log(&format!(
            "update check: failed to parse current version {current_version:?}: {msg}"
        ));
        msg
    })?;
    let latest = semver::Version::parse(&normalize_semver(tag)).map_err(|e| {
        let msg = e.to_string();
        vidcord_log(&format!(
            "update check: failed to parse latest tag {tag:?}: {msg}"
        ));
        msg
    })?;

    if latest > cur {
        let installer_asset = select_platform_asset(&release).ok();
        Ok(serde_json::json!({
            "update_available": true,
            "latest_version": tag,
            "release_url": release_url,
            "installer_available": installer_asset.is_some(),
            "installer_name": installer_asset.map(|asset| asset.name)
        }))
    } else {
        Ok(serde_json::json!({"update_available": false}))
    }
}

#[tauri::command]
pub async fn download_and_open_update_installer() -> Result<serde_json::Value, String> {
    let release = fetch_latest_release().await?;
    let asset = select_platform_asset(&release)?;
    let target_path = download_target_path(&asset.name)?;

    let resp = download_client()
        .get(&asset.browser_download_url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| {
            let msg = e.to_string();
            vidcord_log(&format!("update install: download request failed: {msg}"));
            msg
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        vidcord_log(&format!("update install: download HTTP {status}"));
        return Err(format!("Download failed with HTTP {status}"));
    }

    let bytes = resp.bytes().await.map_err(|e| {
        let msg = e.to_string();
        vidcord_log(&format!("update install: download read failed: {msg}"));
        msg
    })?;
    let bytes = bytes.to_vec();

    let path_for_write = target_path.clone();
    let downloaded_path =
        tokio::task::spawn_blocking(move || write_download(path_for_write, bytes))
            .await
            .map_err(|e| e.to_string())??;
    let path_for_open = downloaded_path.clone();
    tokio::task::spawn_blocking(move || open_installer(&path_for_open))
        .await
        .map_err(|e| e.to_string())??;

    Ok(serde_json::json!({
        "path": downloaded_path.to_string_lossy(),
        "installer_name": asset.name
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_semver_strips_v_prefix() {
        assert_eq!(normalize_semver("v1.2.3"), "1.2.3");
        assert_eq!(normalize_semver("1.2.3"), "1.2.3");
    }

    #[test]
    fn normalize_semver_pads_short_versions() {
        assert_eq!(normalize_semver("v1"), "1.0.0");
        assert_eq!(normalize_semver("1.2"), "1.2.0");
    }

    #[test]
    fn normalize_semver_truncates_extra_segments() {
        assert_eq!(normalize_semver("1.2.3.4"), "1.2.3");
    }

    #[test]
    fn normalize_semver_trims_whitespace() {
        assert_eq!(normalize_semver("  v1.2.3  "), "1.2.3");
    }

    #[test]
    fn semver_compare_detects_update() {
        let cur = semver::Version::parse(&normalize_semver("v6.1.0")).unwrap();
        let latest = semver::Version::parse(&normalize_semver("v6.2.0")).unwrap();
        assert!(latest > cur);
    }

    #[test]
    fn semver_compare_equal_no_update() {
        let cur = semver::Version::parse(&normalize_semver("6.2.0")).unwrap();
        let latest = semver::Version::parse(&normalize_semver("v6.2.0")).unwrap();
        assert!(latest <= cur);
    }

    #[test]
    fn semver_compare_older_no_update() {
        let cur = semver::Version::parse(&normalize_semver("6.3.0")).unwrap();
        let latest = semver::Version::parse(&normalize_semver("v6.2.5")).unwrap();
        assert!(latest <= cur);
    }

    #[test]
    fn semver_compare_short_form() {
        let cur = semver::Version::parse(&normalize_semver("6.1")).unwrap();
        let latest = semver::Version::parse(&normalize_semver("v6.2")).unwrap();
        assert!(latest > cur);
    }

    #[test]
    fn selects_current_platform_asset() {
        let suffix = platform_asset_suffixes().unwrap()[0];
        let release = GitHubRelease {
            tag_name: Some("v9.0".to_string()),
            name: None,
            html_url: None,
            assets: vec![
                ReleaseAsset {
                    name: "vidcord_9.0.0_unrelated.zip".to_string(),
                    browser_download_url: "https://example.com/wrong".to_string(),
                },
                ReleaseAsset {
                    name: format!("vidcord_9.0.0{suffix}"),
                    browser_download_url: "https://example.com/right".to_string(),
                },
            ],
        };

        let asset = select_platform_asset(&release).unwrap();
        assert_eq!(asset.browser_download_url, "https://example.com/right");
    }

    #[test]
    fn rejects_unsafe_asset_filenames() {
        assert!(safe_asset_filename("vidcord_9.0.0.dmg").is_ok());
        assert!(safe_asset_filename("../vidcord.dmg").is_err());
        assert!(safe_asset_filename("nested/vidcord.dmg").is_err());
        assert!(safe_asset_filename("").is_err());
    }
}
