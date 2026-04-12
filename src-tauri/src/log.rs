use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
// Persistent file handle — opened once in setup_crash_log(), reused for every write.
static LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();

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

pub fn setup_crash_log() {
    let path = log_path();

    // Rotate the log file if it has grown past MAX_LOG_BYTES.
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_LOG_BYTES {
            let bak = path.with_extension("log.bak");
            let _ = std::fs::rename(path, &bak);
        }
    }

    // Open (or create) the log file once; keep the handle alive for the process lifetime.
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok();

    // Set owner-only permissions on Unix (works on both new and existing files).
    #[cfg(unix)]
    if let Some(ref f) = file {
        use std::os::unix::fs::PermissionsExt;
        let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
    }

    LOG_FILE.get_or_init(|| Mutex::new(file));

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

pub fn vidcord_log(msg: &str) {
    let timestamp = {
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let s = secs % 86400;
        let h = s / 3600;
        let m = (s % 3600) / 60;
        let sec = s % 60;
        format!("{h:02}:{m:02}:{sec:02}")
    };
    if let Some(mutex) = LOG_FILE.get() {
        if let Ok(mut guard) = mutex.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = writeln!(f, "[{timestamp}] {msg}");
            }
        }
    }
}
