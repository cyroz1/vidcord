use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
// Persistent buffered file handle — opened once in setup_crash_log(), reused
// for every write. The sink also tracks the approximate file size so rotation
// can happen mid-session, not only at startup.
static LOG_FILE: OnceLock<Mutex<LogSink>> = OnceLock::new();
// Set when the log file could not be opened (or a write failed): subsequent
// messages fall back to stderr instead of being silently discarded.
static LOG_FALLBACK_STDERR: AtomicBool = AtomicBool::new(false);

struct LogSink {
    writer: Option<BufWriter<File>>,
    current_bytes: u64,
}

/// Filesystem location of the app log, for bug-report collection.
pub fn log_file_path() -> PathBuf {
    log_path().clone()
}

fn log_path() -> &'static PathBuf {
    LOG_PATH.get_or_init(|| {
        let base = dirs::data_local_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
        let dir = base.join("vidcord");
        let _ = std::fs::create_dir_all(&dir);
        dir.join("vidcord.log")
    })
}

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024; // 5 MB

fn open_log_file(path: &std::path::Path) -> std::io::Result<File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;

    // Set owner-only permissions on Unix (works on both new and existing files).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }

    Ok(file)
}

fn rotate_log_file(path: &std::path::Path) {
    // std::fs::rename does not replace an existing destination on Windows, so
    // remove any previous backup first or rotation would fail permanently.
    let bak = path.with_extension("log.bak");
    let _ = std::fs::remove_file(&bak);
    let _ = std::fs::rename(path, &bak);
}

impl LogSink {
    fn rotate(&mut self) {
        if let Some(mut writer) = self.writer.take() {
            let _ = writer.flush();
        }
        let path = log_path();
        rotate_log_file(path);
        match open_log_file(path) {
            Ok(file) => {
                self.writer = Some(BufWriter::new(file));
                self.current_bytes = 0;
            }
            Err(_) => {
                LOG_FALLBACK_STDERR.store(true, Ordering::Relaxed);
            }
        }
    }
}

pub fn setup_crash_log() {
    let path = log_path();

    // Rotate the log file if it has grown past MAX_LOG_BYTES.
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_LOG_BYTES {
            rotate_log_file(path);
        }
    }

    // Open (or create) the log file once; keep the handle alive for the process lifetime.
    let (file, current_bytes) = match open_log_file(path) {
        Ok(file) => {
            let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
            (Some(file), len)
        }
        Err(error) => {
            LOG_FALLBACK_STDERR.store(true, Ordering::Relaxed);
            eprintln!(
                "vidcord: could not open log file at {}: {error}",
                path.display()
            );
            (None, 0)
        }
    };

    LOG_FILE.get_or_init(|| {
        Mutex::new(LogSink {
            writer: file.map(BufWriter::new),
            current_bytes,
        })
    });

    vidcord_log(&format!(
        "=== vidcord {} starting === pid={}",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));
    // Log only the variables vidcord actually uses — never PATH or SHELL, which can
    // contain sensitive substrings from the user's environment.
    for key in &["LD_LIBRARY_PATH", "LIBVA_DRIVER_NAME"] {
        if let Ok(val) = std::env::var(key) {
            vidcord_log(&format!("  env {key}={val}"));
        }
    }
}

/// Days since the Unix epoch -> (year, month, day), via Howard Hinnant's
/// civil-from-days algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn format_timestamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

fn is_error_level(msg: &str) -> bool {
    ["error", "failed", "failure", "panic"]
        .iter()
        .any(|needle| {
            msg.as_bytes()
                .windows(needle.len())
                .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
        })
}

pub fn vidcord_log(msg: &str) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut line = String::with_capacity(msg.len() + 32);
    line.push('[');
    line.push_str(&format_timestamp(secs));
    line.push_str("] ");
    line.push_str(msg);
    line.push('\n');

    let Some(mutex) = LOG_FILE.get() else {
        // Logging was never set up; there is nowhere durable to report to yet.
        return;
    };
    let mut sink = mutex.lock().unwrap_or_else(|e| e.into_inner());
    if sink.current_bytes > MAX_LOG_BYTES {
        sink.rotate();
    }
    let mut write_failed = false;
    let mut written = 0usize;
    match sink.writer.as_mut() {
        Some(writer) => {
            if writer.write_all(line.as_bytes()).is_ok() {
                written = line.len();
                // Error-level messages flush immediately; everything else is
                // flushed by the BufWriter when its buffer fills.
                if is_error_level(msg) {
                    let _ = writer.flush();
                }
            } else {
                write_failed = true;
            }
        }
        None => {
            if LOG_FALLBACK_STDERR.load(Ordering::Relaxed) {
                eprint!("{line}");
            }
        }
    }
    sink.current_bytes += written as u64;
    if write_failed {
        sink.writer = None;
        LOG_FALLBACK_STDERR.store(true, Ordering::Relaxed);
        eprint!("{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_include_a_civil_date() {
        assert_eq!(format_timestamp(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(civil_from_days(31), (1970, 2, 1));
        // 2000 is a leap year (divisible by 400).
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
    }

    #[test]
    fn error_level_detection_is_case_insensitive() {
        assert!(is_error_level("GPU discovery command lspci failed: boom"));
        assert!(is_error_level("Error while running"));
        assert!(!is_error_level("Startup: frontend ready in 12 ms"));
    }
}
