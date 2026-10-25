use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const DESKTOP_FILE_NAME: &str = "com.cyroz1.vidcord.desktop";
const INTEGRATION_MARKER: &str = "X-Vidcord-AppImage-Integration=true";

pub(crate) fn register_appimage_folder_open_with() {
    let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) else {
        return;
    };
    let appimage = match fs::canonicalize(&appimage) {
        Ok(appimage) => appimage,
        Err(error) => {
            crate::log::vidcord_log(&format!(
                "AppImage folder Open With registration skipped: could not resolve the AppImage path: {error}"
            ));
            return;
        }
    };
    if !appimage.is_file() {
        crate::log::vidcord_log(
            "AppImage folder Open With registration skipped: the AppImage path is not a file",
        );
        return;
    }

    let Some(data_directory) = dirs::data_local_dir() else {
        crate::log::vidcord_log(
            "AppImage folder Open With registration skipped: no local data directory is available",
        );
        return;
    };
    let applications_directory = data_directory.join("applications");
    if let Err(error) = fs::create_dir_all(&applications_directory) {
        crate::log::vidcord_log(&format!(
            "AppImage folder Open With registration skipped: could not create the applications directory: {error}"
        ));
        return;
    }

    let desktop_file = applications_directory.join(DESKTOP_FILE_NAME);
    let (already_registered, existing_contents) =
        registered_appimage_entry_exists(&applications_directory, &desktop_file, &appimage);
    if already_registered {
        return;
    }

    let Some(exec_path) = desktop_exec_path(&appimage) else {
        crate::log::vidcord_log(
            "AppImage folder Open With registration skipped: the AppImage path is not usable in a desktop entry",
        );
        return;
    };
    let contents = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=vidcord\n\
         GenericName=Video Compressor\n\
         Comment=Import and compress videos from a folder\n\
         Exec={exec_path} %U\n\
         Icon=video-x-generic\n\
         Terminal=false\n\
         Categories=AudioVideo;Video;\n\
         MimeType=inode/directory;\n\
         {INTEGRATION_MARKER}\n"
    );

    match write_desktop_entry(&desktop_file, &contents, existing_contents) {
        Ok(true) => refresh_desktop_database(&applications_directory),
        Ok(false) => {}
        Err(_) => crate::log::vidcord_log("Could not register the Linux folder Open With entry"),
    }
}

fn desktop_exec_path(path: &Path) -> Option<String> {
    let path = path.to_str()?;
    if path.chars().any(char::is_control) {
        return None;
    }

    let escaped = path
        .replace('%', "%%")
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$");
    Some(format!("\"{escaped}\""))
}

/// Returns whether registration can stop here, plus the current contents of
/// our own desktop file when it could be read, so the writer does not have to
/// read the same file a second time.
fn registered_appimage_entry_exists(
    applications_directory: &Path,
    desktop_file: &Path,
    appimage: &Path,
) -> (bool, Option<String>) {
    if let Ok(existing) = fs::read_to_string(desktop_file) {
        return (!existing.contains(INTEGRATION_MARKER), Some(existing));
    }

    let Ok(entries) = fs::read_dir(applications_directory) else {
        return (false, None);
    };

    let found = entries.flatten().any(|entry| {
        if entry.path() == desktop_file || entry.path().extension() != Some(OsStr::new("desktop")) {
            return false;
        }
        let Ok(contents) = fs::read_to_string(entry.path()) else {
            return false;
        };
        // The entry must actually launch THIS AppImage, not merely share
        // its file name: a same-named AppImage in another directory is a
        // different install, and an unrelated entry mentioning the name
        // must not suppress registration.
        desktop_entry_exec_program(&contents).is_some_and(|program| {
            Path::new(&program) == appimage
                && contents.lines().any(|line| {
                    line.strip_prefix("MimeType=")
                        .is_some_and(|types| types.split(';').any(|mime| mime == "inode/directory"))
                })
        })
    });
    (found, None)
}

/// The program an `Exec=` line launches: the first token, unquoted and
/// with desktop-entry backslash escapes resolved, or None when the entry
/// has no Exec line.
fn desktop_entry_exec_program(contents: &str) -> Option<String> {
    let line = contents
        .lines()
        .find_map(|line| line.strip_prefix("Exec="))?
        .trim();
    if let Some(quoted) = line.strip_prefix('"') {
        let mut program = String::new();
        let mut chars = quoted.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => break,
                '\\' => {
                    if let Some(escaped) = chars.next() {
                        program.push(escaped);
                    }
                }
                _ => program.push(c),
            }
        }
        Some(program)
    } else {
        line.split_whitespace().next().map(str::to_string)
    }
}

fn write_desktop_entry(path: &Path, contents: &str, current: Option<String>) -> io::Result<bool> {
    if current.as_deref() == Some(contents) {
        return Ok(false);
    }
    if current
        .as_deref()
        .is_some_and(|contents| !contents.contains(INTEGRATION_MARKER))
    {
        return Ok(false);
    }

    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing desktop directory"))?;
    let temporary = parent.join(format!(
        ".vidcord-{}-{}.desktop.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    if let Err(error) = file
        .write_all(contents.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    drop(file);

    if current.is_some() {
        if let Err(error) = fs::rename(&temporary, path) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    } else {
        match fs::hard_link(&temporary, path) {
            Ok(()) => {
                let _ = fs::remove_file(&temporary);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let _ = fs::remove_file(&temporary);
                return Ok(false);
            }
            Err(_) => {
                let mut destination =
                    match OpenOptions::new().write(true).create_new(true).open(path) {
                        Ok(file) => file,
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                            let _ = fs::remove_file(&temporary);
                            return Ok(false);
                        }
                        Err(error) => {
                            let _ = fs::remove_file(&temporary);
                            return Err(error);
                        }
                    };
                let mut source = match fs::File::open(&temporary) {
                    Ok(file) => file,
                    Err(error) => {
                        let _ = fs::remove_file(&temporary);
                        let _ = fs::remove_file(path);
                        return Err(error);
                    }
                };
                let copy_result =
                    io::copy(&mut source, &mut destination).and_then(|_| destination.sync_all());
                let _ = fs::remove_file(&temporary);
                if let Err(error) = copy_result {
                    let _ = fs::remove_file(path);
                    return Err(error);
                }
            }
        }
    }

    Ok(true)
}

fn refresh_desktop_database(applications_directory: &Path) {
    let applications_directory = applications_directory.to_path_buf();
    let _ = std::thread::Builder::new()
        .name("vidcord-desktop-integration".to_string())
        .spawn(move || {
            let mut command = Command::new("update-desktop-database");
            command
                .arg(applications_directory)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            crate::commands::files::configure_desktop_command(&mut command);

            let Ok(mut child) = command.spawn() else {
                return;
            };
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) if Instant::now() >= deadline => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                }
            }
        });
}
