use crate::log::vidcord_log;
use std::sync::OnceLock;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(6))
            .user_agent(concat!("vidcord-update-check/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("failed to build HTTP client")
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

#[tauri::command]
pub async fn check_for_updates(current_version: String) -> Result<serde_json::Value, String> {
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

    let data: serde_json::Value = resp.json().await.map_err(|e| {
        let msg = e.to_string();
        vidcord_log(&format!("update check: response parse failed: {msg}"));
        msg
    })?;
    let tag = data["tag_name"]
        .as_str()
        .or_else(|| data["name"].as_str())
        .ok_or_else(|| {
            vidcord_log("update check: response missing tag_name/name");
            "Missing tag_name".to_string()
        })?;
    let release_url = data["html_url"]
        .as_str()
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
        Ok(serde_json::json!({
            "update_available": true,
            "latest_version": tag,
            "release_url": release_url
        }))
    } else {
        Ok(serde_json::json!({"update_available": false}))
    }
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
        assert!(!(latest > cur));
    }

    #[test]
    fn semver_compare_older_no_update() {
        let cur = semver::Version::parse(&normalize_semver("6.3.0")).unwrap();
        let latest = semver::Version::parse(&normalize_semver("v6.2.5")).unwrap();
        assert!(!(latest > cur));
    }

    #[test]
    fn semver_compare_short_form() {
        let cur = semver::Version::parse(&normalize_semver("6.1")).unwrap();
        let latest = semver::Version::parse(&normalize_semver("v6.2")).unwrap();
        assert!(latest > cur);
    }
}
