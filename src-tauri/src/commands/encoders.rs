use crate::ffmpeg::{
    configure_ffmpeg_command, get_available_encoders, get_or_discover_encoder_listing,
    invalidate_encoder_cache,
};
use crate::gpu::spawn_captured_command;
use crate::log::vidcord_log;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// Cached regex for the "show encoders" dialog — compiled once, reused on repeat calls.
static LIST_ENCODER_RE: OnceLock<regex_lite::Regex> = OnceLock::new();

// Cache the result of the ffmpeg availability probe for 30 seconds to avoid
// spawning a new process on every call during startup / rapid re-checks.
static FFMPEG_AVAIL_CACHE: OnceLock<Mutex<Option<(bool, Instant)>>> = OnceLock::new();
const FFMPEG_CACHE_TTL: Duration = Duration::from_secs(30);
const COMMAND_PROBE_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FfmpegInstallResult {
    pub status: String,
    pub message: String,
    pub hint_command: Option<String>,
    pub guide_url: Option<String>,
}

#[derive(Deserialize)]
pub struct FfmpegInstallOptions {
    pub allow_privileged: Option<bool>,
}

/// Spawn a probe whose output is discarded entirely, under the same
/// deadline and kill/reap discipline as the captured probes. Routing
/// these through temp capture files would make a full or locked temp
/// directory report existing tools as missing; with both streams nulled
/// there is no output to cap, so the capture machinery buys nothing here.
fn probe_exit_status(
    command: &mut std::process::Command,
    timeout: Duration,
) -> std::io::Result<Option<std::process::ExitStatus>> {
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = command.spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn command_exists(cmd: &str) -> bool {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(cmd);
    command.arg("--version");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    matches!(
        probe_exit_status(&mut command, COMMAND_PROBE_TIMEOUT),
        Ok(Some(status)) if status.success()
    )
}

fn ffmpeg_tool_probe(tool: impl AsRef<std::ffi::OsStr>) -> bool {
    let tool = tool.as_ref();
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(tool);
    cmd.arg("-version");
    configure_ffmpeg_command(&mut cmd);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    match probe_exit_status(&mut cmd, COMMAND_PROBE_TIMEOUT) {
        Ok(Some(status)) => status.success(),
        Ok(None) => {
            vidcord_log(&format!(
                "FFmpeg tool probe timed out: {}",
                tool.to_string_lossy()
            ));
            false
        }
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                vidcord_log(&format!(
                    "FFmpeg tool probe failed for {}: {error}",
                    tool.to_string_lossy()
                ));
            }
            false
        }
    }
}

#[cfg(target_os = "windows")]
fn ffmpeg_tools_exist(directory: &Path) -> bool {
    directory.join("ffmpeg.exe").is_file() && directory.join("ffprobe.exe").is_file()
}

/// Upper bound on directories the recovery walk may visit, so a huge or
/// junction-laced tree inside a search root cannot stall the probe.
#[cfg(target_os = "windows")]
const MAX_RECOVERY_DIRECTORIES: usize = 512;

/// Compare directory names so embedded version numbers order numerically:
/// "ffmpeg-10" is newer than "ffmpeg-9", which a plain lexical comparison
/// gets backwards ("9" > "10").
#[cfg(target_os = "windows")]
fn compare_names_natural(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> std::cmp::Ordering {
    let left = left.to_string_lossy();
    let right = right.to_string_lossy();
    let mut left_chars = left.chars().peekable();
    let mut right_chars = right.chars().peekable();
    loop {
        match (left_chars.peek(), right_chars.peek()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(&lc), Some(&rc)) => {
                if lc.is_ascii_digit() && rc.is_ascii_digit() {
                    let take_run = |chars: &mut std::iter::Peekable<std::str::Chars<'_>>| {
                        let mut run = String::new();
                        while let Some(&c) = chars.peek() {
                            if !c.is_ascii_digit() {
                                break;
                            }
                            run.push(c);
                            chars.next();
                        }
                        run
                    };
                    let left_num = take_run(&mut left_chars);
                    let right_num = take_run(&mut right_chars);
                    let left_key = left_num.trim_start_matches('0');
                    let right_key = right_num.trim_start_matches('0');
                    let ordering = left_key
                        .len()
                        .cmp(&right_key.len())
                        .then_with(|| left_key.cmp(right_key));
                    if ordering != std::cmp::Ordering::Equal {
                        return ordering;
                    }
                } else if lc != rc {
                    return lc.cmp(&rc);
                } else {
                    left_chars.next();
                    right_chars.next();
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn collect_ffmpeg_bins_within(
    directory: &Path,
    remaining_depth: usize,
    visited: &mut usize,
    candidates: &mut Vec<PathBuf>,
) {
    if *visited >= MAX_RECOVERY_DIRECTORIES {
        return;
    }
    *visited += 1;
    if ffmpeg_tools_exist(directory) {
        candidates.push(directory.to_path_buf());
        return;
    }
    if remaining_depth == 0 {
        return;
    }

    let mut child_directories = std::fs::read_dir(directory)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        // Never follow junctions or symlinks: one inside a search root
        // could point at a whole drive and walk far outside the
        // documented scope. file_type() does not follow the link.
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    // Prefer the newest version-named directory while remaining deterministic.
    child_directories.sort_by(|left, right| {
        compare_names_natural(
            right.file_name().unwrap_or_default(),
            left.file_name().unwrap_or_default(),
        )
    });

    for path in child_directories {
        collect_ffmpeg_bins_within(&path, remaining_depth - 1, visited, candidates);
    }
}

/// Every directory under `directory` holding both FFmpeg tools, in
/// preference order, so a broken first candidate cannot shadow a working
/// one deeper in the same root.
#[cfg(target_os = "windows")]
fn find_ffmpeg_bins_within(directory: &Path, remaining_depth: usize) -> Vec<PathBuf> {
    let mut visited = 0;
    let mut candidates = Vec::new();
    collect_ffmpeg_bins_within(directory, remaining_depth, &mut visited, &mut candidates);
    candidates
}

#[cfg(target_os = "windows")]
fn find_winget_ffmpeg_bins(winget_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for root in winget_roots {
        let links = root.join("Links");
        if ffmpeg_tools_exist(&links) {
            candidates.push(links);
        }

        let packages = root.join("Packages");
        let mut package_directories = std::fs::read_dir(packages)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("Gyan.FFmpeg_")
            })
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();
        package_directories.sort_by(|left, right| {
            compare_names_natural(
                right.file_name().unwrap_or_default(),
                left.file_name().unwrap_or_default(),
            )
        });

        for package in package_directories {
            candidates.extend(find_ffmpeg_bins_within(&package, 3));
        }
    }
    candidates
}

#[cfg(target_os = "windows")]
fn ffmpeg_tool_pair_available(directory: &Path) -> bool {
    ffmpeg_tool_probe(directory.join("ffmpeg.exe"))
        && ffmpeg_tool_probe(directory.join("ffprobe.exe"))
}

#[cfg(target_os = "windows")]
fn find_windows_ffmpeg_bin() -> Option<PathBuf> {
    let winget_roots = windows_winget_roots();
    let mut manual_roots = Vec::new();
    if let Some(system_drive) = std::env::var_os("SystemDrive") {
        let mut drive_root = system_drive.to_string_lossy().into_owned();
        if !drive_root.ends_with('\\') && !drive_root.ends_with('/') {
            drive_root.push('\\');
        }
        manual_roots.push(PathBuf::from(format!("{drive_root}ffmpeg")));
    }
    // This is the documented location for the native Windows ARM64 build.
    let documented_root = PathBuf::from(r"C:\ffmpeg");
    if !manual_roots.iter().any(|root| root == &documented_root) {
        manual_roots.push(documented_root);
    }

    let find_manual = || {
        manual_roots
            .iter()
            .flat_map(|root| find_ffmpeg_bins_within(root, 3))
            .find(|bin| ffmpeg_tool_pair_available(bin))
    };
    let find_winget = || {
        find_winget_ffmpeg_bins(&winget_roots)
            .into_iter()
            .find(|bin| ffmpeg_tool_pair_available(bin))
    };

    // Prefer the manually installed location in ARM64 vidcord so a native
    // build does not lose to an x64 package running through Windows emulation.
    if cfg!(target_arch = "aarch64") {
        find_manual().or_else(find_winget)
    } else {
        find_winget().or_else(find_manual)
    }
}

#[cfg(target_os = "windows")]
fn windows_winget_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        roots.push(
            PathBuf::from(local_app_data)
                .join("Microsoft")
                .join("WinGet"),
        );
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(program_files) = std::env::var_os(variable) {
            let root = PathBuf::from(program_files).join("WinGet");
            if !roots.iter().any(|existing| existing == &root) {
                roots.push(root);
            }
        }
    }
    roots
}

#[cfg(target_os = "windows")]
fn recover_windows_ffmpeg_path() -> bool {
    let Some(bin) = find_windows_ffmpeg_bin() else {
        return false;
    };

    let old_path = std::env::var_os("PATH").unwrap_or_default();
    let mut path_entries = std::env::split_paths(&old_path).collect::<Vec<_>>();
    let already_first = path_entries.first().is_some_and(|entry| {
        entry
            .to_string_lossy()
            .eq_ignore_ascii_case(&bin.to_string_lossy())
    });
    if already_first {
        return true;
    }

    path_entries.retain(|entry| {
        !entry
            .to_string_lossy()
            .eq_ignore_ascii_case(&bin.to_string_lossy())
    });
    path_entries.insert(0, bin.clone());
    match std::env::join_paths(path_entries) {
        Ok(new_path) => {
            std::env::set_var("PATH", new_path);
            vidcord_log(&format!(
                "Recovered FFmpeg from a known install directory: {}",
                bin.display()
            ));
        }
        Err(error) => {
            vidcord_log(&format!(
                "Could not add the FFmpeg install directory to PATH: {error}"
            ));
            return false;
        }
    }
    true
}

/// Store a probe result without letting a slower, older probe overwrite a
/// newer one racing beside it (for example a startup probe still running
/// when a post-install fresh probe completes). The stored timestamp is
/// when the probe STARTED, so freshness checks and this ordering describe
/// the same moment.
fn store_avail_result(
    cache: &Mutex<Option<(bool, Instant)>>,
    result: bool,
    probe_started: Instant,
) {
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, existing_started)) = *guard {
        if existing_started > probe_started {
            return;
        }
    }
    *guard = Some((result, probe_started));
}

fn ffmpeg_probe() -> bool {
    if ffmpeg_tool_probe("ffmpeg") && ffmpeg_tool_probe("ffprobe") {
        return true;
    }

    #[cfg(target_os = "windows")]
    if recover_windows_ffmpeg_path() {
        return ffmpeg_tool_probe("ffmpeg") && ffmpeg_tool_probe("ffprobe");
    }

    false
}

fn ffmpeg_available() -> bool {
    let cache = FFMPEG_AVAIL_CACHE.get_or_init(|| Mutex::new(None));
    {
        let guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((result, checked_at)) = *guard {
            if checked_at.elapsed() < FFMPEG_CACHE_TTL {
                return result;
            }
        }
    }
    // Probe without the lock held: the probe spawns ffmpeg/ffprobe and can
    // take seconds, and every availability caller would queue behind it.
    // Two callers racing past an expired TTL may both probe; the store
    // keeps the later probe's verdict.
    let probe_started = Instant::now();
    let result = ffmpeg_probe();
    store_avail_result(cache, result, probe_started);
    result
}

// `get_available_encoders` has already run `ffmpeg -encoders` successfully.
// Reuse that proof and probe only the companion ffprobe executable instead of
// launching both version commands again. A cached false is deliberately
// re-checked because FFmpeg may have been installed outside vidcord meanwhile.
fn ffprobe_available_after_ffmpeg_success() -> bool {
    let cache = FFMPEG_AVAIL_CACHE.get_or_init(|| Mutex::new(None));
    {
        let guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((true, checked_at)) = *guard {
            if checked_at.elapsed() < FFMPEG_CACHE_TTL {
                return true;
            }
        }
    }

    let probe_started = Instant::now();
    let result = ffmpeg_tool_probe("ffprobe");
    #[cfg(target_os = "windows")]
    let result = if !result && recover_windows_ffmpeg_path() {
        ffmpeg_tool_probe("ffprobe")
    } else {
        result
    };
    store_avail_result(cache, result, probe_started);
    result
}

// Used after an install attempt to bypass the TTL and get a fresh answer.
// Called from platform-specific install branches (Windows, Linux).
#[allow(dead_code)]
fn ffmpeg_available_fresh() -> bool {
    let cache = FFMPEG_AVAIL_CACHE.get_or_init(|| Mutex::new(None));
    let probe_started = Instant::now();
    let result = ffmpeg_probe();
    store_avail_result(cache, result, probe_started);
    // A fresh ffmpeg install may expose new hardware encoders; drop the
    // encoder-list cache so `detect_encoders` re-probes on next call.
    if result {
        invalidate_encoder_cache();
        // The new binary may also ship filters (tonemap/zscale) that a
        // pre-install probe cached as missing.
        crate::commands::compression::invalidate_filter_cache();
    }
    result
}

/// Installs are not short probes, but a hung package manager must not wedge
/// its `spawn_blocking` closure (and the install UI) forever either. Use the
/// same ten-minute bound as the Linux privileged install path.
#[cfg(any(target_os = "windows", target_os = "macos"))]
const INSTALL_COMMAND_TIMEOUT: Duration = Duration::from_secs(600);

/// Run an installer command to completion under the install deadline.
///
/// Installs are long jobs, not short discovery probes, so they do not go
/// through `spawn_captured_command`: a chatty winget/brew run can produce
/// far more than that helper's 8 MiB per-stream capture cap, and hitting
/// the cap killed the install mid-run with a misleading "failed to run"
/// error. The install callers only use the exit status, so the child's
/// output goes to null instead of a capped capture: there is no output
/// cap to hit, no output is buffered in memory, and the exit status is
/// reported exactly. `Ok(Some(output))` is a finished run (with empty
/// stdout/stderr), `Ok(None)` is the deadline (the child is killed and
/// reaped first), and `Err` means the command could not be launched.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn run_install_command(
    cmd: &mut std::process::Command,
) -> std::io::Result<Option<std::process::Output>> {
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let deadline = Instant::now() + INSTALL_COMMAND_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(std::process::Output {
                status,
                stdout: Vec::new(),
                stderr: Vec::new(),
            }));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(target_os = "linux")]
fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// `apt-get update` plus a package install can take minutes on slow mirrors.
#[cfg(target_os = "linux")]
const PRIVILEGED_INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// True when sudo can run without prompting (NOPASSWD entry or a cached
/// timestamp), so `sudo -n` will not fail outright.
#[cfg(target_os = "linux")]
fn passwordless_sudo_available() -> bool {
    let mut command = std::process::Command::new("sudo");
    command.args(["-n", "true"]);
    matches!(
        spawn_captured_command(&mut command)
            .and_then(|child| child.wait_for_output(COMMAND_PROBE_TIMEOUT)),
        Ok(Some(output)) if output.status.success()
    )
}

/// Terminal emulators that stay in the foreground, with the extra args needed
/// to run a command in them. `gnome-terminal` daemonizes by default, so it
/// needs `--wait`; `x-terminal-emulator` is the Debian alternatives shim and
/// is only a last resort because it can resolve to a daemonizing terminal.
#[cfg(target_os = "linux")]
fn find_terminal_emulator() -> Option<(&'static str, &'static [&'static str])> {
    const TERMINALS: &[(&str, &[&str])] = &[
        ("konsole", &["-e"]),
        // xfce4-terminal's `-e` takes ONE string argument (the whole
        // command line); passing argv after it fails with
        // `Unknown option "-lc"`. `-x` is its execute-rest-of-argv form,
        // and `--disable-server` keeps the process in the foreground so
        // the caller can wait on it like the other terminals.
        ("xfce4-terminal", &["--disable-server", "-x"]),
        ("xterm", &["-e"]),
        ("alacritty", &["-e"]),
        ("gnome-terminal", &["--wait", "--"]),
        ("x-terminal-emulator", &["-e"]),
    ];
    TERMINALS
        .iter()
        .copied()
        .find(|(binary, _)| command_exists(binary))
}

/// Run the package-manager install command with elevated privileges, trying
/// each escalation method in turn:
/// 1. passwordless `sudo -n` (NOPASSWD entry or cached credentials),
/// 2. `pkexec` (graphical polkit prompt),
/// 3. interactive `sudo` inside a terminal emulator, where the user types
///    their password at a real sudo prompt.
///
/// Install commands are idempotent (`apt-get update`, `install -y`), so a
/// method that fails cleanly falls through to the next one. Returns the first
/// successful output; otherwise the most informative failure output (sudo and
/// pkexec capture the real stderr, a terminal emulator's own output is
/// empty); `None` on timeout (which stops further escalation attempts); or an
/// error when no escalation method could be launched at all.
#[cfg(target_os = "linux")]
fn run_privileged_install(install_cmd: &str) -> std::io::Result<Option<std::process::Output>> {
    let deadline = Instant::now() + PRIVILEGED_INSTALL_TIMEOUT;
    let quoted = shell_quote(install_cmd);
    let mut attempts: Vec<std::process::Command> = Vec::new();

    if passwordless_sudo_available() {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-lc", format!("sudo -n sh -lc {quoted}").as_str()]);
        attempts.push(cmd);
    }

    if command_exists("pkexec") {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-lc", format!("pkexec sh -lc {quoted}").as_str()]);
        attempts.push(cmd);
    }

    if let Some((terminal, extra_args)) = find_terminal_emulator() {
        let mut cmd = std::process::Command::new(terminal);
        let inner = format!("sudo sh -lc {quoted}");
        let mut args: Vec<&str> = extra_args.to_vec();
        args.extend(["sh", "-lc", inner.as_str()]);
        cmd.args(args);
        attempts.push(cmd);
    }

    if attempts.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no privilege escalation method found (need pkexec, sudo, or a terminal emulator)",
        ));
    }

    let mut informative_failure: Option<std::process::Output> = None;
    for mut attempt in attempts {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }
        match spawn_captured_command(&mut attempt)
            .and_then(|child| child.wait_for_output(remaining))
        {
            Ok(Some(output)) if output.status.success() => return Ok(Some(output)),
            Ok(Some(output)) => {
                if informative_failure.is_none() {
                    informative_failure = Some(output);
                }
            }
            // A timed-out package-manager command may still have made partial
            // changes. Do not start another copy of the same install through a
            // different escalation path; the caller reports the shared
            // ten-minute deadline accurately.
            Ok(None) => return Ok(None),
            Err(_) => {}
        }
    }
    Ok(informative_failure)
}

/// Last few lines of stderr for failure diagnostics. Package-manager errors
/// ("a password is required", "Unable to locate package", ...) are what the
/// user needs to see instead of a bare exit code.
#[cfg(target_os = "linux")]
fn stderr_tail(stderr: &[u8]) -> String {
    const MAX_LINES: usize = 6;
    const MAX_CHARS: usize = 600;
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(MAX_LINES);
    let mut tail = lines[start..].join("\n").trim().to_string();
    let char_count = tail.chars().count();
    if char_count > MAX_CHARS {
        tail = tail.chars().skip(char_count - MAX_CHARS).collect();
    }
    tail
}

#[tauri::command]
pub async fn detect_encoders() -> Vec<serde_json::Value> {
    tokio::task::spawn_blocking(|| {
        let detected = get_available_encoders();

        // WinGet updates the registry PATH but cannot update this running
        // process. On ARM64, the native build is also commonly installed at
        // C:\ffmpeg. If normal discovery fails, recover a known install
        // directory and retry without requiring a reboot.
        #[cfg(target_os = "windows")]
        let detected = if detected.ffmpeg_discovery_failed && recover_windows_ffmpeg_path() {
            get_available_encoders()
        } else {
            detected
        };

        let ffmpeg_missing = detected.ffmpeg_missing
            || if detected.ffmpeg_freshly_probed {
                !ffprobe_available_after_ffmpeg_success()
            } else {
                !ffmpeg_available()
            };
        detected
            .encoders
            .into_iter()
            .enumerate()
            .map(|(index, (name, label))| {
                let auto_selectable = detected.auto_selectable.contains(&name);
                if index == 0 && ffmpeg_missing {
                    serde_json::json!({
                        "name": name,
                        "label": label,
                        "auto_selectable": auto_selectable,
                        "ffmpeg_missing": true
                    })
                } else {
                    serde_json::json!({
                        "name": name,
                        "label": label,
                        "auto_selectable": auto_selectable
                    })
                }
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_else(|_| vec![serde_json::json!({"name": "libx264", "label": "CPU (libx264)", "ffmpeg_missing": true})])
}

#[tauri::command]
pub async fn check_ffmpeg_available() -> bool {
    // Plain availability checks go through the 30 s TTL cache. The fresh
    // probe (`ffmpeg_available_fresh`) is reserved for post-install flows:
    // it re-probes both tools and, on success, invalidates the encoder and
    // filter caches, which would otherwise force full encoder re-detection
    // plus tonemap/zscale re-probes after every cheap availability check.
    tokio::task::spawn_blocking(ffmpeg_available)
        .await
        .unwrap_or(false)
}

#[tauri::command]
#[allow(unused_variables)]
pub async fn install_ffmpeg_dependency(opts: Option<FfmpegInstallOptions>) -> FfmpegInstallResult {
    tokio::task::spawn_blocking(move || {
        if ffmpeg_available() {
            return FfmpegInstallResult {
                status: "already_available".to_string(),
                message: "FFmpeg is already installed and available on PATH.".to_string(),
                hint_command: None,
                guide_url: None,
            };
        }

        #[cfg(target_os = "windows")]
        {
            if !command_exists("winget") {
                return FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: "winget was not found. Install FFmpeg manually from the setup guide."
                        .to_string(),
                    hint_command: Some("winget install Gyan.FFmpeg".to_string()),
                    guide_url: Some("https://aka.ms/getwinget".to_string()),
                };
            }

            #[allow(unused_mut)]
            let mut cmd = std::process::Command::new("winget");
            cmd.args([
                "install",
                "--id",
                "Gyan.FFmpeg",
                "--exact",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--silent",
            ]);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }

            match run_install_command(&mut cmd) {
                Ok(Some(output)) if output.status.success() => {
                    if ffmpeg_available_fresh() {
                        FfmpegInstallResult {
                            status: "installed".to_string(),
                            message: "FFmpeg installed successfully.".to_string(),
                            hint_command: None,
                            guide_url: None,
                        }
                    } else {
                        FfmpegInstallResult {
                            status: "failed".to_string(),
                            message: "FFmpeg was installed, but vidcord could not locate both ffmpeg.exe and ffprobe.exe. Open the setup guide to repair PATH."
                                .to_string(),
                            hint_command: Some(
                                "Get-Command ffmpeg; Get-Command ffprobe".to_string(),
                            ),
                            guide_url: Some(
                                "https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md"
                                    .to_string(),
                            ),
                        }
                    }
                }
                Ok(Some(output)) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: format!(
                        "winget failed with exit code {}. Install FFmpeg manually from the setup guide.",
                        output.status.code().unwrap_or(-1)
                    ),
                    hint_command: Some("winget install Gyan.FFmpeg".to_string()),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
                Ok(None) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: "winget timed out after 10 minutes. Install FFmpeg manually from the setup guide."
                        .to_string(),
                    hint_command: Some("winget install Gyan.FFmpeg".to_string()),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
                Err(err) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: format!("Failed to run winget: {err}"),
                    hint_command: Some("winget install Gyan.FFmpeg".to_string()),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
            }
        }

        #[cfg(target_os = "macos")]
        {
            if !command_exists("brew") {
                return FfmpegInstallResult {
                    status: "failed".to_string(),
                    message:
                        "Homebrew is not installed. Install Homebrew first, then try again."
                            .to_string(),
                    hint_command: Some("brew install ffmpeg".to_string()),
                    guide_url: Some("https://brew.sh".to_string()),
                };
            }

            #[allow(unused_mut)]
            let mut brew_cmd = std::process::Command::new("brew");
            brew_cmd.args(["install", "ffmpeg"]);
            match run_install_command(&mut brew_cmd) {
                Ok(Some(output)) if output.status.success() => {
                    if ffmpeg_available_fresh() {
                        FfmpegInstallResult {
                            status: "installed".to_string(),
                            message: "FFmpeg installed successfully with Homebrew.".to_string(),
                            hint_command: None,
                            guide_url: None,
                        }
                    } else {
                        FfmpegInstallResult {
                            status: "installed".to_string(),
                            message: "FFmpeg install completed. If it is still not detected, restart vidcord."
                                .to_string(),
                            hint_command: None,
                            guide_url: None,
                        }
                    }
                }
                Ok(Some(output)) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: format!(
                        "brew install ffmpeg failed with exit code {}.",
                        output.status.code().unwrap_or(-1)
                    ),
                    hint_command: Some("brew install ffmpeg".to_string()),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
                Ok(None) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: "brew install ffmpeg timed out after 10 minutes.".to_string(),
                    hint_command: Some("brew install ffmpeg".to_string()),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
                Err(err) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: format!("Failed to run brew: {err}"),
                    hint_command: Some("brew install ffmpeg".to_string()),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
            }
        }

        #[cfg(target_os = "linux")]
        {
            let allow_privileged = opts
                .as_ref()
                .and_then(|o| o.allow_privileged)
                .unwrap_or(false);

            let (pkg_manager, install_cmd) = if command_exists("apt") {
                // apt-get (not apt) for script stability, and refresh package
                // lists first so installs work on stale systems.
                ("apt", "apt-get update && apt-get install -y ffmpeg")
            } else if command_exists("dnf") {
                ("dnf", "dnf install -y ffmpeg")
            } else if command_exists("pacman") {
                ("pacman", "pacman -Sy --noconfirm ffmpeg")
            } else {
                return FfmpegInstallResult {
                    status: "unsupported".to_string(),
                    message: "Unsupported Linux package manager. Install ffmpeg manually."
                        .to_string(),
                    hint_command: None,
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                };
            };

            if !allow_privileged {
                return FfmpegInstallResult {
                    status: "requires_privileged".to_string(),
                    message:
                        "Linux install needs elevated privileges. Confirm to run the install command."
                            .to_string(),
                    hint_command: Some(format!("sudo {install_cmd}")),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                };
            }

            let install_result = run_privileged_install(install_cmd);

            // Fedora's official repos do not ship ffmpeg, so a bare dnf install
            // fails on stock systems. Point dnf users at the RPM Fusion
            // enablement step when the install fails.
            let failure_hint = if pkg_manager == "dnf" {
                Some(
                    "sudo dnf install -y https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm && sudo dnf install -y ffmpeg"
                        .to_string(),
                )
            } else {
                Some(format!("sudo {install_cmd}"))
            };

            match install_result {
                Ok(Some(output)) if output.status.success() => {
                    if ffmpeg_available_fresh() {
                        FfmpegInstallResult {
                            status: "installed".to_string(),
                            message: "FFmpeg installed successfully.".to_string(),
                            hint_command: None,
                            guide_url: None,
                        }
                    } else {
                        // The exit status is not proof: a terminal
                        // emulator exits 0 when its window closes, even if
                        // the sudo prompt inside was abandoned. Let the
                        // fresh probe decide, like the Windows flow does.
                        FfmpegInstallResult {
                            status: "failed".to_string(),
                            message:
                                "The install command finished, but FFmpeg is still not detected. If a terminal opened for your sudo password, complete the install there, or run the command manually."
                                    .to_string(),
                            hint_command: Some(format!("sudo {install_cmd}")),
                            guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                        }
                    }
                }
                Ok(Some(output)) => {
                    let code = output
                        .status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "terminated by signal".to_string());
                    let detail = stderr_tail(&output.stderr);
                    let message = if detail.is_empty() {
                        format!("Linux install command failed with exit code {code}.")
                    } else {
                        format!("Linux install command failed with exit code {code}:\n{detail}")
                    };
                    FfmpegInstallResult {
                        status: "failed".to_string(),
                        message,
                        hint_command: failure_hint.clone(),
                        guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                    }
                }
                Ok(None) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: "Linux install command timed out after 10 minutes. If a terminal opened for your sudo password, finish it there and retry.".to_string(),
                    hint_command: failure_hint.clone(),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
                Err(err) => FfmpegInstallResult {
                    status: "failed".to_string(),
                    message: format!("Could not elevate privileges: {err}. Install FFmpeg manually."),
                    hint_command: Some(format!("sudo {install_cmd}")),
                    guide_url: Some("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md".to_string()),
                },
            }
        }
    })
    .await
    .unwrap_or(FfmpegInstallResult {
        status: "failed".to_string(),
        message: "Installer task crashed unexpectedly.".to_string(),
        hint_command: None,
        guide_url: None,
    })
}

#[tauri::command]
pub async fn list_ffmpeg_video_encoders() -> Result<String, String> {
    tokio::task::spawn_blocking(|| -> Result<String, String> {
        let stdout = get_or_discover_encoder_listing()?;

        let re = LIST_ENCODER_RE.get_or_init(|| {
            regex_lite::Regex::new(r"^\s*V[A-Z.]*\s+(\S+)\s+(.*)").expect("invalid regex literal")
        });
        let mut lines: Vec<String> = Vec::new();
        for line in stdout.lines() {
            if let Some(caps) = re.captures(line) {
                let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let desc = caps.get(2).map(|m| m.as_str().trim()).unwrap_or("");
                if desc.is_empty() {
                    lines.push(name.to_string());
                } else {
                    lines.push(format!("{name}  —  {desc}"));
                }
            }
        }
        if lines.is_empty() {
            Ok("No video encoders found.".to_string())
        } else {
            Ok(lines.join("\n"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_vaapi_device() -> Option<String> {
    tokio::task::spawn_blocking(crate::ffmpeg::find_vaapi_device)
        .await
        .unwrap_or(None)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::find_winget_ffmpeg_bins;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after the Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "vidcord-encoders-{label}-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("test directory should be created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn create_tool_pair(directory: &Path) {
        std::fs::create_dir_all(directory).expect("tool directory should be created");
        std::fs::write(directory.join("ffmpeg.exe"), b"test")
            .expect("ffmpeg fixture should be written");
        std::fs::write(directory.join("ffprobe.exe"), b"test")
            .expect("ffprobe fixture should be written");
    }

    #[test]
    fn finds_winget_portable_links() {
        let root = TestDirectory::new("links");
        let links = root.path().join("Links");
        create_tool_pair(&links);

        assert_eq!(
            find_winget_ffmpeg_bins(&[root.path().to_path_buf()]),
            vec![links]
        );
    }

    #[test]
    fn finds_nested_gyan_ffmpeg_package_bin() {
        let root = TestDirectory::new("package");
        let bin = root
            .path()
            .join("Packages")
            .join("Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join("ffmpeg-8.0-full_build")
            .join("bin");
        create_tool_pair(&bin);

        assert_eq!(
            find_winget_ffmpeg_bins(&[root.path().to_path_buf()]),
            vec![bin]
        );
    }

    #[test]
    fn ignores_incomplete_or_unrelated_packages() {
        let root = TestDirectory::new("invalid");
        let incomplete = root
            .path()
            .join("Packages")
            .join("Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join("ffmpeg-8.0-full_build")
            .join("bin");
        std::fs::create_dir_all(&incomplete).expect("tool directory should be created");
        std::fs::write(incomplete.join("ffmpeg.exe"), b"test")
            .expect("ffmpeg fixture should be written");
        create_tool_pair(
            &root
                .path()
                .join("Packages")
                .join("Someone.Else")
                .join("bin"),
        );

        assert!(find_winget_ffmpeg_bins(&[root.path().to_path_buf()]).is_empty());
    }

    #[test]
    fn collects_every_candidate_so_a_broken_one_cannot_shadow_a_working_one() {
        let root = TestDirectory::new("candidates");
        let older = root
            .path()
            .join("Packages")
            .join("Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join("ffmpeg-7.0-full_build")
            .join("bin");
        let newer = root
            .path()
            .join("Packages")
            .join("Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join("ffmpeg-10.0-full_build")
            .join("bin");
        create_tool_pair(&older);
        create_tool_pair(&newer);

        // Newest version-named directory first, then the older one; the
        // caller probes in this order and uses the first working pair.
        assert_eq!(
            find_winget_ffmpeg_bins(&[root.path().to_path_buf()]),
            vec![newer, older]
        );
    }
}
