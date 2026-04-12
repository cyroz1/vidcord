#[tauri::command]
pub async fn check_for_updates(current_version: String) -> Result<serde_json::Value, String> {
    fn normalize_semver(input: &str) -> String {
        let trimmed = input.trim().trim_start_matches('v');
        let mut parts = trimmed.split('.').collect::<Vec<_>>();
        while parts.len() < 3 {
            parts.push("0");
        }
        parts.into_iter().take(3).collect::<Vec<_>>().join(".")
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .user_agent("vidcord-update-check")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("https://api.github.com/repos/cyroz1/vidcord/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let tag = data["tag_name"]
        .as_str()
        .or_else(|| data["name"].as_str())
        .ok_or("Missing tag_name")?;
    let release_url = data["html_url"]
        .as_str()
        .unwrap_or("https://github.com/cyroz1/vidcord/releases/latest");

    let cur = semver::Version::parse(&normalize_semver(&current_version))
        .map_err(|e| e.to_string())?;
    let latest = semver::Version::parse(&normalize_semver(tag)).map_err(|e| e.to_string())?;

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
