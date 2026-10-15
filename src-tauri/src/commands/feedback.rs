//! Feedback / bug-report collection.
//!
//! Gathers the app log tail plus system info into a report. The user explicitly
//! submits it through the feedback endpoint; the frontend can open a `mailto:`
//! link as a fallback. This command also saves a full local report copy.

use std::io::{Read, Seek, SeekFrom, Write};

pub const FEEDBACK_EMAIL: &str = "owner@vidcord.app";
/// Log lines embedded in the email body (kept small so mailto: URLs stay usable).
const EMAIL_LOG_LINES: usize = 100;
/// Log lines written to the full report file saved on disk.
const FILE_LOG_LINES: usize = 500;
/// Cap on the user's free-text description, so a pasted multi-MB log cannot
/// multiply into several huge report strings and an unusable mailto URL.
const MAX_DESCRIPTION_BYTES: usize = 8 * 1024;
/// Saved report copies older than this are swept when a new report is
/// collected, so one full-log file per submission does not accumulate in
/// the shared temp directory forever.
const REPORT_RETENTION: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);
const REPORT_FILE_PREFIX: &str = "vidcord-bug-report-";

/// Truncates an over-long description on a character boundary and marks
/// the cut, before the text is embedded in any report copy.
fn truncate_description(description: Option<String>) -> Option<String> {
    description.map(|text| {
        if text.len() <= MAX_DESCRIPTION_BYTES {
            return text;
        }
        let mut end = MAX_DESCRIPTION_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n[truncated]", &text[..end])
    })
}

/// Best-effort removal of saved report copies past their retention window.
fn sweep_stale_report_files(temp_dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(temp_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(REPORT_FILE_PREFIX) || !name.ends_with(".txt") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| modified.elapsed().is_ok_and(|age| age > REPORT_RETENTION));
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

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
///
/// Reads a trailing window starting near EOF instead of streaming the
/// whole file from byte 0; the window grows (x4) until it holds enough
/// complete lines or reaches the start of the file, so correctness does
/// not depend on guessing a line length.
fn tail_lines(path: &std::path::Path, max_lines: usize) -> Vec<String> {
    if max_lines == 0 {
        return Vec::new();
    }
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let file_len = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(_) => return Vec::new(),
    };
    if file_len == 0 {
        return Vec::new();
    }

    const INITIAL_WINDOW_BYTES: u64 = 128 * 1024;
    let mut window = INITIAL_WINDOW_BYTES;
    loop {
        let start = file_len.saturating_sub(window);
        if file.seek(SeekFrom::Start(start)).is_err() {
            return Vec::new();
        }
        let mut buffer = Vec::with_capacity((file_len - start) as usize);
        if file.read_to_end(&mut buffer).is_err() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&buffer);
        let mut lines: Vec<String> = text
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
            .collect();
        // `split` yields a trailing empty segment for a final newline;
        // that is a terminator, not an extra empty line.
        if lines.last().is_some_and(|line| line.is_empty()) {
            lines.pop();
        }
        if start > 0 {
            // The first segment is a partial line cut by the window edge.
            if !lines.is_empty() {
                lines.remove(0);
            }
        }
        if lines.len() > max_lines || start == 0 {
            let skip = lines.len().saturating_sub(max_lines);
            return lines.into_iter().skip(skip).collect();
        }
        window = window.saturating_mul(4);
    }
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

fn open_private_report_file(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Directory that saved report copies live in.
///
/// Unix keeps reports in the shared temp directory, with the file itself
/// hardened to mode 0o600 by `open_private_report_file`. Windows has no
/// mode equivalent for a file created in the shared temp directory, so
/// there the reports go under the per-user cache directory instead,
/// whose ACL is inherited from the user profile and is not shared with
/// other local users — the same per-user location the compression code
/// uses for private temporary output on non-Unix platforms.
fn report_directory() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(cache_dir) = dirs::cache_dir() {
            let directory = cache_dir.join("vidcord").join("bug-reports");
            if std::fs::create_dir_all(&directory).is_ok() {
                return directory;
            }
        }
    }
    std::env::temp_dir()
}

/// Validates that `path` names a saved report copy in the report
/// directory, so the delete command can never be pointed at an unrelated
/// file. Returns the validated path.
fn validated_report_path(path: &str) -> Result<std::path::PathBuf, String> {
    let candidate = std::path::PathBuf::from(path);
    let file_name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid bug report path.".to_string())?;
    if !file_name.starts_with(REPORT_FILE_PREFIX) || !file_name.ends_with(".txt") {
        return Err("Invalid bug report path.".to_string());
    }
    let directory = report_directory();
    let parent = candidate
        .parent()
        .ok_or_else(|| "Invalid bug report path.".to_string())?;
    let parent_matches = std::fs::canonicalize(parent)
        .ok()
        .zip(std::fs::canonicalize(&directory).ok())
        .is_some_and(|(parent, directory)| parent == directory)
        || parent == directory.as_path();
    if !parent_matches {
        return Err("Invalid bug report path.".to_string());
    }
    Ok(candidate)
}

fn delete_bug_report_blocking(report_path: String) -> Result<(), String> {
    let path = validated_report_path(&report_path)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // Already gone (swept or removed by the user) is still deleted
        // as far as the caller is concerned.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not delete bug report: {error}")),
    }
}

/// Deletes a saved report copy after the frontend confirms the report
/// was sent through the feedback endpoint, so a confirmed send does not
/// leave a full log copy behind. The mailto fallback path does not call
/// this: the user may still need the file there.
#[tauri::command]
pub async fn delete_bug_report(report_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || delete_bug_report_blocking(report_path))
        .await
        .map_err(|error| error.to_string())?
}

fn write_report_file(contents: &str) -> Result<std::path::PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static REPORT_COUNTER: AtomicU64 = AtomicU64::new(0);
    let temp_dir = report_directory();
    for _ in 0..32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let suffix = REPORT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = temp_dir.join(format!(
            "{REPORT_FILE_PREFIX}{}-{nanos}-{suffix}.txt",
            std::process::id()
        ));
        let mut file = match open_private_report_file(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("could not create bug report: {error}")),
        };
        if let Err(error) = file.write_all(contents.as_bytes()) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(format!("could not write bug report: {error}"));
        }
        return Ok(path);
    }
    Err("could not choose a private bug report filename".to_string())
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
pub async fn collect_bug_report(description: Option<String>) -> Result<BugReport, String> {
    tokio::task::spawn_blocking(move || collect_bug_report_blocking(description))
        .await
        .map_err(|error| error.to_string())?
}

fn collect_bug_report_blocking(description: Option<String>) -> Result<BugReport, String> {
    let version = env!("CARGO_PKG_VERSION");
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let log_path = crate::log::log_file_path();
    let description = truncate_description(description);

    // One pass over the log: the email body embeds the last EMAIL_LOG_LINES
    // of the same tail the full report file is written from.
    let file_tail = tail_lines(&log_path, FILE_LOG_LINES);
    let email_tail = &file_tail[file_tail.len().saturating_sub(EMAIL_LOG_LINES)..];
    let body = format_report(description.as_deref(), version, os, arch, email_tail);

    // Full report on disk in case the mail client truncates the mailto: body.
    let full = format_report(description.as_deref(), version, os, arch, &file_tail);
    sweep_stale_report_files(&report_directory());
    let report_path = write_report_file(&full)?;

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
    fn tail_lines_reads_past_the_initial_window() {
        // ~400 KB of log: the trailing window has to grow before the last
        // 500 complete lines are inside it, and no partial line may leak.
        let lines: Vec<String> = (0..2000)
            .map(|index| format!("log line {index:04} {}", "x".repeat(180)))
            .collect();
        let path = write_temp_log(&lines.iter().map(String::as_str).collect::<Vec<_>>());
        let tail = tail_lines(&path, 500);
        assert_eq!(tail.len(), 500);
        assert_eq!(tail.first().unwrap(), &lines[1500]);
        assert_eq!(tail.last().unwrap(), &lines[1999]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn delete_bug_report_only_accepts_report_files_in_the_report_directory() {
        let directory = report_directory();
        let report = directory.join("vidcord-bug-report-1-2-3.txt");
        std::fs::write(&report, "report").unwrap();
        assert!(delete_bug_report_blocking(report.to_string_lossy().into_owned()).is_ok());
        assert!(!report.exists());

        // A real file elsewhere, a non-report name, and a missing report
        // parent must all be refused or handled without deleting anything.
        let other = write_temp_log(&["keep me"]);
        assert!(delete_bug_report_blocking(other.to_string_lossy().into_owned()).is_err());
        assert!(other.exists());
        let _ = std::fs::remove_file(&other);

        let wrong_name = directory.join("notes.txt");
        assert!(validated_report_path(&wrong_name.to_string_lossy()).is_err());
        // Deleting an already-gone report is a no-op success.
        let gone = directory.join("vidcord-bug-report-9-9-9.txt");
        assert!(delete_bug_report_blocking(gone.to_string_lossy().into_owned()).is_ok());
    }

    #[test]
    fn format_report_includes_description_version_and_logs() {
        let body = format_report(
            Some("it crashed on export"),
            "7.7.0",
            "macos",
            "aarch64",
            &["log line 1".to_string()],
        );
        assert!(body.contains("it crashed on export"));
        assert!(body.contains("App version: 7.7.0"));
        assert!(body.contains("OS: macos (aarch64)"));
        assert!(body.contains("log line 1"));
        assert!(body.contains("Generated: "));
    }

    #[test]
    fn format_report_notes_missing_description() {
        for desc in [None, Some(""), Some("   ")] {
            let body = format_report(desc, "7.7.0", "linux", "x86_64", &[]);
            assert!(body.contains("(no description provided)"));
            assert!(body.contains("(log unavailable)"));
        }
    }

    #[test]
    fn long_descriptions_are_truncated_with_a_marker() {
        let long = "x".repeat(MAX_DESCRIPTION_BYTES + 100);
        let truncated = truncate_description(Some(long)).unwrap();
        assert!(truncated.ends_with("[truncated]"));
        assert!(truncated.len() <= MAX_DESCRIPTION_BYTES + "\n[truncated]".len());

        let short = "short description".to_string();
        assert_eq!(truncate_description(Some(short.clone())), Some(short));
        assert_eq!(truncate_description(None), None);
    }

    #[test]
    fn description_truncation_respects_character_boundaries() {
        // 'é' is two bytes; a byte-naive cut inside it would panic on slicing.
        let text = format!(
            "{}é{}",
            "a".repeat(MAX_DESCRIPTION_BYTES - 1),
            "b".repeat(64)
        );
        let truncated = truncate_description(Some(text)).unwrap();
        assert!(truncated.ends_with("[truncated]"));
    }

    #[test]
    fn stale_report_sweep_only_removes_old_report_files() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "vidcord-feedback-sweep-test-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let fresh_report = directory.join("vidcord-bug-report-1-2-3.txt");
        let other_file = directory.join("unrelated.txt");
        std::fs::write(&fresh_report, "fresh").unwrap();
        std::fs::write(&other_file, "keep").unwrap();

        sweep_stale_report_files(&directory);

        assert!(fresh_report.exists());
        assert!(other_file.exists());
        std::fs::remove_dir_all(directory).unwrap();
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

    #[cfg(unix)]
    #[test]
    fn report_file_is_private_and_does_not_follow_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir();
        let report = temp_dir.join(format!(
            "vidcord-report-test-{}-{unique}",
            std::process::id()
        ));
        let target = temp_dir.join(format!(
            "vidcord-report-target-{}-{unique}",
            std::process::id()
        ));
        std::fs::write(&target, "unchanged").unwrap();
        symlink(&target, &report).unwrap();

        let error = open_private_report_file(&report).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "unchanged");

        std::fs::remove_file(&report).unwrap();
        let created = write_report_file("private report").unwrap();
        let mode = std::fs::metadata(&created).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read_to_string(&created).unwrap(), "private report");
        std::fs::remove_file(created).unwrap();
        std::fs::remove_file(target).unwrap();
    }
}
