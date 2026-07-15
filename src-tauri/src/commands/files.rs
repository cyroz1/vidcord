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
pub async fn show_in_file_explorer(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || show_in_file_explorer_blocking(path))
        .await
        .map_err(|e| e.to_string())?
}

fn show_in_file_explorer_blocking(path: String) -> Result<(), String> {
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

fn validated_clipboard_file(path: String) -> Result<std::path::PathBuf, String> {
    let file = std::fs::canonicalize(path)
        .map_err(|_| "The completed output file is no longer available.".to_string())?;
    if !file.is_file() {
        return Err("The completed output file is no longer available.".to_string());
    }
    Ok(file)
}

#[cfg(target_os = "windows")]
fn copy_file_to_clipboard_platform(file: &std::path::Path) -> Result<(), String> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{GlobalFree, POINT};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Ole::CF_HDROP;
    use windows_sys::Win32::UI::Shell::DROPFILES;

    let wide_path: Vec<u16> = file
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .chain(once(0))
        .collect();
    let header_size = std::mem::size_of::<DROPFILES>();
    let allocation_size = header_size + wide_path.len() * std::mem::size_of::<u16>();

    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, allocation_size);
        if memory.is_null() {
            return Err(format!(
                "Could not allocate clipboard data: {}",
                std::io::Error::last_os_error()
            ));
        }

        let locked = GlobalLock(memory);
        if locked.is_null() {
            let error = std::io::Error::last_os_error();
            GlobalFree(memory);
            return Err(format!("Could not prepare clipboard data: {error}"));
        }

        let header = DROPFILES {
            pFiles: header_size as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: 0,
            fWide: 1,
        };
        std::ptr::copy_nonoverlapping(
            (&header as *const DROPFILES).cast::<u8>(),
            locked.cast::<u8>(),
            header_size,
        );
        std::ptr::copy_nonoverlapping(
            wide_path.as_ptr().cast::<u8>(),
            locked.cast::<u8>().add(header_size),
            wide_path.len() * std::mem::size_of::<u16>(),
        );
        GlobalUnlock(memory);

        let mut opened = false;
        for _ in 0..5 {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if !opened {
            let error = std::io::Error::last_os_error();
            GlobalFree(memory);
            return Err(format!("Could not open the system clipboard: {error}"));
        }

        if EmptyClipboard() == 0 {
            let error = std::io::Error::last_os_error();
            CloseClipboard();
            GlobalFree(memory);
            return Err(format!("Could not clear the system clipboard: {error}"));
        }

        if SetClipboardData(CF_HDROP as u32, memory).is_null() {
            let error = std::io::Error::last_os_error();
            CloseClipboard();
            GlobalFree(memory);
            return Err(format!("Could not copy the file to the clipboard: {error}"));
        }

        // SetClipboardData owns the allocation after a successful call.
        CloseClipboard();
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_file_to_clipboard_platform(file: &std::path::Path) -> Result<(), String> {
    let status = std::process::Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "set the clipboard to (POSIX file (item 1 of argv))",
            "-e",
            "end run",
            "--",
        ])
        .arg(file)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("Could not access the system clipboard: {e}"))?;
    if !status.success() {
        return Err("Could not copy the file to the system clipboard.".to_string());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn copy_file_to_clipboard_platform(file: &std::path::Path) -> Result<(), String> {
    use std::io::Write;

    let uri = url::Url::from_file_path(file)
        .map_err(|_| "Could not create a clipboard file URL.".to_string())?
        .to_string();

    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        let mut command = Command::new("wl-copy");
        command
            .args(["--type", "text/uri-list", "--", &uri])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_desktop_command(&mut command);
        if command.status().is_ok_and(|status| status.success()) {
            return Ok(());
        }
    }

    let mut command = Command::new("xclip");
    command
        .args(["-selection", "clipboard", "-t", "text/uri-list", "-i"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_desktop_command(&mut command);
    if let Ok(mut child) = command.spawn() {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(format!("{uri}\r\n").as_bytes());
        }
        if child.wait().is_ok_and(|status| status.success()) {
            return Ok(());
        }
    }

    Err(
        "Copying files requires wl-clipboard on Wayland or xclip on X11. The output file was still saved."
            .to_string(),
    )
}

#[tauri::command]
pub async fn copy_file_to_clipboard(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let file = validated_clipboard_file(path)?;
        copy_file_to_clipboard_platform(&file)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_os() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
pub async fn resolve_output_path(
    input_path: String,
    output_directory: Option<String>,
    use_input_directory: Option<bool>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        resolve_output_path_blocking(input_path, output_directory, use_input_directory)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn unique_output_path(
    input_path: &std::path::Path,
    directory: &std::path::Path,
) -> std::path::PathBuf {
    let stem = input_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");

    let mut candidate = directory.join(format!("{stem}-vidcord.mp4"));
    let mut counter = 1u32;
    while candidate.exists() {
        candidate = directory.join(format!("{stem}-vidcord-{counter}.mp4"));
        counter += 1;
    }
    candidate
}

fn resolve_output_path_blocking(
    input_path: String,
    output_directory: Option<String>,
    use_input_directory: Option<bool>,
) -> Result<String, String> {
    let p = std::path::Path::new(&input_path);
    let directory = if use_input_directory.unwrap_or(false) {
        p.parent()
            .filter(|directory| directory.is_dir())
            .ok_or_else(|| "The imported clip's folder is no longer available.".to_string())?
            .to_path_buf()
    } else if let Some(directory) = output_directory.filter(|path| !path.trim().is_empty()) {
        let directory = std::path::PathBuf::from(directory);
        if !directory.is_dir() {
            return Err("The custom output folder is no longer available. Choose it again.".into());
        }
        directory
    } else {
        let downloads = dirs::download_dir()
            .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
            .ok_or("Cannot find Downloads folder")?;
        std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
        downloads
    };

    Ok(unique_output_path(p, &directory)
        .to_string_lossy()
        .into_owned())
}

fn staging_directory() -> std::path::PathBuf {
    std::env::temp_dir().join("vidcord").join("staged-output")
}

fn validated_staged_output(path: &str) -> Result<std::path::PathBuf, String> {
    let staging = std::fs::canonicalize(staging_directory())
        .map_err(|_| "The temporary output folder is unavailable.".to_string())?;
    let staged = std::fs::canonicalize(path)
        .map_err(|_| "The temporary output file is unavailable.".to_string())?;
    if staged.parent() != Some(staging.as_path()) || !staged.is_file() {
        return Err("Invalid temporary output file.".to_string());
    }
    Ok(staged)
}

#[tauri::command]
pub async fn resolve_staging_output_path(input_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let staging = staging_directory();
        std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        Ok(
            unique_output_path(std::path::Path::new(&input_path), &staging)
                .to_string_lossy()
                .into_owned(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn publish_staged_output_blocking(
    staged_path: String,
    destination_path: String,
) -> Result<String, String> {
    let staged = validated_staged_output(&staged_path)?;
    let destination = std::path::PathBuf::from(destination_path);
    let parent = destination
        .parent()
        .filter(|path| path.is_dir())
        .ok_or_else(|| "The selected output folder is unavailable.".to_string())?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Choose a valid output filename.".to_string())?;

    let mut temp_path = parent.join(format!(".{file_name}.vidcord-{}.tmp", std::process::id()));
    let mut suffix = 1u32;
    while temp_path.exists() {
        temp_path = parent.join(format!(
            ".{file_name}.vidcord-{}-{suffix}.tmp",
            std::process::id()
        ));
        suffix += 1;
    }

    let publish_result = (|| -> Result<(), String> {
        let mut source = std::fs::File::open(&staged).map_err(|e| e.to_string())?;
        let mut temporary = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut source, &mut temporary).map_err(|e| e.to_string())?;
        use std::io::Write;
        temporary.flush().map_err(|e| e.to_string())?;
        temporary.sync_all().map_err(|e| e.to_string())?;
        drop(temporary);
        crate::settings::replace_file(&temp_path, &destination).map_err(|e| e.to_string())?;
        std::fs::remove_file(&staged).map_err(|e| e.to_string())?;
        Ok(())
    })();

    if publish_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    publish_result?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn publish_staged_output(
    staged_path: String,
    destination_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        publish_staged_output_blocking(staged_path, destination_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn discard_staged_output(staged_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let staged = validated_staged_output(&staged_path)?;
        std::fs::remove_file(staged).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        publish_staged_output_blocking, resolve_output_path_blocking, staging_directory,
        unique_output_path, validated_clipboard_file, without_appimage_library_paths,
    };

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

    #[test]
    fn output_path_increments_without_replacing_an_existing_file() {
        let directory =
            std::env::temp_dir().join(format!("vidcord_output_path_test_{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let input = std::path::Path::new("holiday.mov");
        let first = directory.join("holiday-vidcord.mp4");
        std::fs::write(&first, b"existing").unwrap();

        assert_eq!(
            unique_output_path(input, &directory),
            directory.join("holiday-vidcord-1.mp4")
        );
        assert_eq!(std::fs::read(&first).unwrap(), b"existing");
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn source_destination_uses_the_imported_clips_directory() {
        let directory =
            std::env::temp_dir().join(format!("vidcord_source_output_test_{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let input = directory.join("source.mov");
        std::fs::write(&input, b"video").unwrap();

        let output =
            resolve_output_path_blocking(input.to_string_lossy().into_owned(), None, Some(true))
                .unwrap();

        assert_eq!(
            std::path::Path::new(&output).parent(),
            Some(directory.as_path())
        );
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn clipboard_file_validation_rejects_directories() {
        let directory =
            std::env::temp_dir().join(format!("vidcord_clipboard_test_{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();

        assert!(validated_clipboard_file(directory.to_string_lossy().into_owned()).is_err());
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn staged_output_is_published_and_removed_from_staging() {
        let staging = staging_directory();
        std::fs::create_dir_all(&staging).unwrap();
        let staged = staging.join(format!("publish-test-{}.mp4", std::process::id()));
        std::fs::write(&staged, b"compressed-video").unwrap();

        let destination_dir =
            std::env::temp_dir().join(format!("vidcord_publish_test_{}", std::process::id()));
        std::fs::create_dir_all(&destination_dir).unwrap();
        let destination = destination_dir.join("saved.mp4");

        let published = publish_staged_output_blocking(
            staged.to_string_lossy().into_owned(),
            destination.to_string_lossy().into_owned(),
        )
        .unwrap();

        assert_eq!(published, destination.to_string_lossy());
        assert_eq!(std::fs::read(&destination).unwrap(), b"compressed-video");
        assert!(!staged.exists());
        std::fs::remove_dir_all(destination_dir).ok();
    }
}
