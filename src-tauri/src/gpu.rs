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
        loop {
            if let Some(status) = self.child.try_wait()? {
                self.finished = true;
                return Ok(Some(Output {
                    status,
                    stdout: self.stdout.read_all(max_output_bytes)?,
                    stderr: self.stderr.read_all(max_output_bytes)?,
                }));
            }

            if self.stdout.len()? > max_output_bytes || self.stderr.len()? > max_output_bytes {
                self.terminate_and_reap();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "process produced too much output",
                ));
            }

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

pub fn get_system_gpus() -> &'static HashMap<String, bool> {
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

fn detect_gpus() -> Option<HashMap<String, bool>> {
    let deadline = Instant::now()
        .checked_add(GPU_DISCOVERY_TIMEOUT)
        .unwrap_or_else(Instant::now);
    let mut gpus = HashMap::from([
        ("nvidia".to_string(), false),
        ("amd".to_string(), false),
        ("intel".to_string(), false),
        ("apple".to_string(), false),
    ]);

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("system_profiler");
        command.args(["SPDisplaysDataType", "-detailLevel", "mini"]);
        let out = gpu_command_output(&mut command, deadline, "system_profiler")?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        if text.contains("nvidia") {
            *gpus.get_mut("nvidia").unwrap() = true;
        }
        if text.contains("amd") || text.contains("radeon") {
            *gpus.get_mut("amd").unwrap() = true;
        }
        if text.contains("intel") {
            *gpus.get_mut("intel").unwrap() = true;
        }
        let apple_re = regex_lite::Regex::new(r"\bm\d+\b").expect("invalid regex literal");
        if text.contains("apple") || apple_re.is_match(&text) {
            *gpus.get_mut("apple").unwrap() = true;
        }
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
                // Fallback: wmic (works on older Windows / restricted PowerShell)
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

        if text.contains("nvidia") {
            *gpus.get_mut("nvidia").unwrap() = true;
        }
        if text.contains("amd") || text.contains("radeon") {
            *gpus.get_mut("amd").unwrap() = true;
        }
        if text.contains("intel") {
            *gpus.get_mut("intel").unwrap() = true;
        }
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
                if line.contains("nvidia") {
                    *gpus.get_mut("nvidia").unwrap() = true;
                }
                if line.contains("amd") || line.contains("radeon") {
                    *gpus.get_mut("amd").unwrap() = true;
                }
                if line.contains("intel") {
                    *gpus.get_mut("intel").unwrap() = true;
                }
            }
        }
    }

    Some(gpus)
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
