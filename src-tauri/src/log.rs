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

/// Flush once this many bytes are buffered, this many calls have passed, or
/// this long has elapsed, whichever comes first: the tail lost on a crash,
/// kill, or hard exit (release is `panic = "abort"`) is bounded by roughly a
/// KiB instead of the BufWriter's full ~8 KiB capacity.
const FLUSH_THRESHOLD_BYTES: u64 = 1024;
const FLUSH_THRESHOLD_CALLS: u64 = 32;
const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
/// After a failed rotation, wait this many log calls before retrying, so a
/// persistent failure cannot spin on the filesystem (or repeatedly destroy
/// the `.bak` a previous attempt created) on every call.
const ROTATION_RETRY_CALLS: u64 = 1000;

struct LogSink {
    writer: Option<BufWriter<File>>,
    current_bytes: u64,
    unflushed_bytes: u64,
    calls_since_flush: u64,
    last_flush: std::time::Instant,
    rotation_retry_calls: u64,
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

fn rotate_log_file(path: &std::path::Path) -> bool {
    // Nothing to rotate: leave any existing backup untouched. Deleting the
    // `.bak` when the source is missing (for example because a previous
    // attempt renamed it but could not reopen) would destroy that backup.
    if !path.exists() {
        return false;
    }
    // std::fs::rename does not replace an existing destination on Windows, so
    // remove any previous backup first or rotation would fail permanently.
    let bak = path.with_extension("log.bak");
    let _ = std::fs::remove_file(&bak);
    std::fs::rename(path, &bak).is_ok()
}

impl LogSink {
    fn rotate(&mut self) {
        if let Some(mut writer) = self.writer.take() {
            let _ = writer.flush();
        }
        self.unflushed_bytes = 0;
        self.calls_since_flush = 0;
        let path = log_path();
        let rotated = rotate_log_file(path);
        match open_log_file(path) {
            Ok(file) if rotated => {
                self.writer = Some(BufWriter::new(file));
                self.current_bytes = 0;
                self.rotation_retry_calls = 0;
            }
            Ok(file) => {
                // Reopening succeeded but the old file was not moved aside:
                // keep appending to it, reset the counter so the size is
                // re-measured from the file, and back off before retrying.
                self.current_bytes = file.metadata().map(|meta| meta.len()).unwrap_or(0);
                self.writer = Some(BufWriter::new(file));
                self.rotation_retry_calls = ROTATION_RETRY_CALLS;
            }
            Err(_) => {
                LOG_FALLBACK_STDERR.store(true, Ordering::Relaxed);
                // Latch the failure: do not retry rotation on every later
                // call, which would repeat these syscalls on the hot path
                // and could destroy the `.bak` created above.
                self.current_bytes = 0;
                self.rotation_retry_calls = ROTATION_RETRY_CALLS;
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
            unflushed_bytes: 0,
            calls_since_flush: 0,
            last_flush: std::time::Instant::now(),
            rotation_retry_calls: 0,
        })
    });

    vidcord_log(&format!(
        "=== vidcord {} starting === pid={}",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));
    // Log only the variables vidcord actually uses — never PATH or SHELL, which can
    // contain sensitive substrings from the user's environment.
    if let Ok(val) = std::env::var("LIBVA_DRIVER_NAME") {
        vidcord_log(&format!("  env LIBVA_DRIVER_NAME={val}"));
    }
    // LD_LIBRARY_PATH gets the same care as PATH: it is a path list that can
    // contain home-directory substrings. The AppImage diagnostics only need
    // its shape: set or not, how many entries, and whether any entry points
    // into the AppImage mount (APPDIR).
    match std::env::var("LD_LIBRARY_PATH") {
        Ok(val) => {
            let entries: Vec<&str> = val.split(':').filter(|entry| !entry.is_empty()).collect();
            let appdir = std::env::var("APPDIR").unwrap_or_default();
            let into_appimage =
                !appdir.is_empty() && entries.iter().any(|entry| entry.starts_with(&appdir));
            vidcord_log(&format!(
                "  env LD_LIBRARY_PATH: {} entries, into_appimage={into_appimage}",
                entries.len()
            ));
        }
        Err(_) => vidcord_log("  env LD_LIBRARY_PATH: unset"),
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

fn append_padded(buffer: &mut String, value: u64, width: usize) {
    // Write the decimal digits without a formatting allocation.
    let mut digits = [0u8; 20];
    let mut value = value;
    let mut index = digits.len();
    loop {
        index -= 1;
        digits[index] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    let natural = digits.len() - index;
    for _ in natural..width {
        buffer.push('0');
    }
    // The digits above are plain ASCII.
    buffer.push_str(std::str::from_utf8(&digits[index..]).unwrap_or(""));
}

/// Append the timestamp for `secs` directly into `buffer`, reusing its
/// allocation: the logging hot path builds each line in one buffer instead
/// of allocating a fresh formatted timestamp `String` per call.
fn append_timestamp(buffer: &mut String, secs: u64) {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    append_padded(buffer, year.max(0) as u64, 4);
    buffer.push('-');
    append_padded(buffer, u64::from(month), 2);
    buffer.push('-');
    append_padded(buffer, u64::from(day), 2);
    buffer.push(' ');
    append_padded(buffer, tod / 3600, 2);
    buffer.push(':');
    append_padded(buffer, (tod % 3600) / 60, 2);
    buffer.push(':');
    append_padded(buffer, tod % 60, 2);
    buffer.push_str(" UTC");
}

#[cfg(test)]
fn format_timestamp(secs: u64) -> String {
    let mut buffer = String::with_capacity(24);
    append_timestamp(&mut buffer, secs);
    buffer
}

fn is_error_level(msg: &str) -> bool {
    // Many real failures are phrased without the words error/failed/failure,
    // for example the "could not ..." messages used across settings,
    // preview, and startup cleanup, so match that phrasing too: those lines
    // are exactly the ones that must reach disk before a possible exit.
    ["error", "failed", "failure", "panic", "could not"]
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
    append_timestamp(&mut line, secs);
    line.push_str("] ");
    line.push_str(msg);
    line.push('\n');

    let Some(mutex) = LOG_FILE.get() else {
        // Logging was never set up; there is nowhere durable to report to yet.
        return;
    };
    let mut guard = mutex.lock().unwrap_or_else(|e| e.into_inner());
    // Bind through the guard once: field accesses on the LogSink itself can
    // then borrow disjoint fields (writer vs. counters) at the same time,
    // which repeated derefs of the MutexGuard cannot.
    let sink: &mut LogSink = &mut guard;
    if sink.rotation_retry_calls > 0 {
        sink.rotation_retry_calls -= 1;
    } else if sink.current_bytes > MAX_LOG_BYTES {
        sink.rotate();
    }
    let mut write_failed = false;
    let mut written = 0usize;
    match sink.writer.as_mut() {
        Some(writer) => {
            if writer.write_all(line.as_bytes()).is_ok() {
                written = line.len();
                sink.unflushed_bytes += written as u64;
                sink.calls_since_flush += 1;
                // Error-level messages flush immediately. Everything else
                // flushes on a small byte/call/time threshold instead of
                // waiting for the BufWriter's full buffer, so a crash, kill,
                // or hard exit can only lose a short tail.
                if (is_error_level(msg)
                    || sink.unflushed_bytes >= FLUSH_THRESHOLD_BYTES
                    || sink.calls_since_flush >= FLUSH_THRESHOLD_CALLS
                    || sink.last_flush.elapsed() >= FLUSH_INTERVAL)
                    && writer.flush().is_ok()
                {
                    sink.unflushed_bytes = 0;
                    sink.calls_since_flush = 0;
                    sink.last_flush = std::time::Instant::now();
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

/// Flush any buffered log lines. Available for orderly shutdown paths; the
/// threshold flush in `vidcord_log` already bounds what an abrupt exit can
/// lose, so callers do not need this for correctness.
pub fn flush_log() {
    if let Some(mutex) = LOG_FILE.get() {
        let mut guard = mutex.lock().unwrap_or_else(|e| e.into_inner());
        let sink: &mut LogSink = &mut guard;
        if let Some(writer) = sink.writer.as_mut() {
            if writer.flush().is_ok() {
                sink.unflushed_bytes = 0;
                sink.calls_since_flush = 0;
                sink.last_flush = std::time::Instant::now();
            }
        }
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
        // Failure phrasing without error/failed/failure must still flush.
        assert!(is_error_level("Settings: could not read the settings file"));
        assert!(is_error_level("Preview server: could not spawn a thread"));
        assert!(!is_error_level("Startup: frontend ready in 12 ms"));
    }

    #[test]
    fn append_timestamp_reuses_the_line_buffer() {
        let mut line = String::from("[");
        append_timestamp(&mut line, 0);
        line.push(']');
        assert_eq!(line, "[1970-01-01 00:00:00 UTC]");
        let mut line = String::new();
        append_timestamp(&mut line, 951_782_400);
        assert_eq!(line, "2000-02-29 00:00:00 UTC");
    }

    #[test]
    fn rotation_without_a_source_file_preserves_the_backup() {
        let dir = std::env::temp_dir().join(format!("vidcord-log-rotate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vidcord.log");
        let bak = dir.join("vidcord.log.bak");
        std::fs::write(&bak, b"previous backup").unwrap();
        // No current log file: rotation must not delete the only backup.
        assert!(!rotate_log_file(&path));
        assert_eq!(std::fs::read(&bak).unwrap(), b"previous backup");
        std::fs::write(&path, b"current").unwrap();
        assert!(rotate_log_file(&path));
        assert_eq!(std::fs::read(&bak).unwrap(), b"current");
        std::fs::remove_dir_all(&dir).ok();
    }
}
