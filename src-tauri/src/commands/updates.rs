use crate::log::vidcord_log;
use ring::signature::{UnparsedPublicKey, ED25519};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tokio::io::AsyncWriteExt;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static DOWNLOAD_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static TEMP_DOWNLOAD_COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_UPDATE_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UPDATE_SIGNATURE_BYTES: usize = 64;
const MAX_DOWNLOAD_NAME_COLLISIONS: usize = 10_000;
const UPDATE_SIGNATURE_CONTEXT: &str = "vidcord-update-signature-v1";
const UPDATE_SIGNING_PUBLIC_KEY_HEX: &str = include_str!("../../update-signing-public-key.hex");

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
    size: Option<u64>,
    digest: Option<String>,
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
    release_tag: String,
    download_url: String,
    signature_url: String,
    size: Option<u64>,
    sha256: [u8; 32],
}

fn decode_hex(input: &str, expected_bytes: usize, error: &str) -> Result<Vec<u8>, String> {
    let input = input.trim();
    if input.len() != expected_bytes * 2 || !input.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(error.to_string());
    }

    input
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|value| u8::from_str_radix(value, 16).ok())
                .ok_or_else(|| error.to_string())
        })
        .collect()
}

fn parse_sha256_digest(digest: Option<&str>) -> Result<[u8; 32], String> {
    let digest = digest
        .and_then(|value| value.strip_prefix("sha256:"))
        .ok_or_else(|| "Update installer is missing a valid SHA-256 digest.".to_string())?;
    decode_hex(
        digest,
        32,
        "Update installer is missing a valid SHA-256 digest.",
    )?
    .try_into()
    .map_err(|_| "Update installer is missing a valid SHA-256 digest.".to_string())
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

fn release_tag(release: &GitHubRelease) -> Result<&str, String> {
    let tag = release
        .tag_name
        .as_deref()
        .ok_or_else(|| "Update release is missing a valid tag.".to_string())?;
    let version = tag.strip_prefix('v').unwrap_or(tag);
    if tag.is_empty()
        || version.is_empty()
        || !tag.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-' || byte == b'_'
        })
        || semver::Version::parse(&normalize_semver(tag)).is_err()
    {
        return Err("Update release is missing a valid tag.".to_string());
    }
    Ok(tag)
}

fn canonical_release_asset_url(tag: &str, name: &str) -> Result<String, String> {
    safe_asset_filename(name)?;
    Ok(format!(
        "https://github.com/cyroz1/vidcord/releases/download/{tag}/{name}"
    ))
}

fn select_platform_asset(release: &GitHubRelease) -> Result<SelectedAsset, String> {
    let suffixes = platform_asset_suffixes()?;
    let release_tag = release_tag(release)?.to_string();
    let asset = release
        .assets
        .iter()
        .find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.starts_with("vidcord_")
                && suffixes
                    .iter()
                    .any(|suffix| name.ends_with(&suffix.to_ascii_lowercase()))
        })
        .ok_or_else(|| "No update installer was found for this platform.".to_string())?;
    let name = safe_asset_filename(&asset.name)?.to_string();
    let signature_name = format!("{name}.sig");
    if !release
        .assets
        .iter()
        .any(|candidate| candidate.name == signature_name)
    {
        return Err("Update installer is missing an independent release signature.".to_string());
    }

    Ok(SelectedAsset {
        download_url: canonical_release_asset_url(&release_tag, &name)?,
        signature_url: canonical_release_asset_url(&release_tag, &signature_name)?,
        name,
        release_tag,
        size: asset.size,
        sha256: parse_sha256_digest(asset.digest.as_deref())?,
    })
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
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
    {
        Err("Release asset has an invalid filename.".to_string())
    } else {
        Ok(name)
    }
}

fn sha256_hex(digest: &[u8; 32]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn release_signature_message(release_tag: &str, asset_name: &str, sha256: &[u8; 32]) -> Vec<u8> {
    format!(
        "{UPDATE_SIGNATURE_CONTEXT}\n{release_tag}\n{asset_name}\n{}\n",
        sha256_hex(sha256)
    )
    .into_bytes()
}

fn verify_release_signature(message: &[u8], signature: &[u8]) -> Result<(), String> {
    if signature.len() != MAX_UPDATE_SIGNATURE_BYTES {
        return Err("Update installer has an invalid release signature.".to_string());
    }
    let public_key = decode_hex(
        UPDATE_SIGNING_PUBLIC_KEY_HEX,
        32,
        "vidcord has an invalid update signing key.",
    )?;
    UnparsedPublicKey::new(&ED25519, public_key)
        .verify(message, signature)
        .map_err(|_| {
            "Update installer failed its independent release-signature verification.".to_string()
        })
}

fn download_target_path(asset_name: &str) -> Result<PathBuf, String> {
    let file_name = safe_asset_filename(asset_name)?;
    let dir = dirs::download_dir()
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(std::env::temp_dir);
    Ok(dir.join(file_name))
}

fn validate_download_size(size: u64) -> Result<(), String> {
    if size > MAX_UPDATE_INSTALLER_BYTES {
        Err(format!(
            "Update installer is too large ({size} bytes; limit is {MAX_UPDATE_INSTALLER_BYTES})."
        ))
    } else {
        Ok(())
    }
}

fn temp_download_path(path: &Path) -> Result<PathBuf, String> {
    let dir = path
        .parent()
        .ok_or_else(|| "Update download path has no parent directory.".to_string())?;
    Ok(dir.join(format!(
        ".{}.{}.{}.download",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("vidcord-update"),
        std::process::id(),
        TEMP_DOWNLOAD_COUNTER.fetch_add(1, Ordering::Relaxed),
    )))
}

async fn create_temp_download_file(path: &Path) -> Result<(PathBuf, tokio::fs::File), String> {
    for _ in 0..64 {
        let tmp = temp_download_path(path)?;
        match tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)
            .await
        {
            Ok(file) => return Ok((tmp, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not allocate a temporary update download file.".to_string())
}

fn collision_safe_download_path(path: &Path, collision_index: usize) -> Result<PathBuf, String> {
    if collision_index == 0 {
        return Ok(path.to_path_buf());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Update download path has no parent directory.".to_string())?;
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| "Update download path has an invalid filename.".to_string())?;
    let extension = path.extension().and_then(|extension| extension.to_str());
    let file_name = match extension {
        Some(extension) => format!("{stem} ({collision_index}).{extension}"),
        None => format!("{stem} ({collision_index})"),
    };
    Ok(parent.join(file_name))
}

async fn publish_download_without_clobber(
    tmp: &Path,
    preferred_path: &Path,
) -> Result<PathBuf, String> {
    // `rename` overwrites an existing destination on Unix. Creating a hard
    // link instead gives us the same atomic visibility while also providing
    // create-new semantics on every supported platform. The temporary file is
    // in the destination directory, so the link stays on the same filesystem.
    for collision_index in 0..MAX_DOWNLOAD_NAME_COLLISIONS {
        let candidate = collision_safe_download_path(preferred_path, collision_index)?;
        match tokio::fs::hard_link(tmp, &candidate).await {
            Ok(()) => {
                if let Err(error) = tokio::fs::remove_file(tmp).await {
                    vidcord_log(&format!(
                        "update install: could not remove completed temporary download: {error}"
                    ));
                }
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(link_error) => {
                // FAT/exFAT and some SMB mounts do not support hard links. A
                // create-new copy is not atomically visible, but it preserves
                // the critical no-clobber guarantee and keeps updates working
                // on those common Downloads filesystems.
                vidcord_log(&format!(
                    "update install: hard-link publish unavailable ({link_error}); using create-new copy"
                ));
                match copy_download_without_clobber(tmp, &candidate).await {
                    Ok(()) => {
                        if let Err(error) = tokio::fs::remove_file(tmp).await {
                            vidcord_log(&format!(
                                "update install: could not remove completed temporary download: {error}"
                            ));
                        }
                        return Ok(candidate);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
    }

    Err("Could not choose an unused update installer filename.".to_string())
}

async fn copy_download_without_clobber(source: &Path, destination: &Path) -> std::io::Result<()> {
    let mut source_file = tokio::fs::File::open(source).await?;
    let mut destination_file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .await?;

    let copy_result = async {
        tokio::io::copy(&mut source_file, &mut destination_file).await?;
        destination_file.flush().await?;
        destination_file.sync_all().await
    }
    .await;

    if copy_result.is_err() {
        drop(destination_file);
        let _ = tokio::fs::remove_file(destination).await;
    }
    copy_result
}

async fn download_release_signature(url: &str) -> Result<[u8; 64], String> {
    let resp = download_client()
        .get(url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| {
            let msg = e.to_string();
            vidcord_log(&format!("update install: signature request failed: {msg}"));
            msg
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        vidcord_log(&format!("update install: signature HTTP {status}"));
        return Err("Update installer signature could not be downloaded.".to_string());
    }
    if resp
        .content_length()
        .is_some_and(|length| length > MAX_UPDATE_SIGNATURE_BYTES as u64)
    {
        return Err("Update installer signature is too large.".to_string());
    }

    let mut signature = Vec::with_capacity(MAX_UPDATE_SIGNATURE_BYTES);
    let mut resp = resp;
    loop {
        let chunk = resp.chunk().await.map_err(|e| e.to_string())?;
        let Some(chunk) = chunk else { break };
        let Some(next_length) = signature.len().checked_add(chunk.len()) else {
            return Err("Update installer signature size overflowed.".to_string());
        };
        if next_length > MAX_UPDATE_SIGNATURE_BYTES {
            return Err("Update installer signature is too large.".to_string());
        }
        signature.extend_from_slice(&chunk);
    }

    signature
        .try_into()
        .map_err(|_| "Update installer has an invalid release signature.".to_string())
}

async fn write_download_stream(
    path: PathBuf,
    mut resp: reqwest::Response,
    asset: &SelectedAsset,
    signature: &[u8],
) -> Result<PathBuf, String> {
    let content_length = resp.content_length();
    if let Some(content_length) = content_length {
        validate_download_size(content_length)?;
    }

    let (tmp, mut file) = create_temp_download_file(&path).await?;
    let mut written = 0u64;
    let mut hasher = Sha256::new();

    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(err) => {
                let msg = err.to_string();
                vidcord_log(&format!("update install: download read failed: {msg}"));
                drop(file);
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(msg);
            }
        };
        let Some(next_written) = written.checked_add(chunk.len() as u64) else {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err("Update installer size overflowed.".to_string());
        };
        written = next_written;
        if let Err(err) = validate_download_size(written) {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(err);
        }
        if let Err(err) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(err.to_string());
        }
        hasher.update(&chunk);
    }

    if let Err(err) = file.flush().await {
        drop(file);
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(err.to_string());
    }
    drop(file);

    finish_verified_download(
        &tmp,
        &path,
        content_length,
        written,
        asset,
        hasher.finalize().into(),
        signature,
    )
    .await
}

async fn finish_verified_download(
    tmp: &Path,
    path: &Path,
    content_length: Option<u64>,
    written: u64,
    asset: &SelectedAsset,
    actual_sha256: [u8; 32],
    signature: &[u8],
) -> Result<PathBuf, String> {
    if content_length.is_some_and(|expected| expected != written) {
        let _ = tokio::fs::remove_file(tmp).await;
        return Err("Update installer download was incomplete.".to_string());
    }
    if actual_sha256 != asset.sha256 {
        let _ = tokio::fs::remove_file(tmp).await;
        return Err("Update installer failed its SHA-256 integrity check.".to_string());
    }
    let message = release_signature_message(&asset.release_tag, &asset.name, &actual_sha256);
    if let Err(error) = verify_release_signature(&message, signature) {
        let _ = tokio::fs::remove_file(tmp).await;
        return Err(error);
    }

    let published_path = match publish_download_without_clobber(tmp, path).await {
        Ok(published_path) => published_path,
        Err(err) => {
            let _ = tokio::fs::remove_file(tmp).await;
            return Err(err);
        }
    };
    Ok(published_path)
}

fn open_installer(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(path)
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
    let signature = download_release_signature(&asset.signature_url).await?;
    if let Some(size) = asset.size {
        validate_download_size(size)?;
    }
    let target_path = download_target_path(&asset.name)?;
    let target_dir = target_path
        .parent()
        .ok_or_else(|| "Update download path has no parent directory.".to_string())?;
    tokio::fs::create_dir_all(target_dir)
        .await
        .map_err(|e| e.to_string())?;

    let resp = download_client()
        .get(&asset.download_url)
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

    let downloaded_path = write_download_stream(target_path, resp, &asset, &signature).await?;
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

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_test_directory() -> PathBuf {
        std::env::temp_dir().join(format!(
            "vidcord-update-test-{}-{}",
            std::process::id(),
            TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed)
        ))
    }

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
        let installer_name = format!("vidcord_9.0.0{suffix}");
        let release = GitHubRelease {
            tag_name: Some("v9.0".to_string()),
            name: None,
            html_url: None,
            assets: vec![
                ReleaseAsset {
                    name: "vidcord_9.0.0_unrelated.zip".to_string(),
                    size: Some(1024),
                    digest: Some(format!("sha256:{}", "00".repeat(32))),
                },
                ReleaseAsset {
                    name: installer_name.clone(),
                    size: Some(2048),
                    digest: Some(format!("sha256:{}", "11".repeat(32))),
                },
                ReleaseAsset {
                    name: format!("{installer_name}.sig"),
                    size: Some(MAX_UPDATE_SIGNATURE_BYTES as u64),
                    digest: None,
                },
            ],
        };

        let asset = select_platform_asset(&release).unwrap();
        assert_eq!(
            asset.download_url,
            format!("https://github.com/cyroz1/vidcord/releases/download/v9.0/{installer_name}")
        );
        assert_eq!(
            asset.signature_url,
            format!(
                "https://github.com/cyroz1/vidcord/releases/download/v9.0/{installer_name}.sig"
            )
        );
        assert_eq!(asset.sha256, [0x11; 32]);
    }

    #[test]
    fn rejects_unsigned_platform_assets() {
        let suffix = platform_asset_suffixes().unwrap()[0];
        let release = GitHubRelease {
            tag_name: Some("v9.0".to_string()),
            name: None,
            html_url: None,
            assets: vec![ReleaseAsset {
                name: format!("vidcord_9.0.0{suffix}"),
                size: Some(2048),
                digest: Some(format!("sha256:{}", "11".repeat(32))),
            }],
        };

        assert_eq!(
            select_platform_asset(&release).unwrap_err(),
            "Update installer is missing an independent release signature."
        );
    }

    #[test]
    fn rejects_assets_without_a_valid_sha256_digest() {
        assert!(parse_sha256_digest(None).is_err());
        assert!(parse_sha256_digest(Some("sha512:00")).is_err());
        assert!(parse_sha256_digest(Some("sha256:not-hex")).is_err());
        assert!(parse_sha256_digest(Some(&format!("sha256:{}", "00".repeat(31)))).is_err());
        assert_eq!(
            parse_sha256_digest(Some(&format!("sha256:{}", "aB".repeat(32)))).unwrap(),
            [0xab; 32]
        );
        let actual: [u8; 32] = Sha256::digest(b"abc").into();
        assert_eq!(
            parse_sha256_digest(Some(
                "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            ))
            .unwrap(),
            actual
        );
    }

    #[test]
    fn rejects_unsafe_asset_filenames() {
        assert!(safe_asset_filename("vidcord_9.0.0.dmg").is_ok());
        assert!(safe_asset_filename("../vidcord.dmg").is_err());
        assert!(safe_asset_filename("nested/vidcord.dmg").is_err());
        assert!(safe_asset_filename("vidcord_9.0.0&calc.exe").is_err());
        assert!(safe_asset_filename("vidcord 9.0.0.dmg").is_err());
        assert!(safe_asset_filename("").is_err());
    }

    #[test]
    fn rejects_oversized_update_installers() {
        assert!(validate_download_size(MAX_UPDATE_INSTALLER_BYTES).is_ok());
        assert!(validate_download_size(MAX_UPDATE_INSTALLER_BYTES + 1).is_err());
    }

    #[test]
    fn collision_names_preserve_the_installer_extension() {
        let path = PathBuf::from("vidcord_7.0.0_x64-setup.exe");
        assert_eq!(
            collision_safe_download_path(&path, 1).unwrap(),
            PathBuf::from("vidcord_7.0.0_x64-setup (1).exe")
        );
        assert_eq!(collision_safe_download_path(&path, 0).unwrap(), path);
    }

    fn release_signature_fixture() -> [u8; MAX_UPDATE_SIGNATURE_BYTES] {
        [
            98, 32, 169, 93, 102, 240, 194, 161, 1, 0, 149, 139, 248, 233, 2, 2, 38, 33, 74, 98,
            68, 26, 70, 249, 97, 22, 128, 250, 215, 171, 140, 40, 11, 195, 79, 13, 100, 10, 11,
            249, 222, 163, 21, 21, 66, 197, 73, 70, 6, 140, 90, 45, 121, 87, 160, 224, 178, 123,
            208, 95, 176, 184, 65, 6,
        ]
    }

    fn test_selected_asset(expected_sha256: [u8; 32]) -> SelectedAsset {
        SelectedAsset {
            name: "vidcord_7.3.0_x64-setup.exe".to_string(),
            release_tag: "v7.3.0".to_string(),
            download_url: String::new(),
            signature_url: String::new(),
            size: Some(18),
            sha256: expected_sha256,
        }
    }

    #[test]
    fn release_signature_binds_release_context_and_digest() {
        let message =
            release_signature_message("v7.3.0", "vidcord_7.3.0_x64-setup.exe", &[0x33; 32]);
        verify_release_signature(&message, &release_signature_fixture()).unwrap();

        let mut altered_message = message;
        altered_message[0] ^= 1;
        assert!(verify_release_signature(&altered_message, &release_signature_fixture()).is_err());
    }

    #[tokio::test]
    async fn invalid_release_signature_removes_temp_file_without_publishing() {
        let directory = unique_test_directory();
        tokio::fs::create_dir(&directory).await.unwrap();
        let preferred = directory.join("vidcord.exe");
        let tmp = directory.join(".vidcord.download");
        tokio::fs::write(&tmp, b"verified installer").await.unwrap();
        let asset = test_selected_asset([0x33; 32]);

        let error = finish_verified_download(
            &tmp,
            &preferred,
            Some(18),
            18,
            &asset,
            [0x33; 32],
            &[0; MAX_UPDATE_SIGNATURE_BYTES],
        )
        .await
        .unwrap_err();

        assert_eq!(
            error,
            "Update installer failed its independent release-signature verification."
        );
        assert!(!tmp.exists());
        assert!(!preferred.exists());
        tokio::fs::remove_dir(directory).await.unwrap();
    }

    #[tokio::test]
    async fn publishing_update_never_replaces_existing_downloads() {
        let directory = unique_test_directory();
        tokio::fs::create_dir(&directory).await.unwrap();
        let preferred = directory.join("vidcord.exe");
        let first_collision = directory.join("vidcord (1).exe");
        let tmp = directory.join(".vidcord.download");
        tokio::fs::write(&preferred, b"original").await.unwrap();
        tokio::fs::write(&first_collision, b"also original")
            .await
            .unwrap();
        tokio::fs::write(&tmp, b"new installer").await.unwrap();

        let published = publish_download_without_clobber(&tmp, &preferred)
            .await
            .unwrap();

        assert_eq!(published, directory.join("vidcord (2).exe"));
        assert_eq!(tokio::fs::read(&preferred).await.unwrap(), b"original");
        assert_eq!(
            tokio::fs::read(&first_collision).await.unwrap(),
            b"also original"
        );
        assert_eq!(tokio::fs::read(&published).await.unwrap(), b"new installer");
        assert!(!tmp.exists());

        tokio::fs::remove_file(preferred).await.unwrap();
        tokio::fs::remove_file(first_collision).await.unwrap();
        tokio::fs::remove_file(published).await.unwrap();
        tokio::fs::remove_dir(directory).await.unwrap();
    }

    #[tokio::test]
    async fn digest_mismatch_removes_temp_file_without_publishing() {
        let directory = unique_test_directory();
        tokio::fs::create_dir(&directory).await.unwrap();
        let preferred = directory.join("vidcord.exe");
        let tmp = directory.join(".vidcord.download");
        tokio::fs::write(&tmp, b"tampered installer").await.unwrap();
        let asset = test_selected_asset([0x11; 32]);

        let error = finish_verified_download(
            &tmp,
            &preferred,
            Some(18),
            18,
            &asset,
            [0x22; 32],
            &[0; MAX_UPDATE_SIGNATURE_BYTES],
        )
        .await
        .unwrap_err();

        assert_eq!(
            error,
            "Update installer failed its SHA-256 integrity check."
        );
        assert!(!tmp.exists());
        assert!(!preferred.exists());
        tokio::fs::remove_dir(directory).await.unwrap();
    }

    #[tokio::test]
    async fn matching_digest_allows_publication() {
        let directory = unique_test_directory();
        tokio::fs::create_dir(&directory).await.unwrap();
        let preferred = directory.join("vidcord.exe");
        let tmp = directory.join(".vidcord.download");
        tokio::fs::write(&tmp, b"verified installer").await.unwrap();
        let asset = test_selected_asset([0x33; 32]);
        let signature = release_signature_fixture();

        let published = finish_verified_download(
            &tmp,
            &preferred,
            Some(18),
            18,
            &asset,
            [0x33; 32],
            &signature,
        )
        .await
        .unwrap();

        assert_eq!(published, preferred);
        assert_eq!(
            tokio::fs::read(&published).await.unwrap(),
            b"verified installer"
        );
        assert!(!tmp.exists());
        tokio::fs::remove_file(published).await.unwrap();
        tokio::fs::remove_dir(directory).await.unwrap();
    }

    #[tokio::test]
    async fn copy_fallback_uses_create_new_and_preserves_existing_file() {
        let directory = unique_test_directory();
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let tmp = directory.join(".vidcord.download");
        let destination = directory.join("vidcord.exe");
        tokio::fs::write(&tmp, b"new installer").await.unwrap();
        tokio::fs::write(&destination, b"original").await.unwrap();

        let error = copy_download_without_clobber(&tmp, &destination)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"original");

        let collision = directory.join("vidcord (1).exe");
        copy_download_without_clobber(&tmp, &collision)
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(&collision).await.unwrap(), b"new installer");

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}
