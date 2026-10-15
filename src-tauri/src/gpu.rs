use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static GPU_CACHE: OnceLock<HashMap<String, bool>> = OnceLock::new();
static CAPTURE_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);
const GPU_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(6);
const DISCOVERY_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_DISCOVERY_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;

struct CaptureFile {
    path: std::path::PathBuf,
    file: Option<File>,
}

impl CaptureFile {
    fn create() -> std::io::Result<Self> {
        for _ in 0..64 {
            let path = std::env::temp_dir().join(format!(
                ".vidcord-discovery-{}-{}.capture",
                std::process::id(),
                CAPTURE_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let mut options = OpenOptions::new();
            options.create_new(true).read(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: Some(file),
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "could not allocate process output capture file",
        ))
    }

    fn child_stdio(&self) -> std::io::Result<Stdio> {
        self.file
            .as_ref()
            .ok_or_else(|| std::io::Error::other("process output capture is closed"))?
            .try_clone()
            .map(Stdio::from)
    }

    fn len(&self) -> std::io::Result<u64> {
        self.file
            .as_ref()
            .ok_or_else(|| std::io::Error::other("process output capture is closed"))?
            .metadata()
            .map(|metadata| metadata.len())
    }

    fn read_all(&mut self, max_output_bytes: u64) -> std::io::Result<Vec<u8>> {
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| std::io::Error::other("process output capture is closed"))?;
        file.seek(SeekFrom::Start(0))?;
        let mut output = Vec::with_capacity(file.metadata()?.len().min(64 * 1024) as usize);
        file.take(max_output_bytes + 1).read_to_end(&mut output)?;
        if output.len() as u64 > max_output_bytes {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "process produced too much output",
            ));
        }
        Ok(output)
    }
}

impl Drop for CaptureFile {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(crate) struct CapturedChild {
    child: Child,
    stdout: CaptureFile,
    stderr: CaptureFile,
    finished: bool,
}

impl CapturedChild {
    pub(crate) fn id(&self) -> u32 {
        self.child.id()
    }

    fn terminate_and_reap(&mut self) {
        let _ = self.child.kill();
        if self.child.wait().is_ok() {
            self.finished = true;
        }
    }

    pub(crate) fn wait_for_output(self, timeout: Duration) -> std::io::Result<Option<Output>> {
        self.wait_for_output_with_limit(timeout, MAX_DISCOVERY_OUTPUT_BYTES)
    }

    pub(crate) fn wait_for_output_with_limit(
        mut self,
        timeout: Duration,
        max_output_bytes: u64,
    ) -> std::io::Result<Option<Output>> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        // Checking a capture file's length is a metadata syscall, so check
        // only one file per 10 ms poll, alternating between stdout and
        // stderr: each file is re-checked every ~20 ms (keeping the output
        // cap's enforcement window tight) at half the stat cost of checking
        // both files on every wake-up. try_wait() stays on the fast cadence
        // and read_all() re-enforces the cap on the completed output.
        let mut iteration: u64 = 0;
        loop {
            if let Some(status) = self.child.try_wait()? {
                self.finished = true;
                return Ok(Some(Output {
                    status,
                    stdout: self.stdout.read_all(max_output_bytes)?,
                    stderr: self.stderr.read_all(max_output_bytes)?,
                }));
            }

            let capture_len = if iteration.is_multiple_of(2) {
                self.stdout.len()?
            } else {
                self.stderr.len()?
            };
            if capture_len > max_output_bytes {
                self.terminate_and_reap();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "process produced too much output",
                ));
            }
            iteration += 1;

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.terminate_and_reap();
                return Ok(None);
            }
            std::thread::sleep(remaining.min(DISCOVERY_POLL_INTERVAL));
        }
    }
}

impl Drop for CapturedChild {
    fn drop(&mut self) {
        if !self.finished {
            self.terminate_and_reap();
        }
    }
}

pub(crate) fn spawn_captured_command(cmd: &mut Command) -> std::io::Result<CapturedChild> {
    let stdout = CaptureFile::create()?;
    let stderr = CaptureFile::create()?;
    cmd.stdout(stdout.child_stdio()?)
        .stderr(stderr.child_stdio()?);
    let child_result = cmd.spawn();
    // Release the command-owned file handle immediately. This is required for
    // reliable temporary-file cleanup on Windows.
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let child = child_result?;
    Ok(CapturedChild {
        child,
        stdout,
        stderr,
        finished: false,
    })
}

fn gpu_command_output(cmd: &mut Command, deadline: Instant, command_name: &str) -> Option<Output> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        crate::log::vidcord_log(&format!(
            "GPU discovery deadline expired before {command_name} could start"
        ));
        return None;
    }
    match spawn_captured_command(cmd).and_then(|child| child.wait_for_output(remaining)) {
        Ok(Some(output)) => Some(output),
        Ok(None) => {
            crate::log::vidcord_log(&format!("GPU discovery command {command_name} timed out"));
            None
        }
        Err(error) => {
            crate::log::vidcord_log(&format!(
                "GPU discovery command {command_name} failed: {error}"
            ));
            None
        }
    }
}

/// Spawn GPU discovery on a dedicated thread and return its handle. This is
/// the entry point other modules should use: discovery probes external tools
/// under a multi-second deadline and must never run on the async runtime.
pub(crate) fn spawn_gpu_discovery() -> std::thread::JoinHandle<&'static HashMap<String, bool>> {
    std::thread::spawn(get_system_gpus_blocking)
}

/// Blocking GPU discovery. The first call runs the platform probe
/// synchronously (up to `GPU_DISCOVERY_TIMEOUT`) and concurrent callers wait
/// on the same cache, so call this only from a dedicated thread or a
/// `spawn_blocking` context — use `spawn_gpu_discovery()` from async code.
pub fn get_system_gpus_blocking() -> &'static HashMap<String, bool> {
    GPU_CACHE.get_or_init(|| {
        let mut gpus = HashMap::from([
            ("nvidia".to_string(), false),
            ("amd".to_string(), false),
            ("intel".to_string(), false),
            ("apple".to_string(), false),
        ]);

        if let Some(detected) = detect_gpus() {
            for (k, v) in detected {
                gpus.insert(k, v);
            }
        } else {
            // Detection failed — enable all vendors so no valid encoder is hidden.
            // This means the encoder list may include options the system can't use;
            // FFmpeg will return a clear error if the user picks one that doesn't work.
            crate::log::vidcord_log("GPU detection failed — enabling all vendors as fallback");
            for v in gpus.values_mut() {
                *v = true;
            }
        }
        gpus
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn cached_system_has_gpu(vendor: &str) -> bool {
    GPU_CACHE
        .get()
        .and_then(|gpus| gpus.get(vendor))
        .copied()
        .unwrap_or(false)
}

/// Whether the (already lowercased) text contains an Apple-silicon chip
/// token such as "m1" or "m4" as a standalone word — the token-scan
/// equivalent of the previous `\bm\d+\b` regex, without a fallible compile.
/// Its only production caller is the macOS discovery block; elsewhere it is
/// exercised by its unit test.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn contains_apple_chip_token(text: &str) -> bool {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|token| {
            token.len() >= 2
                && token.starts_with('m')
                && token[1..].chars().all(|c| c.is_ascii_digit())
        })
}

fn detect_gpus() -> Option<HashMap<String, bool>> {
    let deadline = Instant::now()
        .checked_add(GPU_DISCOVERY_TIMEOUT)
        .unwrap_or_else(Instant::now);
    // Detection fills plain locals; the vendor map is built once at the end,
    // so no key lookup can panic if the key set ever changes.
    let mut nvidia = false;
    let mut amd = false;
    let mut intel = false;
    // Only assigned by the macOS probe; on other platforms it stays false.
    #[allow(unused_mut)]
    let mut apple = false;

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("system_profiler");
        command.args(["SPDisplaysDataType", "-detailLevel", "mini"]);
        let out = gpu_command_output(&mut command, deadline, "system_profiler")?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        nvidia = text.contains("nvidia");
        amd = text.contains("amd") || text.contains("radeon");
        intel = text.contains("intel");
        apple = text.contains("apple") || contains_apple_chip_token(&text);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Primary: PowerShell Get-CimInstance (Windows 10+)
        let mut powershell = Command::new("powershell");
        powershell
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
            ])
            .creation_flags(0x08000000); // CREATE_NO_WINDOW
        let ps_result = gpu_command_output(&mut powershell, deadline, "PowerShell");

        let text = match ps_result {
            Some(ref out) if out.status.success() => {
                String::from_utf8_lossy(&out.stdout).to_lowercase()
            }
            _ => {
                // Fallback: wmic (works on older Windows / restricted PowerShell).
                // It shares the one overall discovery deadline, so worst-case
                // Windows discovery stays within GPU_DISCOVERY_TIMEOUT as
                // documented on get_system_gpus_blocking(); if PowerShell
                // already consumed the deadline, gpu_command_output logs
                // that the fallback could not start and discovery fails
                // over to enabling all vendors.
                let mut wmic = Command::new("wmic");
                wmic.args(["path", "win32_VideoController", "get", "name"])
                    .creation_flags(0x08000000);
                let wmic_result = gpu_command_output(&mut wmic, deadline, "wmic");
                match wmic_result {
                    Some(ref out) if out.status.success() => {
                        String::from_utf8_lossy(&out.stdout).to_lowercase()
                    }
                    _ => return None,
                }
            }
        };

        nvidia = text.contains("nvidia");
        amd = text.contains("amd") || text.contains("radeon");
        intel = text.contains("intel");
    }

    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new("lspci");
        let out = gpu_command_output(&mut command, deadline, "lspci")?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        for line in text.lines() {
            if line.contains("vga") || line.contains("display") || line.contains("3d") {
                nvidia |= line.contains("nvidia");
                amd |= line.contains("amd") || line.contains("radeon");
                intel |= line.contains("intel");
            }
        }
    }

    Some(HashMap::from([
        ("nvidia".to_string(), nvidia),
        ("amd".to_string(), amd),
        ("intel".to_string(), intel),
        ("apple".to_string(), apple),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quick_command() -> Command {
        #[cfg(windows)]
        {
            let mut command = Command::new("cmd");
            command.args(["/C", "echo vidcord"]);
            command
        }
        #[cfg(unix)]
        {
            let mut command = Command::new("sh");
            command.args(["-c", "printf vidcord"]);
            command
        }
    }

    fn slow_command() -> Command {
        #[cfg(windows)]
        {
            let mut command = Command::new("ping");
            command.args(["127.0.0.1", "-n", "3"]);
            command
        }
        #[cfg(unix)]
        {
            let mut command = Command::new("sleep");
            command.arg("2");
            command
        }
    }

    #[test]
    fn apple_chip_tokens_are_detected_as_standalone_words() {
        assert!(contains_apple_chip_token("chipset model: m4 pro"));
        assert!(contains_apple_chip_token("apple m1"));
        assert!(!contains_apple_chip_token("radeon rx 6600m"));
        assert!(!contains_apple_chip_token("intel iris xe"));
    }

    #[test]
    fn captured_command_returns_bounded_output() {
        let mut command = quick_command();
        let output = spawn_captured_command(&mut command)
            .unwrap()
            .wait_for_output(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("vidcord"));
    }

    #[test]
    fn captured_command_enforces_custom_output_limit() {
        let mut command = quick_command();
        let error = spawn_captured_command(&mut command)
            .unwrap()
            .wait_for_output_with_limit(Duration::from_secs(2), 3)
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[cfg(unix)]
    #[test]
    fn capture_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let capture = CaptureFile::create().unwrap();
        let mode = std::fs::metadata(&capture.path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn captured_command_terminates_at_deadline() {
        let mut command = slow_command();
        let started = Instant::now();
        let output = spawn_captured_command(&mut command)
            .unwrap()
            .wait_for_output(Duration::from_millis(25))
            .unwrap();
        assert!(output.is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
