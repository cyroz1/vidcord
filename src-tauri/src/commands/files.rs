#[cfg(target_os = "linux")]
use std::process::Stdio;

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
        let dbus_ok = std::process::Command::new("dbus-send")
            .args([
                "--session",
                "--print-reply",
                "--dest=org.freedesktop.FileManager1",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                &format!("array:string:{file_uri}"),
                "string:",
            ])
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
            std::process::Command::new("xdg-open")
                .arg(&parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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
