#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};

#[cfg(any(target_os = "linux", test))]
fn without_appimage_library_paths(appdir: &str, library_path: &str) -> String {
    let appdir = appdir.trim_end_matches('/');
    if appdir.is_empty() {
        return library_path.to_string();
    }

    library_path
        .split(':')
        .filter(|entry| {
            *entry != appdir
                && !entry
                    .strip_prefix(appdir)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(target_os = "linux")]
fn configure_desktop_command(command: &mut Command) {
    if let (Ok(appdir), Ok(library_path)) =
        (std::env::var("APPDIR"), std::env::var("LD_LIBRARY_PATH"))
    {
        // AppRun prepends bundled libraries needed by vidcord itself. Host
        // desktop helpers must use host libraries or file managers can fail to
        // start with GLib symbol/version errors.
        let library_path = without_appimage_library_paths(&appdir, &library_path);
        command.env_remove("LD_LIBRARY_PATH");
        if !library_path.is_empty() {
            command.env("LD_LIBRARY_PATH", library_path);
        }
    }
}

/// State bucket for a file received via Apple Events or CLI args before the
/// frontend listener is registered.
pub struct PendingFile(pub std::sync::Mutex<Option<String>>);

#[tauri::command]
pub fn show_in_file_explorer(path: String) -> Result<(), String> {
    let abs = std::fs::canonicalize(&path).unwrap_or_else(|_| std::path::PathBuf::from(&path));

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // canonicalize() returns \\?\ extended-length paths on Windows, which
        // explorer.exe /select does not understand — strip the prefix.
        let path_str = abs.to_string_lossy().into_owned();
        let path_str = path_str
            .strip_prefix(r"\\?\")
            .unwrap_or(&path_str)
            .to_string();
        // Use raw_arg so Rust doesn't re-quote the combined /select,path token;
        // wrap the path in quotes ourselves to handle spaces in the path.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path_str))
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &abs.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // Use the org.freedesktop.FileManager1 DBus interface to reveal and select
        // the specific file. This works with Nautilus, Dolphin, Thunar, Nemo, etc.
        let file_uri = url::Url::from_file_path(&abs)
            .map(|u| u.to_string())
            .unwrap_or_else(|_| format!("file://{}", abs.display()));
        let mut dbus_command = Command::new("dbus-send");
        dbus_command.args([
            "--session",
            "--print-reply",
            "--dest=org.freedesktop.FileManager1",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
            &format!("array:string:{file_uri}"),
            "string:",
        ]);
        configure_desktop_command(&mut dbus_command);
        let dbus_ok = dbus_command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        if !dbus_ok {
            let parent = abs
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| abs.to_string_lossy().into_owned());
            let mut open_command = Command::new("xdg-open");
            open_command.arg(&parent);
            configure_desktop_command(&mut open_command);
            open_command.spawn().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_os() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
pub fn resolve_output_path(input_path: String) -> Result<String, String> {
    let p = std::path::Path::new(&input_path);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("video");

    let downloads = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .ok_or("Cannot find Downloads folder")?;

    std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;

    let mut candidate = downloads.join(format!("{stem}-vidcord.mp4"));
    let mut counter = 1u32;
    while candidate.exists() {
        candidate = downloads.join(format!("{stem}-vidcord-{counter}.mp4"));
        counter += 1;
    }
    Ok(candidate.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::without_appimage_library_paths;

    #[test]
    fn removes_only_appimage_library_paths() {
        assert_eq!(
            without_appimage_library_paths(
                "/tmp/.mount_vidcord",
                "/tmp/.mount_vidcord/usr/lib:/usr/local/lib:/tmp/.mount_vidcord/lib:/usr/lib",
            ),
            "/usr/local/lib:/usr/lib"
        );
    }

    #[test]
    fn does_not_remove_similarly_prefixed_host_paths() {
        assert_eq!(
            without_appimage_library_paths(
                "/tmp/.mount_vidcord",
                "/tmp/.mount_vidcord-other/lib:/usr/lib",
            ),
            "/tmp/.mount_vidcord-other/lib:/usr/lib"
        );
    }
}
