//! Feedback / bug-report collection.
//!
//! Gathers the app log tail plus system info into a report the user reviews
//! in their own mail app before sending. Vidcord never sends email silently:
//! there are no SMTP credentials in the app, so the report is handed to the
//! OS mail client via a `mailto:` link composed by the frontend.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};

pub const FEEDBACK_EMAIL: &str = "owner@vidcord.app";
/// Log lines embedded in the email body (kept small so mailto: URLs stay usable).
const EMAIL_LOG_LINES: usize = 100;
/// Log lines written to the full report file saved on disk.
const FILE_LOG_LINES: usize = 500;

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BugReport {
    pub subject: String,
    pub body: String,
    pub report_path: String,
}

/// Last `max_lines` of the file at `path`, oldest first. A missing or
/// unreadable file yields an empty vec — a bug report without logs is still
/// more useful than no bug report.
fn tail_lines(path: &std::path::Path, max_lines: usize) -> Vec<String> {
    if max_lines == 0 {
        return Vec::new();
    }
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let mut ring: VecDeque<String> = VecDeque::with_capacity(max_lines);
    for line in BufReader::new(file).lines() {
        let text = match line {
            Ok(t) => t,
            Err(_) => break,
        };
        if ring.len() == max_lines {
            ring.pop_front();
        }
        ring.push_back(text);
    }
    ring.into_iter().collect()
}

/// Current UTC time as `YYYY-MM-DD HH:MM:SS`, without extra dependencies.
fn utc_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Howard Hinnant's days-to-civil algorithm.
    let days = (secs / 86400) as i64 + 719468;
    let era = days.div_euclid(146097);
    let doe = days.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    let day_secs = secs % 86400;
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
        year,
        m,
        d,
        day_secs / 3600,
        (day_secs % 3600) / 60,
        day_secs % 60
    )
}

fn format_report(
    description: Option<&str>,
    version: &str,
    os: &str,
    arch: &str,
    log_tail: &[String],
) -> String {
    let mut out = String::new();
    match description {
        Some(d) if !d.trim().is_empty() => {
            out.push_str(d.trim());
            out.push_str("\n\n");
        }
        _ => out.push_str("(no description provided)\n\n"),
    }
    out.push_str("---\n");
    out.push_str(&format!("App version: {version}\nOS: {os} ({arch})\n"));
    out.push_str(&format!("Generated: {}\n\n", utc_timestamp()));
    out.push_str(&format!(
        "--- Last {} line(s) of the app log ---\n",
        log_tail.len()
    ));
    if log_tail.is_empty() {
        out.push_str("(log unavailable)\n");
    } else {
        for line in log_tail {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

#[tauri::command]
pub fn collect_bug_report(description: Option<String>) -> Result<BugReport, String> {
    let version = env!("CARGO_PKG_VERSION");
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let log_path = crate::log::log_file_path();

    let email_tail = tail_lines(&log_path, EMAIL_LOG_LINES);
    let body = format_report(description.as_deref(), version, os, arch, &email_tail);

    // Full report on disk in case the mail client truncates the mailto: body.
    let file_tail = tail_lines(&log_path, FILE_LOG_LINES);
    let full = format_report(description.as_deref(), version, os, arch, &file_tail);
    let report_path = std::env::temp_dir().join(format!(
        "vidcord-bug-report-{}.txt",
        utc_timestamp()
            .replace(['-', ':', ' '], "_")
            .replace("__", "_")
    ));
    std::fs::write(&report_path, full).map_err(|e| format!("could not write bug report: {e}"))?;

    Ok(BugReport {
        subject: format!("Vidcord {version} bug report"),
        body,
        report_path: report_path.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp_log(lines: &[&str]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "vidcord-feedback-test-{}.log",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut f = std::fs::File::create(&path).unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
        path
    }

    #[test]
    fn tail_lines_returns_last_n_oldest_first() {
        let path = write_temp_log(&["one", "two", "three", "four", "five"]);
        let tail = tail_lines(&path, 3);
        assert_eq!(tail, vec!["three", "four", "five"]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tail_lines_short_file_returns_everything() {
        let path = write_temp_log(&["one", "two"]);
        let tail = tail_lines(&path, 100);
        assert_eq!(tail, vec!["one", "two"]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tail_lines_missing_file_is_empty() {
        let path = std::env::temp_dir().join("vidcord-feedback-test-does-not-exist.log");
        assert!(tail_lines(&path, 10).is_empty());
    }

    #[test]
    fn tail_lines_zero_returns_empty() {
        let path = write_temp_log(&["one"]);
        assert!(tail_lines(&path, 0).is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn format_report_includes_description_version_and_logs() {
        let body = format_report(
            Some("it crashed on export"),
            "7.6.0",
            "macos",
            "aarch64",
            &["log line 1".to_string()],
        );
        assert!(body.contains("it crashed on export"));
        assert!(body.contains("App version: 7.6.0"));
        assert!(body.contains("OS: macos (aarch64)"));
        assert!(body.contains("log line 1"));
        assert!(body.contains("Generated: "));
    }

    #[test]
    fn format_report_notes_missing_description() {
        for desc in [None, Some(""), Some("   ")] {
            let body = format_report(desc, "7.6.0", "linux", "x86_64", &[]);
            assert!(body.contains("(no description provided)"));
            assert!(body.contains("(log unavailable)"));
        }
    }

    #[test]
    fn utc_timestamp_is_plausible() {
        // Epoch for 2026-01-01 is 1767225600; sanity-check the formatting.
        let ts = utc_timestamp();
        assert!(ts.ends_with(" UTC"));
        assert!(ts.len() == "2026-10-07 13:00:00 UTC".len());
        let year: i32 = ts[0..4].parse().unwrap();
        assert!((2024..=2030).contains(&year));
    }
}
