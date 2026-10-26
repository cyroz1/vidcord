use crate::log::vidcord_log;
use ring::signature::{UnparsedPublicKey, ED25519};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static HTTP_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
static DOWNLOAD_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
static TEMP_DOWNLOAD_COUNTER: AtomicU64 = AtomicU64::new(0);
const MAX_UPDATE_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UPDATE_SIGNATURE_BYTES: usize = 64;
const MAX_DOWNLOAD_NAME_COLLISIONS: usize = 10_000;
const UPDATE_SIGNATURE_CONTEXT: &str = "vidcord-update-signature-v1";
const UPDATE_SIGNING_PUBLIC_KEY_HEX: &str = include_str!("../../update-signing-public-key.hex");
/// Longest allowed gap between download chunks. This replaces a total
/// transfer timeout: a slow but progressing download may take as long as
/// it needs, while a stalled connection still fails instead of hanging.
const DOWNLOAD_CHUNK_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// Longest allowed wait for a request to produce response headers. The
/// per-chunk idle timeout only starts once `.send()` returns, so without
/// this bound a server or proxy that accepts the connection and then
/// stalls before sending headers would hang the download forever.
const DOWNLOAD_SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

fn http_client() -> Result<&'static reqwest::Client, String> {
    HTTP_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(6))
                .user_agent(concat!("vidcord-update-check/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|error| format!("failed to build HTTP client: {error}"))
        })
        .as_ref()
        .map_err(|error| error.clone())
}

fn download_client() -> Result<&'static reqwest::Client, String> {
    DOWNLOAD_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                // No total `.timeout()`: the whole-body transfer is bounded
                // by the per-chunk idle timeout while streaming instead, so
                // slow connections can still finish a large installer.
                .connect_timeout(std::time::Duration::from_secs(30))
                .user_agent(concat!(
                    "vidcord-update-install/",
                    env!("CARGO_PKG_VERSION")
                ))
                .build()
                .map_err(|error| format!("failed to build download HTTP client: {error}"))
        })
        .as_ref()
        .map_err(|error| error.clone())
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
        .as_chunks::<2>()
        .0
        .iter()
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

/// Linux package managers that can own a vidcord installation and deliver
/// its updates from the configured vidcord repository.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LinuxPackageManager {
    Apt,
    Dnf,
    Pacman,
}

impl LinuxPackageManager {
    fn as_str(self) -> &'static str {
        match self {
            LinuxPackageManager::Apt => "apt",
            LinuxPackageManager::Dnf => "dnf",
            LinuxPackageManager::Pacman => "pacman",
        }
    }
}

const VIDCORD_REPOSITORY_HOST: &str = "cyroz1.github.io";
const VIDCORD_APT_REPOSITORY_PATH: &str = "/vidcord/apt";
const VIDCORD_RPM_REPOSITORY_PATH: &str = "/vidcord/rpm";
const VIDCORD_PACMAN_REPOSITORY_PATH: &str = "/vidcord/pacman";
const PACKAGE_MANAGER_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

fn package_manager_probe(program: &str, args: &[&str]) -> Option<std::process::Output> {
    let mut command = std::process::Command::new(program);
    command.args(args).stdin(std::process::Stdio::null());
    crate::gpu::spawn_captured_command(&mut command)
        .and_then(|child| child.wait_for_output(PACKAGE_MANAGER_PROBE_TIMEOUT))
        .unwrap_or_default()
}

fn dpkg_status_text_is_installed(text: &str) -> bool {
    text.trim() == "installed"
}

fn dpkg_package_installed(package: &str) -> bool {
    package_manager_probe("dpkg-query", &["-W", "-f=${db:Status-Status}", package])
        .map(|output| {
            output.status.success()
                && dpkg_status_text_is_installed(&String::from_utf8_lossy(&output.stdout))
        })
        .unwrap_or(false)
}

fn rpm_package_installed(package: &str) -> bool {
    package_manager_probe("rpm", &["-q", package])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn pacman_package_installed(package: &str) -> bool {
    package_manager_probe("pacman", &["-Q", package])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn url_has_vidcord_repository(value: &str, repository_path: &str) -> bool {
    let candidate = value.trim_matches(|character| character == '\'' || character == '"');
    let Ok(url) = url::Url::parse(candidate) else {
        return false;
    };
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case(VIDCORD_REPOSITORY_HOST))
        && (url.path() == repository_path || url.path().starts_with(&format!("{repository_path}/")))
}

fn apt_list_line_has_vidcord_repository(line: &str) -> bool {
    let mut tokens = line.split_whitespace();
    let Some(kind) = tokens.next() else {
        return false;
    };
    if kind != "deb" {
        return false;
    }

    let Some(mut uri) = tokens.next() else {
        return false;
    };
    if uri.starts_with('[') {
        while !uri.ends_with(']') {
            let Some(next) = tokens.next() else {
                return false;
            };
            uri = next;
        }
        let Some(next) = tokens.next() else {
            return false;
        };
        uri = next;
    }
    url_has_vidcord_repository(uri, VIDCORD_APT_REPOSITORY_PATH)
}

fn apt_list_has_vidcord_repository(text: &str) -> bool {
    text.lines().any(|line| {
        let active = line.trim();
        !active.is_empty()
            && !active.starts_with('#')
            && apt_list_line_has_vidcord_repository(active)
    })
}

fn apt_sources_stanza_has_vidcord_repository(stanza: &str) -> bool {
    let mut enabled = true;
    let mut has_binary_type = false;
    let mut has_repository_uri = false;
    let mut current_field = String::new();

    for line in stanza.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if matches!(line.chars().next(), Some(' ' | '\t')) {
            match current_field.as_str() {
                "types" => {
                    has_binary_type |= trimmed.split_whitespace().any(|value| value == "deb");
                }
                "uris" => {
                    has_repository_uri |= trimmed
                        .split_whitespace()
                        .any(|uri| url_has_vidcord_repository(uri, VIDCORD_APT_REPOSITORY_PATH));
                }
                _ => {}
            }
            continue;
        }

        let Some((name, value)) = trimmed.split_once(':') else {
            current_field.clear();
            continue;
        };
        current_field = name.trim().to_ascii_lowercase();
        let value = value.trim();
        match current_field.as_str() {
            "enabled" => {
                enabled = !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "no" | "false" | "0" | "off"
                )
            }
            "types" => {
                has_binary_type |= value.split_whitespace().any(|entry| entry == "deb");
            }
            "uris" => {
                has_repository_uri |= value
                    .split_whitespace()
                    .any(|uri| url_has_vidcord_repository(uri, VIDCORD_APT_REPOSITORY_PATH))
            }
            _ => {}
        }
    }

    enabled && has_binary_type && has_repository_uri
}

fn apt_sources_has_vidcord_repository(text: &str) -> bool {
    let normalized = text.replace("\r\n", "\n");
    let mut stanza = String::new();
    for line in normalized.lines() {
        if line.trim().is_empty() {
            if apt_sources_stanza_has_vidcord_repository(&stanza) {
                return true;
            }
            stanza.clear();
        } else {
            stanza.push_str(line);
            stanza.push('\n');
        }
    }
    apt_sources_stanza_has_vidcord_repository(&stanza)
}

fn dnf_text_has_vidcord_repository(text: &str) -> bool {
    let mut in_vidcord_section = false;
    let mut enabled = true;
    let mut has_repository_url = false;
    let mut repository_found = false;

    let finish_section = |in_vidcord_section: bool, enabled: bool, has_repository_url: bool| {
        in_vidcord_section && enabled && has_repository_url
    };

    for line in text.lines() {
        let active = line.trim();
        if active.is_empty() || active.starts_with('#') || active.starts_with(';') {
            continue;
        }
        if active.starts_with('[') && active.ends_with(']') {
            repository_found |= finish_section(in_vidcord_section, enabled, has_repository_url);
            in_vidcord_section = active[1..active.len() - 1]
                .trim()
                .eq_ignore_ascii_case("vidcord");
            enabled = true;
            has_repository_url = false;
            continue;
        }
        if !in_vidcord_section {
            continue;
        }
        let Some((key, value)) = active.split_once('=') else {
            continue;
        };
        let comment_offset = value.find(['#', ';']).unwrap_or(value.len());
        let value = value[..comment_offset].trim();
        match key.trim().to_ascii_lowercase().as_str() {
            "enabled" => {
                enabled = !matches!(
                    value.to_ascii_lowercase().as_str(),
                    "0" | "no" | "false" | "off"
                )
            }
            // A hand-edited section may locate the same repository through
            // a metalink or mirrorlist URL instead of a direct baseurl; all
            // three count when the URL is the official repository.
            "baseurl" | "metalink" | "mirrorlist" => {
                has_repository_url |= value
                    .split_whitespace()
                    .any(|baseurl| url_has_vidcord_repository(baseurl, VIDCORD_RPM_REPOSITORY_PATH))
            }
            _ => {}
        }
    }
    repository_found || finish_section(in_vidcord_section, enabled, has_repository_url)
}

fn apt_repository_file_has_vidcord_repository(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let is_sources_file = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("sources"));
    if is_sources_file {
        apt_sources_has_vidcord_repository(&text)
    } else {
        apt_list_has_vidcord_repository(&text)
    }
}

#[cfg(test)]
fn apt_text_has_vidcord_repository(text: &str) -> bool {
    apt_list_has_vidcord_repository(text) || apt_sources_has_vidcord_repository(text)
}

fn pacman_conf_has_vidcord_repository(text: &str) -> bool {
    let mut in_vidcord_section = false;
    let mut has_official_server = false;

    for line in text.lines() {
        let active = line.split('#').next().unwrap_or_default().trim();
        if active.is_empty() {
            continue;
        }
        if active.starts_with('[') && active.ends_with(']') {
            if in_vidcord_section && has_official_server {
                return true;
            }
            in_vidcord_section = active[1..active.len() - 1]
                .trim()
                .eq_ignore_ascii_case("vidcord");
            has_official_server = false;
            continue;
        }
        if !in_vidcord_section {
            continue;
        }

        let Some((key, value)) = active.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("server") {
            continue;
        }

        has_official_server |= pacman_server_value_is_official(value);
    }

    in_vidcord_section && has_official_server
}

fn pacman_server_value_is_official(value: &str) -> bool {
    value
        .split_whitespace()
        .any(|server| url_has_vidcord_repository(server, VIDCORD_PACMAN_REPOSITORY_PATH))
}

/// The `Include =` paths declared inside the `[vidcord]` section. pacman
/// resolves a relative include against the directory holding pacman.conf.
fn pacman_vidcord_include_paths(text: &str) -> Vec<String> {
    let mut in_vidcord_section = false;
    let mut includes = Vec::new();

    for line in text.lines() {
        let active = line.split('#').next().unwrap_or_default().trim();
        if active.is_empty() {
            continue;
        }
        if active.starts_with('[') && active.ends_with(']') {
            in_vidcord_section = active[1..active.len() - 1]
                .trim()
                .eq_ignore_ascii_case("vidcord");
            continue;
        }
        if !in_vidcord_section {
            continue;
        }
        let Some((key, value)) = active.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("include") {
            let value = value
                .trim()
                .trim_matches(|character| character == '\'' || character == '"');
            if !value.is_empty() {
                includes.push(value.to_string());
            }
        }
    }
    includes
}

/// Server lines in an included mirrorlist carry no section header: the
/// whole file belongs to whichever repository section included it.
fn pacman_included_servers_have_vidcord_repository(text: &str) -> bool {
    text.lines().any(|line| {
        let active = line.split('#').next().unwrap_or_default().trim();
        let Some((key, value)) = active.split_once('=') else {
            return false;
        };
        key.trim().eq_ignore_ascii_case("server") && pacman_server_value_is_official(value)
    })
}

/// The full pacman check: a literal official `Server =` in the `[vidcord]`
/// section, or an official server reached through one of that section's
/// `Include =` files. Include contents come from `read_include` so tests
/// can drive the composition without the filesystem.
fn pacman_repository_configured_with(
    text: &str,
    read_include: impl Fn(&str) -> Option<String>,
) -> bool {
    if pacman_conf_has_vidcord_repository(text) {
        return true;
    }
    pacman_vidcord_include_paths(text).iter().any(|include| {
        read_include(include)
            .map(|included| pacman_included_servers_have_vidcord_repository(&included))
            .unwrap_or(false)
    })
}

fn files_contain(paths: &[PathBuf], predicate: impl Fn(&str) -> bool) -> bool {
    paths.iter().any(|path| {
        std::fs::read_to_string(path)
            .map(|text| predicate(&text))
            .unwrap_or(false)
    })
}

fn directory_files_with_extensions(dir: &Path, extensions: &[&str]) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extensions
                        .iter()
                        .any(|expected| extension.eq_ignore_ascii_case(expected))
                })
        })
        .collect()
}

fn apt_repository_configured() -> bool {
    let mut paths = vec![PathBuf::from("/etc/apt/sources.list")];
    paths.extend(directory_files_with_extensions(
        Path::new("/etc/apt/sources.list.d"),
        &["list", "sources"],
    ));
    paths
        .iter()
        .any(|path| apt_repository_file_has_vidcord_repository(path))
}

fn dnf_repository_configured() -> bool {
    let paths = directory_files_with_extensions(Path::new("/etc/yum.repos.d"), &["repo"]);
    files_contain(&paths, dnf_text_has_vidcord_repository)
}

fn pacman_repository_configured() -> bool {
    let pacman_conf = Path::new("/etc/pacman.conf");
    let Ok(text) = std::fs::read_to_string(pacman_conf) else {
        return false;
    };
    let conf_dir = pacman_conf.parent().unwrap_or_else(|| Path::new("/etc"));
    pacman_repository_configured_with(&text, |include| {
        let path = if Path::new(include).is_absolute() {
            PathBuf::from(include)
        } else {
            conf_dir.join(include)
        };
        std::fs::read_to_string(path).ok()
    })
}

/// The package manager that delivers updates for this installation, if any.
/// A manager owns updates only when it has the vidcord package installed
/// AND the vidcord repository is configured as one of its sources. Native
/// installs without the repository (a one-off .deb/.rpm install, a portable
/// binary) keep the GitHub Releases update flow.
fn configured_linux_package_manager() -> Option<LinuxPackageManager> {
    if !cfg!(target_os = "linux") || cfg!(feature = "e2e") {
        return None;
    }
    if std::env::var_os("APPIMAGE").is_some() {
        return None;
    }
    if dpkg_package_installed("vidcord") && apt_repository_configured() {
        return Some(LinuxPackageManager::Apt);
    }
    if rpm_package_installed("vidcord") && dnf_repository_configured() {
        return Some(LinuxPackageManager::Dnf);
    }
    if pacman_package_installed("vidcord-bin") && pacman_repository_configured() {
        return Some(LinuxPackageManager::Pacman);
    }
    None
}

async fn package_manager_update_channel() -> Option<LinuxPackageManager> {
    tokio::task::spawn_blocking(configured_linux_package_manager)
        .await
        .ok()
        .flatten()
}

/// True when running inside a Flatpak sandbox. Flatpak installs are updated
/// by the platform (for example Flathub) through its own mechanism, so the
/// in-app updater stands down the same way it does for a configured package
/// repository.
fn running_in_flatpak() -> bool {
    std::env::var_os("FLATPAK_ID").is_some() || Path::new("/.flatpak-info").exists()
}

fn validate_release_tag(tag: &str) -> Result<&str, String> {
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

fn release_tag(release: &GitHubRelease) -> Result<&str, String> {
    let tag = release
        .tag_name
        .as_deref()
        .ok_or_else(|| "Update release is missing a valid tag.".to_string())?;
    validate_release_tag(tag)
}

/// True only when `tag` parses to a version strictly newer than
/// `current_version`. The install command uses this as a backend downgrade
/// guard: the update prompt only offers newer releases, but a stale or
/// buggy caller must not be able to roll an installation back to an older
/// (still validly signed) release through the command directly.
fn release_tag_is_newer_than(tag: &str, current_version: &str) -> bool {
    let Ok(candidate) = semver::Version::parse(&normalize_semver(tag)) else {
        return false;
    };
    let Ok(current) = semver::Version::parse(&normalize_semver(current_version)) else {
        return false;
    };
    candidate > current
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
    let mut candidates: Vec<&ReleaseAsset> = release
        .assets
        .iter()
        .filter(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.starts_with("vidcord_")
                && suffixes
                    .iter()
                    .any(|suffix| name.ends_with(&suffix.to_ascii_lowercase()))
        })
        .collect();
    if candidates.is_empty() {
        return Err("No update installer was found for this platform.".to_string());
    }
    // Prefer the canonical installer name for this exact tag; any other
    // suffix match is a fallback, so one stale or malformed asset cannot
    // poison the whole update.
    candidates.sort_by_key(|asset| {
        !suffixes
            .iter()
            .any(|suffix| asset.name == format!("vidcord_{release_tag}{suffix}"))
    });
    let mut last_error = String::new();
    for asset in candidates {
        match validate_selected_asset(release, asset, &release_tag) {
            Ok(selected) => return Ok(selected),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn validate_selected_asset(
    release: &GitHubRelease,
    asset: &ReleaseAsset,
    release_tag: &str,
) -> Result<SelectedAsset, String> {
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
        download_url: canonical_release_asset_url(release_tag, &name)?,
        signature_url: canonical_release_asset_url(release_tag, &signature_name)?,
        name,
        release_tag: release_tag.to_string(),
        size: asset.size,
        sha256: parse_sha256_digest(asset.digest.as_deref())?,
    })
}

async fn fetch_release(url: &str) -> Result<GitHubRelease, String> {
    fetch_release_with(url, http_client()?).await
}

async fn fetch_release_with(url: &str, client: &reqwest::Client) -> Result<GitHubRelease, String> {
    // Bound the header wait and the body read with the same deadline the
    // installer and signature transfers use. The check client already has
    // a six-second total timeout that fires first, but the install flow
    // deliberately uses the timeout-free download client, and without these
    // bounds a proxy that accepts the connection and then stalls would hang
    // the release-metadata fetch (and the latched install command) forever.
    // The JSON body is small, so a single deadline for reading it cannot
    // reject a healthy response the way a whole-installer timeout could.
    let send_result = tokio::time::timeout(
        DOWNLOAD_SEND_TIMEOUT,
        client
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .send(),
    )
    .await;
    let resp = match send_result {
        Ok(result) => result.map_err(|e| {
            let msg = e.to_string();
            vidcord_log(&format!("update release request failed: {msg}"));
            msg
        })?,
        Err(_) => {
            vidcord_log("update release request timed out waiting for response headers");
            return Err("Update release request timed out.".to_string());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        vidcord_log(&format!("update release request: HTTP {status}"));
        return Err(format!("HTTP {status}"));
    }

    match tokio::time::timeout(DOWNLOAD_SEND_TIMEOUT, resp.json::<GitHubRelease>()).await {
        Ok(result) => result.map_err(|e| {
            let msg = e.to_string();
            vidcord_log(&format!("update release response parse failed: {msg}"));
            msg
        }),
        Err(_) => {
            vidcord_log("update release response timed out while reading the body");
            Err("Update release request timed out.".to_string())
        }
    }
}

async fn fetch_latest_release() -> Result<GitHubRelease, String> {
    // Deterministic mock for E2E runs: the live GitHub feed is flaky from CI.
    #[cfg(feature = "e2e")]
    {
        return Ok(GitHubRelease {
            tag_name: Some("v99.99.99".to_string()),
            html_url: Some("https://github.com/cyroz1/vidcord/releases/tag/v99.99.99".to_string()),
            assets: vec![],
        });
    }
    #[cfg(not(feature = "e2e"))]
    fetch_release("https://api.github.com/repos/cyroz1/vidcord/releases/latest").await
}

async fn fetch_release_by_tag(tag: &str) -> Result<GitHubRelease, String> {
    let tag = validate_release_tag(tag)?;
    let url = format!("https://api.github.com/repos/cyroz1/vidcord/releases/tags/{tag}");
    // The install flow re-fetches the approved release; using the check
    // client's six-second total timeout here would fail slow connections
    // before the download even starts, so use the download client.
    fetch_release_with(&url, download_client()?).await
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

async fn hash_downloaded_file(path: &Path) -> std::io::Result<[u8; 32]> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    // Heap-allocated: an inline array this size would live in the async
    // state machine and blow the stack of the task polling it.
    let mut buffer = vec![0_u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
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

/// True when `name` matches the temporary-download shape
/// (`.{installer name}.{pid}.{counter}.download`) for a process other than
/// this one, marking it as a leftover from an install attempt that was
/// hard-killed before its guard could remove the partial file.
fn is_stale_temp_download_name(name: &str, own_pid: &str) -> bool {
    let Some(stripped) = name
        .strip_prefix('.')
        .and_then(|rest| rest.strip_suffix(".download"))
    else {
        return false;
    };
    if !stripped.starts_with("vidcord") {
        return false;
    }
    let mut parts = stripped.rsplit('.');
    let Some(_counter) = parts.next() else {
        return false;
    };
    let Some(pid) = parts.next() else {
        return false;
    };
    !pid.is_empty() && pid.bytes().all(|byte| byte.is_ascii_digit()) && pid != own_pid
}

/// Best-effort removal of stale partial update downloads left behind by an
/// install attempt that never got to clean up (SIGKILL, crash, power loss).
/// Files belonging to this process are never touched, and every error is
/// ignored: a failed sweep must never block an install.
fn sweep_stale_temp_downloads(dir: &Path) {
    let own_pid = std::process::id().to_string();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name
            .to_str()
            .is_some_and(|name| is_stale_temp_download_name(name, &own_pid))
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
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
    expected_sha256: &[u8; 32],
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
                match copy_download_without_clobber(tmp, &candidate, expected_sha256).await {
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

async fn copy_download_without_clobber(
    source: &Path,
    destination: &Path,
    expected_sha256: &[u8; 32],
) -> std::io::Result<()> {
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
        return copy_result;
    }
    drop(destination_file);

    // The hard-link publish path exposes the exact verified inode, but this
    // copy is the one path where the published bytes were never hashed: a
    // filesystem or network mount that silently corrupts the copy would
    // otherwise hand the user an unverified installer under the real name.
    // Re-hash the destination and refuse anything that differs from the
    // verified download.
    match hash_downloaded_file(destination).await {
        Ok(actual_sha256) if actual_sha256 == *expected_sha256 => Ok(()),
        Ok(_) => {
            let _ = tokio::fs::remove_file(destination).await;
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Update installer changed while it was being copied to Downloads.",
            ))
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(destination).await;
            Err(error)
        }
    }
}

async fn download_release_signature(url: &str) -> Result<[u8; 64], String> {
    let send_result = tokio::time::timeout(
        DOWNLOAD_SEND_TIMEOUT,
        download_client()?
            .get(url)
            .header("Accept", "application/octet-stream")
            .send(),
    )
    .await;
    let resp = match send_result {
        Ok(result) => result.map_err(|e| {
            let msg = e.to_string();
            vidcord_log(&format!("update install: signature request failed: {msg}"));
            msg
        })?,
        Err(_) => {
            vidcord_log("update install: signature request timed out waiting for response headers");
            return Err(
                "Update installer signature download stalled and was cancelled.".to_string(),
            );
        }
    };

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
        let chunk = match tokio::time::timeout(DOWNLOAD_CHUNK_IDLE_TIMEOUT, resp.chunk()).await {
            Ok(result) => result.map_err(|e| e.to_string())?,
            Err(_) => {
                return Err(
                    "Update installer signature download stalled and was cancelled.".to_string(),
                );
            }
        };
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

/// Deletes a partial update download when dropped, so a download whose
/// future is aborted (app quit or kill mid-transfer) cannot leak a partial
/// installer into the user's Downloads folder the way an error path that
/// never runs would. Disarm after successful verification/publication,
/// which take over ownership of the temporary file.
struct TempDownloadGuard {
    path: PathBuf,
    armed: bool,
}

impl TempDownloadGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempDownloadGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
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

    let (tmp, file) = create_temp_download_file(&path).await?;
    let mut temp_guard = TempDownloadGuard::new(tmp.clone());
    // Coalesce the transport's chunks into large writes instead of one
    // blocking-pool file operation per network chunk.
    let mut writer = tokio::io::BufWriter::with_capacity(256 * 1024, file);
    let mut written = 0u64;
    let mut hasher = Sha256::new();

    loop {
        let chunk = match tokio::time::timeout(DOWNLOAD_CHUNK_IDLE_TIMEOUT, resp.chunk()).await {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => break,
            Ok(Err(err)) => {
                let msg = err.to_string();
                vidcord_log(&format!("update install: download read failed: {msg}"));
                return Err(msg);
            }
            Err(_) => {
                vidcord_log("update install: download stalled and was cancelled");
                return Err("Update download stalled and was cancelled.".to_string());
            }
        };
        let Some(next_written) = written.checked_add(chunk.len() as u64) else {
            return Err("Update installer size overflowed.".to_string());
        };
        written = next_written;
        validate_download_size(written)?;
        if let Err(err) = writer.write_all(&chunk).await {
            return Err(err.to_string());
        }
        hasher.update(&chunk);
    }

    if let Err(err) = writer.flush().await {
        return Err(err.to_string());
    }
    // fsync before publication, like every other publish path: the hash is
    // verified over the streamed bytes, and a torn on-disk file after a
    // power loss must not be what gets published and opened.
    let file = writer.into_inner();
    if let Err(err) = file.sync_all().await {
        return Err(err.to_string());
    }
    drop(file);

    let published = finish_verified_download(
        &tmp,
        &path,
        content_length,
        written,
        asset,
        hasher.finalize().into(),
        signature,
    )
    .await?;
    temp_guard.disarm();
    Ok(published)
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

    let published_path = match publish_download_without_clobber(tmp, path, &asset.sha256).await {
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
        // Do not xdg-open the AppImage: the single-instance plugin kills any
        // second copy, so the freshly downloaded AppImage would die instantly
        // while the old version just gets focused. Reveal it in the file
        // manager instead so the user can quit, swap the AppImage, and relaunch.
        super::files::show_files_in_file_explorer_linux(&[path.to_path_buf()])?;
    }

    Ok(())
}

#[tauri::command]
pub async fn check_for_updates(current_version: String) -> Result<serde_json::Value, String> {
    // Flatpak installs are upgraded by the platform, never by the app.
    if running_in_flatpak() {
        return Ok(serde_json::json!({
            "update_available": false,
            "updates_managed_by_package_manager": true,
            "package_manager": "flatpak"
        }));
    }

    // A Linux installation whose package manager has the vidcord repository
    // configured is upgraded by APT, DNF, or pacman. Offering the AppImage
    // replacement flow for those installations would switch users to a
    // different install type and bypass the configured package repository.
    if let Some(package_manager) = package_manager_update_channel().await {
        return Ok(serde_json::json!({
            "update_available": false,
            "updates_managed_by_package_manager": true,
            "package_manager": package_manager.as_str()
        }));
    }

    let release = fetch_latest_release().await?;
    // Use the same tag extraction as the install path: only `tag_name`
    // counts (never the free-text release name), and it must pass the
    // install validation, so the prompt can never offer a version the
    // installer would refuse or fail to fetch back by tag.
    let tag = match release_tag(&release) {
        Ok(tag) => tag,
        Err(error) => {
            vidcord_log(&format!(
                "update check: latest release has no installable tag: {error}"
            ));
            return Ok(serde_json::json!({"update_available": false}));
        }
    };
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
        // `tag` already passed release_tag() validation above, which is
        // the same gate the install path applies, so any update offered
        // here is one the installer can accept.
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

/// Backend single-flight for the installer command: the frontend rejects
/// duplicate submissions, but a second window or a stale caller must not
/// start a competing download either.
static UPDATE_INSTALL_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct UpdateInstallGuard;

impl UpdateInstallGuard {
    fn acquire() -> Result<Self, String> {
        UPDATE_INSTALL_IN_FLIGHT
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| "An update install is already in progress.".to_string())
    }
}

impl Drop for UpdateInstallGuard {
    fn drop(&mut self) {
        UPDATE_INSTALL_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn download_and_open_update_installer(
    approved_release_tag: String,
) -> Result<serde_json::Value, String> {
    let _install_guard = UpdateInstallGuard::acquire()?;
    if running_in_flatpak() || package_manager_update_channel().await.is_some() {
        return Err(
            "Updates for this Linux installation are managed by its package manager.".to_string(),
        );
    }

    let release = fetch_release_by_tag(&approved_release_tag).await?;
    let actual_release_tag = release_tag(&release)?;
    if actual_release_tag != approved_release_tag {
        return Err(
            "The requested update release did not match the release returned by GitHub."
                .to_string(),
        );
    }
    if !release_tag_is_newer_than(actual_release_tag, env!("CARGO_PKG_VERSION")) {
        return Err("The requested update is not newer than the installed version.".to_string());
    }
    let asset = select_platform_asset(&release)?;
    let signature = download_release_signature(&asset.signature_url).await?;
    // The signature verdict depends only on the tag, the filename, and
    // the digest GitHub published, all known now: verify before
    // transferring up to 512 MB that a bad signature would throw away.
    // The post-download verification in the stream finisher stays, as
    // the binding to the bytes actually received.
    verify_release_signature(
        &release_signature_message(&asset.release_tag, &asset.name, &asset.sha256),
        &signature,
    )?;
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
    // Clean up partial downloads orphaned by a hard-killed earlier attempt
    // before this attempt creates its own temporary file. Best-effort: the
    // result is ignored on purpose.
    let sweep_dir = target_dir.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || sweep_stale_temp_downloads(&sweep_dir)).await;

    let send_result = tokio::time::timeout(
        DOWNLOAD_SEND_TIMEOUT,
        download_client()?
            .get(&asset.download_url)
            .header("Accept", "application/octet-stream")
            .send(),
    )
    .await;
    let resp = match send_result {
        Ok(result) => result.map_err(|e| {
            let msg = e.to_string();
            vidcord_log(&format!("update install: download request failed: {msg}"));
            msg
        })?,
        Err(_) => {
            vidcord_log("update install: download request timed out waiting for response headers");
            return Err("Update download stalled and was cancelled.".to_string());
        }
    };

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
    fn dpkg_status_text_detects_installed_only() {
        assert!(dpkg_status_text_is_installed("installed"));
        assert!(dpkg_status_text_is_installed("installed\n"));
        assert!(!dpkg_status_text_is_installed("config-files"));
        assert!(!dpkg_status_text_is_installed("not-installed"));
        assert!(!dpkg_status_text_is_installed(""));
    }

    #[test]
    fn apt_repository_text_detects_only_live_entries() {
        assert!(apt_text_has_vidcord_repository(
            "deb [signed-by=/usr/share/keyrings/vidcord-repo-key.gpg] https://cyroz1.github.io/vidcord/apt stable main"
        ));
        assert!(!apt_text_has_vidcord_repository(
            "deb-src https://cyroz1.github.io/vidcord/apt stable main"
        ));
        assert!(!apt_text_has_vidcord_repository(
            "deb https://cyroz1.github.io.attacker.example/vidcord/apt stable main"
        ));
        assert!(!apt_text_has_vidcord_repository(
            "deb https://cyroz1.github.io/vidcord-lookalike/apt stable main"
        ));
        assert!(!apt_text_has_vidcord_repository(
            "deb https://cyroz1.github.io/vidcord/rpm stable main"
        ));
        assert!(!apt_text_has_vidcord_repository(
            "deb http://cyroz1.github.io/vidcord/apt stable main"
        ));
        assert!(!apt_text_has_vidcord_repository(
            "# deb https://cyroz1.github.io/vidcord/apt stable main"
        ));
        assert!(!apt_text_has_vidcord_repository(
            "deb https://deb.debian.org/debian bookworm main"
        ));
        // deb822 stanza: enabled counts, disabled does not.
        assert!(apt_text_has_vidcord_repository(
            "Types: deb\nURIs: https://cyroz1.github.io/vidcord/apt\nSuites: stable\nEnabled: yes"
        ));
        assert!(!apt_text_has_vidcord_repository(
            "Types: deb-src\nURIs: https://cyroz1.github.io/vidcord/apt\nSuites: stable"
        ));
        assert!(!apt_text_has_vidcord_repository(
            "Types: deb\nURIs: https://cyroz1.github.io/vidcord/apt\nSuites: stable\nEnabled: no"
        ));
        // A disabled stanza must not leak its state into a following
        // enabled stanza, under CRLF endings or whitespace separators.
        assert!(apt_text_has_vidcord_repository(
            "Types: deb\r\nURIs: https://cyroz1.github.io/vidcord/apt\r\nEnabled: no\r\n\r\nTypes: deb\r\nURIs: https://cyroz1.github.io/vidcord/apt\r\nEnabled: yes"
        ));
        assert!(apt_text_has_vidcord_repository(
            "Types: deb\nURIs: https://cyroz1.github.io/vidcord/apt\nEnabled: no\n   \nTypes: deb\nURIs: https://cyroz1.github.io/vidcord/apt"
        ));
        // Case and spelling variants of the Enabled value.
        assert!(!apt_text_has_vidcord_repository(
            "Types: deb\nURIs: https://cyroz1.github.io/vidcord/apt\nenabled: No"
        ));
        assert!(!apt_text_has_vidcord_repository(
            "Types: deb\nURIs: https://cyroz1.github.io/vidcord/apt\nEnabled: off"
        ));
        assert!(!apt_text_has_vidcord_repository(
            "Types: deb\nURIs: https://cyroz1.github.io/vidcord/apt\nEnabled: FALSE"
        ));
    }

    #[test]
    fn dnf_repository_text_detects_only_enabled_sections() {
        assert!(dnf_text_has_vidcord_repository(
            "[vidcord]\nbaseurl=https://cyroz1.github.io/vidcord/rpm/\nenabled=1"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nbaseurl=https://cyroz1.github.io.attacker.example/vidcord/rpm/\nenabled=1"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nbaseurl=https://cyroz1.github.io/other/rpm/\nenabled=1"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nbaseurl=https://cyroz1.github.io/vidcord/apt\nenabled=1"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nbaseurl=http://cyroz1.github.io/vidcord/rpm/\nenabled=1"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nbaseurl=https://cyroz1.github.io/vidcord/rpm/\nenabled=0"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nenabled=0\nbaseurl=https://cyroz1.github.io/vidcord/rpm/"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nbaseurl=https://cyroz1.github.io/vidcord/rpm/\nenabled = 0"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nbaseurl=https://cyroz1.github.io/vidcord/rpm/\nenabled=0\n[vidcord-mirror]\nbaseurl=https://cyroz1.github.io/vidcord/rpm/\nenabled=1"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "# baseurl=https://cyroz1.github.io/vidcord/rpm/"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[fedora]\nbaseurl=https://download.example/pub/fedora/\nenabled=1"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nbaseurl=https://cyroz1.github.io/vidcord/rpm/\nEnabled=No"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nbaseurl=https://cyroz1.github.io/vidcord/rpm/\nenabled=off"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nbaseurl=https://cyroz1.github.io/vidcord/rpm/\nENABLED=FALSE"
        ));
    }

    #[test]
    fn pacman_conf_detects_only_vidcord_with_official_server() {
        assert!(pacman_conf_has_vidcord_repository(
            "[options]\n[vidcord]\nSigLevel = Required DatabaseRequired\nServer = https://cyroz1.github.io/vidcord/pacman/$arch\n[core]"
        ));
        assert!(pacman_conf_has_vidcord_repository(
            "[vidcord]\nServer = https://mirror.example/other/$repo/os/$arch\nServer = https://cyroz1.github.io/vidcord/pacman/$arch"
        ));
        assert!(!pacman_conf_has_vidcord_repository("  [vidcord]  \n"));
        assert!(!pacman_conf_has_vidcord_repository(
            "[vidcord]\nServer = https://mirror.example/vidcord/pacman/$arch"
        ));
        assert!(!pacman_conf_has_vidcord_repository(
            "[vidcord]\nServer = http://cyroz1.github.io/vidcord/pacman/$arch"
        ));
        assert!(!pacman_conf_has_vidcord_repository(
            "[vidcord]\nServer = https://cyroz1.github.io/vidcord-lookalike/pacman/$arch"
        ));
        assert!(!pacman_conf_has_vidcord_repository(
            "[core]\nServer = https://cyroz1.github.io/vidcord/pacman/$arch"
        ));
        assert!(!pacman_conf_has_vidcord_repository(
            "#[vidcord]\nServer = https://cyroz1.github.io/vidcord/pacman/$arch"
        ));
        assert!(!pacman_conf_has_vidcord_repository("[core]\n[extra]"));
    }

    #[test]
    fn dnf_repository_text_detects_metalink_and_mirrorlist_sections() {
        assert!(dnf_text_has_vidcord_repository(
            "[vidcord]\nmetalink=https://cyroz1.github.io/vidcord/rpm/metalink.xml\nenabled=1"
        ));
        assert!(dnf_text_has_vidcord_repository(
            "[vidcord]\nmirrorlist=https://cyroz1.github.io/vidcord/rpm/mirrors\nenabled=1"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nmetalink=https://mirrors.example.com/vidcord/rpm/metalink.xml\nenabled=1"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nmetalink=https://cyroz1.github.io/vidcord/apt\nenabled=1"
        ));
        assert!(!dnf_text_has_vidcord_repository(
            "[vidcord]\nmirrorlist=https://cyroz1.github.io/vidcord/rpm/mirrors\nenabled=0"
        ));
    }

    #[test]
    fn pacman_vidcord_include_paths_come_only_from_the_vidcord_section() {
        let text = "[options]\nInclude = /etc/pacman.d/options-mirrors\n[vidcord]\nInclude = /etc/pacman.d/vidcord-mirrors\nSigLevel = Required DatabaseRequired\n[core]\nInclude = /etc/pacman.d/mirrorlist";
        assert_eq!(
            pacman_vidcord_include_paths(text),
            ["/etc/pacman.d/vidcord-mirrors"]
        );
        assert!(pacman_vidcord_include_paths(
            "[vidcord]\nServer = https://cyroz1.github.io/vidcord/pacman/$arch"
        )
        .is_empty());
    }

    #[test]
    fn pacman_repository_detection_follows_vidcord_includes() {
        let conf =
            "[vidcord]\nSigLevel = Required DatabaseRequired\nInclude = /etc/pacman.d/vidcord-mirrors";
        let official = |path: &str| match path {
            "/etc/pacman.d/vidcord-mirrors" => Some(
                "# vidcord mirrors\nServer = https://cyroz1.github.io/vidcord/pacman/$arch\n"
                    .to_string(),
            ),
            _ => None,
        };
        assert!(pacman_repository_configured_with(conf, official));

        let foreign =
            |_: &str| Some("Server = https://mirror.example/vidcord/pacman/$arch\n".to_string());
        assert!(!pacman_repository_configured_with(conf, foreign));

        let missing = |_: &str| None;
        assert!(!pacman_repository_configured_with(conf, missing));

        // Includes declared by other sections are never followed.
        let other_section = "[core]\nInclude = /etc/pacman.d/vidcord-mirrors";
        assert!(!pacman_repository_configured_with(other_section, official));
    }

    #[test]
    fn directory_scan_matches_extensions_case_insensitively() {
        let directory = unique_test_directory();
        std::fs::create_dir_all(&directory).unwrap();
        for name in [
            "vidcord.list",
            "vidcord.LIST",
            "vidcord.Sources",
            "notes.txt",
        ] {
            std::fs::write(directory.join(name), b"").unwrap();
        }

        let mut found = directory_files_with_extensions(&directory, &["list", "sources"]);
        found.sort();
        let names: Vec<String> = found
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();

        assert_eq!(names, ["vidcord.LIST", "vidcord.Sources", "vidcord.list"]);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn apt_repository_files_are_read_by_case_insensitive_extension() {
        let directory = unique_test_directory();
        std::fs::create_dir_all(&directory).unwrap();

        let sources = directory.join("vidcord.SOURCES");
        std::fs::write(
            &sources,
            "Types: deb\nURIs: https://cyroz1.github.io/vidcord/apt\nSuites: stable\n",
        )
        .unwrap();
        assert!(apt_repository_file_has_vidcord_repository(&sources));

        let list = directory.join("vidcord.List");
        std::fs::write(
            &list,
            "deb https://cyroz1.github.io/vidcord/apt stable main\n",
        )
        .unwrap();
        assert!(apt_repository_file_has_vidcord_repository(&list));

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn package_manager_names_match_repository_docs() {
        assert_eq!(LinuxPackageManager::Apt.as_str(), "apt");
        assert_eq!(LinuxPackageManager::Dnf.as_str(), "dnf");
        assert_eq!(LinuxPackageManager::Pacman.as_str(), "pacman");
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
    fn downgrade_guard_accepts_only_strictly_newer_tags() {
        assert!(release_tag_is_newer_than("v7.8", "7.7.0"));
        assert!(release_tag_is_newer_than("v7.7.1", "7.7.0"));
        assert!(release_tag_is_newer_than("7.8.0", "7.7.0"));
        assert!(!release_tag_is_newer_than("v7.7", "7.7.0"));
        assert!(!release_tag_is_newer_than("v7.7.0", "7.7.0"));
        assert!(!release_tag_is_newer_than("v7.6", "7.7.0"));
        assert!(!release_tag_is_newer_than("v7.6.9", "7.7.0"));
        // Unparseable input on either side never authorizes an install.
        assert!(!release_tag_is_newer_than("not-a-version", "7.7.0"));
        assert!(!release_tag_is_newer_than("v7.8", "not-a-version"));
    }

    #[test]
    fn selects_current_platform_asset() {
        let suffix = platform_asset_suffixes().unwrap()[0];
        let installer_name = format!("vidcord_9.0.0{suffix}");
        let release = GitHubRelease {
            tag_name: Some("v9.0".to_string()),
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
    fn invalid_first_candidate_does_not_poison_a_valid_one() {
        let suffix = platform_asset_suffixes().unwrap()[0];
        let canonical_name = format!("vidcord_v9.0{suffix}");
        let fallback_name = format!("vidcord_9.0.0{suffix}");
        let release = GitHubRelease {
            tag_name: Some("v9.0".to_string()),
            html_url: None,
            assets: vec![
                // The canonical name is preferred, but its digest is
                // malformed, so selection must fall through to the valid
                // fallback instead of failing the whole update.
                ReleaseAsset {
                    name: canonical_name.clone(),
                    size: Some(1024),
                    digest: None,
                },
                ReleaseAsset {
                    name: format!("{canonical_name}.sig"),
                    size: Some(MAX_UPDATE_SIGNATURE_BYTES as u64),
                    digest: None,
                },
                ReleaseAsset {
                    name: fallback_name.clone(),
                    size: Some(2048),
                    digest: Some(format!("sha256:{}", "22".repeat(32))),
                },
                ReleaseAsset {
                    name: format!("{fallback_name}.sig"),
                    size: Some(MAX_UPDATE_SIGNATURE_BYTES as u64),
                    digest: None,
                },
            ],
        };

        let asset = select_platform_asset(&release).unwrap();
        assert_eq!(asset.name, fallback_name);
        assert_eq!(asset.sha256, [0x22; 32]);
    }

    #[test]
    fn release_tag_validation_matches_the_install_contract() {
        assert!(validate_release_tag("v7.7").is_ok());
        assert!(validate_release_tag("v7.7.1").is_ok());
        // Build metadata parses as semver but is not an installable tag.
        assert!(validate_release_tag("v7.7+build").is_err());
        assert!(validate_release_tag("").is_err());
        assert!(validate_release_tag("v").is_err());
        assert!(validate_release_tag("v7.7/evil").is_err());
    }

    #[test]
    fn rejects_unsigned_platform_assets() {
        let suffix = platform_asset_suffixes().unwrap()[0];
        let release = GitHubRelease {
            tag_name: Some("v9.0".to_string()),
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
    fn temp_download_guard_removes_partial_download_unless_disarmed() {
        let directory = unique_test_directory();
        std::fs::create_dir(&directory).unwrap();
        let partial = directory.join(".vidcord.download");
        std::fs::write(&partial, b"partial installer").unwrap();
        drop(TempDownloadGuard::new(partial.clone()));
        assert!(!partial.exists());

        let completed = directory.join(".vidcord-complete.download");
        std::fs::write(&completed, b"verified installer").unwrap();
        let mut guard = TempDownloadGuard::new(completed.clone());
        guard.disarm();
        drop(guard);
        assert!(completed.exists());

        std::fs::remove_dir_all(directory).unwrap();
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
            190, 125, 0, 108, 212, 160, 193, 85, 27, 111, 143, 178, 248, 27, 163, 112, 7, 179, 21,
            116, 134, 32, 90, 135, 100, 122, 54, 26, 112, 130, 158, 24, 27, 101, 38, 87, 27, 85,
            40, 1, 106, 89, 60, 80, 196, 182, 173, 47, 54, 57, 53, 251, 6, 82, 233, 206, 126, 86,
            233, 215, 203, 49, 69, 1,
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
        let expected_sha256: [u8; 32] = Sha256::digest(b"new installer").into();

        let published = publish_download_without_clobber(&tmp, &preferred, &expected_sha256)
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

        let expected_sha256: [u8; 32] = Sha256::digest(b"new installer").into();
        let error = copy_download_without_clobber(&tmp, &destination, &expected_sha256)
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"original");

        let collision = directory.join("vidcord (1).exe");
        copy_download_without_clobber(&tmp, &collision, &expected_sha256)
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(&collision).await.unwrap(), b"new installer");

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn copy_fallback_rejects_a_destination_whose_bytes_differ() {
        let directory = unique_test_directory();
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let tmp = directory.join(".vidcord.download");
        let destination = directory.join("vidcord.exe");
        tokio::fs::write(&tmp, b"new installer").await.unwrap();
        // The verified download hashed to something else, so the bytes the
        // copy landed must be refused and removed, never published.
        let other_sha256: [u8; 32] = Sha256::digest(b"different bytes").into();

        let error = copy_download_without_clobber(&tmp, &destination, &other_sha256)
            .await
            .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(!destination.exists());
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[test]
    fn stale_temp_download_names_match_only_other_processes() {
        assert!(is_stale_temp_download_name(
            ".vidcord_7.7.0_amd64.AppImage.4242.0.download",
            "1234"
        ));
        assert!(!is_stale_temp_download_name(
            ".vidcord_7.7.0_amd64.AppImage.1234.0.download",
            "1234"
        ));
        assert!(!is_stale_temp_download_name(
            "vidcord_7.7.0_amd64.AppImage",
            "1234"
        ));
        assert!(!is_stale_temp_download_name(
            "vidcord_7.7.0_amd64.AppImage.4242.0.download",
            "1234"
        ));
        assert!(!is_stale_temp_download_name(
            ".other_1.0.4242.0.download",
            "1234"
        ));
        assert!(!is_stale_temp_download_name(
            ".vidcord_backup.4242.download",
            "1234"
        ));
    }

    #[test]
    fn stale_temp_download_sweep_removes_only_other_processes_files() {
        let directory = unique_test_directory();
        std::fs::create_dir_all(&directory).unwrap();
        let own_pid = std::process::id();
        let stale = directory.join(format!(
            ".vidcord_7.7.0_amd64.AppImage.{}.0.download",
            own_pid + 1_000_000
        ));
        let own = directory.join(format!(
            ".vidcord_7.7.0_amd64.AppImage.{own_pid}.0.download"
        ));
        let unrelated = directory.join("vidcord_7.7.0_amd64.AppImage");
        std::fs::write(&stale, b"partial").unwrap();
        std::fs::write(&own, b"partial").unwrap();
        std::fs::write(&unrelated, b"installer").unwrap();

        sweep_stale_temp_downloads(&directory);

        assert!(!stale.exists());
        assert!(own.exists());
        assert!(unrelated.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
