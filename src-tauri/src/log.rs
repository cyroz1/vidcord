use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

fn log_path() -> &'static PathBuf {
    LOG_PATH.get_or_init(|| {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("vidcord_crash.log")
    })
}

pub fn setup_crash_log() {
    let path = log_path();
    // Set owner-only permissions on Unix
    #[cfg(unix)]
    {
        if !path.exists() {
            if let Ok(f) = std::fs::File::create(path) {
                use std::os::unix::fs::PermissionsExt;
                let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
            }
        }
    }
    vidcord_log(&format!(
        "=== vidcord {} starting === pid={}",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));
    // Log relevant environment variables
    for key in &["LD_LIBRARY_PATH", "LIBVA_DRIVER_NAME", "PATH", "SHELL"] {
        if let Ok(val) = std::env::var(key) {
            vidcord_log(&format!("  env {key}={val}"));
        }
    }
}

pub fn vidcord_log(msg: &str) {
    let path = log_path();
    let timestamp = {
        // Simple ISO-ish timestamp without external deps
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
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{timestamp}] {msg}");
    }
}
