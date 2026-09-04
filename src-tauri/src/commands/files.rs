use std::collections::HashSet;
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::time::{Duration, Instant};

use crate::log::vidcord_log;

#[cfg(any(target_os = "linux", target_os = "macos"))]
const DESKTOP_COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
#[cfg(any(target_os = "linux", target_os = "macos"))]
const DESKTOP_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(20);

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn wait_for_desktop_child(
    mut child: std::process::Child,
) -> std::io::Result<Option<std::process::ExitStatus>> {
    let deadline = Instant::now() + DESKTOP_COMMAND_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(DESKTOP_COMMAND_POLL_INTERVAL);
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn run_desktop_command(command: &mut std::process::Command) -> std::io::Result<bool> {
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    wait_for_desktop_child(command.spawn()?).map(|status| status.is_some_and(|s| s.success()))
}

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

/// State bucket for files received via Apple Events or CLI args before the
/// frontend listener is registered.
pub struct PendingFile(pub std::sync::Mutex<Option<Vec<String>>>);

#[tauri::command]
pub async fn show_in_file_explorer(path: String) -> Result<(), String> {
    show_files_in_file_explorer(vec![path]).await
}

#[tauri::command]
pub async fn show_files_in_file_explorer(paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || show_files_in_file_explorer_blocking(paths))
        .await
        .map_err(|e| e.to_string())?
}

fn show_files_in_file_explorer_blocking(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("No output files are available to reveal.".to_string());
    }

    let files = paths
        .into_iter()
        .map(|path| std::fs::canonicalize(&path).unwrap_or_else(|_| std::path::PathBuf::from(path)))
        .collect::<Vec<_>>();

    #[cfg(target_os = "windows")]
    return show_files_in_file_explorer_windows(&files);

    #[cfg(target_os = "macos")]
    return show_files_in_file_explorer_macos(&files);

    #[cfg(target_os = "linux")]
    return show_files_in_file_explorer_linux(&files);

    #[allow(unreachable_code)]
    Err("Revealing files is not supported on this platform.".to_string())
}

#[cfg(target_os = "windows")]
struct WindowsItemIdList(*mut windows_sys::Win32::UI::Shell::Common::ITEMIDLIST);

#[cfg(target_os = "windows")]
impl Drop for WindowsItemIdList {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                windows_sys::Win32::UI::Shell::ILFree(self.0);
            }
        }
    }
}

#[cfg(target_os = "windows")]
struct WindowsComGuard {
    initialized: bool,
}

#[cfg(target_os = "windows")]
impl WindowsComGuard {
    fn initialize() -> Self {
        let initialized =
            unsafe { windows_sys::Win32::System::Com::CoInitialize(std::ptr::null()) >= 0 };
        Self { initialized }
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsComGuard {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                windows_sys::Win32::System::Com::CoUninitialize();
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn show_files_in_file_explorer_windows(files: &[std::path::PathBuf]) -> Result<(), String> {
    use std::collections::HashMap;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows_sys::Win32::UI::Shell::{ILCreateFromPathW, SHOpenFolderAndSelectItems};

    let _com = WindowsComGuard::initialize();
    let files = files
        .iter()
        .map(|file| normalize_windows_shell_path(file.as_path()))
        .collect::<Vec<_>>();
    let mut grouped = HashMap::<std::path::PathBuf, Vec<&std::path::Path>>::new();
    for file in &files {
        let parent = file.parent().ok_or_else(|| {
            format!(
                "Could not determine the output folder for {}.",
                file.display()
            )
        })?;
        grouped.entry(parent.to_path_buf()).or_default().push(file);
    }

    for (parent, files) in grouped {
        let parent_wide = parent
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let parent_item = unsafe { ILCreateFromPathW(parent_wide.as_ptr()) };
        if parent_item.is_null() {
            return Err(format!(
                "Could not open the output folder {}.",
                parent.display()
            ));
        }
        let _parent_item = WindowsItemIdList(parent_item);

        let mut item_lists = Vec::with_capacity(files.len());
        for file in files {
            let file_wide = file
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let item = unsafe { ILCreateFromPathW(file_wide.as_ptr()) };
            if item.is_null() {
                return Err(format!(
                    "Could not select the output file {}.",
                    file.display()
                ));
            }
            item_lists.push(WindowsItemIdList(item));
        }
        let item_pointers = item_lists
            .iter()
            .map(|item| item.0 as *const ITEMIDLIST)
            .collect::<Vec<_>>();
        let result = unsafe {
            SHOpenFolderAndSelectItems(
                parent_item as *const ITEMIDLIST,
                item_pointers.len() as u32,
                item_pointers.as_ptr(),
                0,
            )
        };
        if result != 0 {
            return Err(format!(
                "Could not reveal the output files in {} (HRESULT 0x{:08X}).",
                parent.display(),
                result as u32
            ));
        }
    }
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn normalize_windows_shell_path(path: &std::path::Path) -> std::path::PathBuf {
    let path = path.to_string_lossy();
    if let Some(unc_path) = path.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{unc_path}"));
    }
    if let Some(path) = path.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(path);
    }
    path.into_owned().into()
}

#[cfg(target_os = "macos")]
fn show_files_in_file_explorer_macos(files: &[std::path::PathBuf]) -> Result<(), String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSArray, NSString, NSURL};

    let urls = files
        .iter()
        .map(|file| {
            let path = NSString::from_str(&file.to_string_lossy());
            NSURL::fileURLWithPath(&path)
        })
        .collect::<Vec<_>>();
    let urls = NSArray::from_retained_slice(&urls);
    NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&urls);
    Ok(())
}

#[cfg(target_os = "linux")]
fn show_files_in_file_explorer_linux(files: &[std::path::PathBuf]) -> Result<(), String> {
    let uris = files
        .iter()
        .map(|file| {
            url::Url::from_file_path(file)
                .map(|url| url.to_string())
                .map_err(|_| format!("Could not create a file URL for {}.", file.display()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let uri_array = format!("array:string:{}", uris.join(","));

    // Use the org.freedesktop.FileManager1 DBus interface to reveal and select
    // every requested file. This works with Nautilus, Dolphin, Thunar, Nemo, etc.
    let mut dbus_command = Command::new("dbus-send");
    dbus_command.args([
        "--session",
        "--print-reply",
        "--dest=org.freedesktop.FileManager1",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1.ShowItems",
        &uri_array,
        "string:",
    ]);
    configure_desktop_command(&mut dbus_command);
    let dbus_ok = run_desktop_command(&mut dbus_command).unwrap_or(false);

    if !dbus_ok {
        let parent = files
            .first()
            .and_then(|file| file.parent())
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| files[0].to_string_lossy().into_owned());
        let mut open_command = Command::new("xdg-open");
        open_command.arg(&parent);
        configure_desktop_command(&mut open_command);
        open_command.spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn validated_clipboard_file(path: String) -> Result<std::path::PathBuf, String> {
    let file = std::fs::canonicalize(path)
        .map_err(|_| "The completed output file is no longer available.".to_string())?;
    if !file.is_file() {
        return Err("The completed output file is no longer available.".to_string());
    }
    Ok(file)
}

#[cfg(target_os = "windows")]
pub(crate) fn copy_files_to_clipboard_platform(files: &[std::path::PathBuf]) -> Result<(), String> {
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

    if files.is_empty() {
        return Err("No output files are available to copy.".to_string());
    }
    let mut wide_paths = Vec::new();
    for file in files {
        wide_paths.extend(file.as_os_str().encode_wide());
        wide_paths.push(0);
    }
    wide_paths.push(0);
    let header_size = std::mem::size_of::<DROPFILES>();
    let allocation_size = header_size + wide_paths.len() * std::mem::size_of::<u16>();

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
            wide_paths.as_ptr().cast::<u8>(),
            locked.cast::<u8>().add(header_size),
            wide_paths.len() * std::mem::size_of::<u16>(),
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

#[cfg(target_os = "windows")]
pub(crate) fn copy_file_to_clipboard_platform(file: &std::path::Path) -> Result<(), String> {
    copy_files_to_clipboard_platform(&[file.to_path_buf()])
}

#[cfg(any(target_os = "macos", test))]
fn macos_clipboard_filename(file: &std::path::Path) -> String {
    file.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| file.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
pub(crate) fn copy_files_to_clipboard_platform(files: &[std::path::PathBuf]) -> Result<(), String> {
    if files.is_empty() {
        return Err("No output files are available to copy.".to_string());
    }

    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSUTF8StringEncoding, NSURL};

    let pasteboard = NSPasteboard::generalPasteboard();
    let file_url_type = NSString::from_str("public.file-url");
    let utf8_type = NSString::from_str("public.utf8-plain-text");
    let utf16_type = NSString::from_str("public.utf16-external-plain-text");
    let filenames = files
        .iter()
        .map(|file| macos_clipboard_filename(file))
        .collect::<Vec<_>>();
    let combined_filenames = filenames.join("\r");
    let mut items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> =
        Vec::with_capacity(files.len());

    for (index, file) in files.iter().enumerate() {
        let url = NSURL::from_file_path(file)
            .ok_or_else(|| "Could not create a file URL for the clipboard.".to_string())?;
        let file_reference_url = url.fileReferenceURL().ok_or_else(|| {
            "Could not create a file reference URL for the clipboard.".to_string()
        })?;
        let file_reference = file_reference_url.absoluteString().ok_or_else(|| {
            "Could not read the file reference URL for the clipboard.".to_string()
        })?;
        let file_url_data = file_reference
            .dataUsingEncoding(NSUTF8StringEncoding)
            .ok_or_else(|| "Could not encode the file URL for the clipboard.".to_string())?;
        let item = NSPasteboardItem::new();
        if !item.setData_forType(&file_url_data, &file_url_type) {
            return Err("Could not prepare the file URL for the clipboard.".to_string());
        }
        if index == 0 {
            let names = NSString::from_str(&combined_filenames);
            if !item.setString_forType(&names, &utf8_type)
                || !item.setString_forType(&names, &utf16_type)
            {
                return Err("Could not prepare the file names for the clipboard.".to_string());
            }
        }
        items.push(ProtocolObject::from_retained(item));
    }

    pasteboard.clearContents();
    let items = NSArray::from_retained_slice(&items);
    if !pasteboard.writeObjects(&items) {
        return Err("Could not copy the files to the system clipboard.".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn copy_file_to_clipboard_platform(file: &std::path::Path) -> Result<(), String> {
    copy_files_to_clipboard_platform(&[file.to_path_buf()])
}

#[cfg(target_os = "linux")]
pub(crate) fn copy_files_to_clipboard_platform(files: &[std::path::PathBuf]) -> Result<(), String> {
    use std::io::Write;

    if files.is_empty() {
        return Err("No output files are available to copy.".to_string());
    }

    let uris = files
        .iter()
        .map(|file| {
            url::Url::from_file_path(file)
                .map(|url| url.to_string())
                .map_err(|_| "Could not create a clipboard file URL.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let uri_list = format!("{}\r\n", uris.join("\r\n"));

    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        let mut command = Command::new("wl-copy");
        command
            .args(["--type", "text/uri-list", "--"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_desktop_command(&mut command);
        if let Ok(mut child) = command.spawn() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(uri_list.as_bytes());
            }
            if wait_for_desktop_child(child)
                .is_ok_and(|status| status.is_some_and(|status| status.success()))
            {
                return Ok(());
            }
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
            let _ = stdin.write_all(uri_list.as_bytes());
        }
        if wait_for_desktop_child(child)
            .is_ok_and(|status| status.is_some_and(|status| status.success()))
        {
            return Ok(());
        }
    }

    Err(
        "Copying files requires wl-clipboard on Wayland or xclip on X11. The output file was still saved."
            .to_string(),
    )
}

#[cfg(target_os = "linux")]
pub(crate) fn copy_file_to_clipboard_platform(file: &std::path::Path) -> Result<(), String> {
    copy_files_to_clipboard_platform(&[file.to_path_buf()])
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
pub async fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let files = paths
            .into_iter()
            .map(validated_clipboard_file)
            .collect::<Result<Vec<_>, _>>()?;
        copy_files_to_clipboard_platform(&files)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_os() -> &'static str {
    std::env::consts::OS
}

fn deliver_notification_if_unfocused<F>(is_focused: bool, deliver: F) -> Result<bool, String>
where
    F: FnOnce() -> Result<(), String>,
{
    if is_focused {
        return Ok(false);
    }
    deliver()?;
    Ok(true)
}

fn notification_response_requests_focus(response: &notify_rust::NotificationResponse) -> bool {
    matches!(response, notify_rust::NotificationResponse::Default)
        || matches!(
            response,
            notify_rust::NotificationResponse::Action(action) if action == "default"
        )
}

#[cfg(any(target_os = "macos", test))]
fn macos_notification_arguments(title: &str, body: &str) -> Vec<String> {
    vec![
        "-e".to_string(),
        "on run argv".to_string(),
        "-e".to_string(),
        "display notification (item 2 of argv) with title (item 1 of argv)".to_string(),
        "-e".to_string(),
        "end run".to_string(),
        "--".to_string(),
        title.to_string(),
        body.to_string(),
    ]
}

#[cfg(target_os = "macos")]
fn deliver_unbundled_macos_notification(title: &str, body: &str) -> Result<(), String> {
    let mut command = std::process::Command::new("osascript");
    command.args(macos_notification_arguments(title, body));
    match run_desktop_command(&mut command) {
        Ok(true) => Ok(()),
        Ok(false) => Err(
            "macOS rejected the development notification or notification delivery timed out."
                .to_string(),
        ),
        Err(error) => Err(format!(
            "Could not start the macOS development notification service: {error}"
        )),
    }
}

fn focus_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window is unavailable".to_string())?;
    window
        .show()
        .map_err(|error| format!("could not show the main window: {error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("could not restore the main window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("could not focus the main window: {error}"))
}

fn listen_for_notification_activation<F>(listener: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    std::thread::Builder::new()
        .name("vidcord-notification-response".to_string())
        .spawn(move || {
            if let Err(error) = listener() {
                vidcord_log(&format!(
                    "System notification response listener failed: {error}"
                ));
            }
        })
        .map(|_| ())
        .map_err(|error| {
            format!("Could not start the system notification response listener: {error}")
        })
}

#[cfg(target_os = "macos")]
fn authorize_macos_notifications() -> Result<(), String> {
    match notify_rust::request_auth_blocking() {
        Ok(true) => Ok(()),
        Ok(false) => Err("macOS notification permission was denied.".to_string()),
        Err(error) => Err(format!(
            "macOS notification permission is unavailable: {error}"
        )),
    }
}

#[cfg(not(target_os = "macos"))]
fn authorize_macos_notifications() -> Result<(), String> {
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn escape_xdg_notification_markup(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(any(target_os = "windows", test))]
fn is_cargo_target_profile_directory(directory: &std::path::Path) -> bool {
    let is_profile = directory
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "debug" || name == "release");
    is_profile
        && directory
            .ancestors()
            .skip(1)
            .any(|ancestor| ancestor.file_name().is_some_and(|name| name == "target"))
}

fn deliver_platform_notification(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if notify_rust::check_bundle().is_err() {
        // `tauri dev` launches the executable outside a .app bundle, which
        // UNUserNotificationCenter rejects before it can request permission.
        return deliver_unbundled_macos_notification(title, body);
    }

    authorize_macos_notifications()?;

    let mut notification = notify_rust::Notification::new();
    notification.appname("vidcord").summary(title).auto_icon();

    #[cfg(target_os = "macos")]
    notification
        .body(body)
        // macOS does not resolve "Clear All" responses, so bound the
        // activation listener rather than retaining it indefinitely.
        .timeout(std::time::Duration::from_secs(60 * 60));

    #[cfg(target_os = "linux")]
    notification
        .body(&escape_xdg_notification_markup(body))
        .action("default", "Open vidcord");

    #[cfg(target_os = "windows")]
    {
        notification.body(body);
        if let Ok(executable) = tauri::utils::platform::current_exe() {
            if let Some(directory) = executable.parent() {
                if !is_cargo_target_profile_directory(directory) {
                    notification.app_id(&app.config().identifier);
                }
            }
        }
    }

    let handle = notification.show().map_err(|error| {
        format!("The system notification service rejected the message: {error}")
    })?;
    let response_app = app.clone();
    listen_for_notification_activation(move || {
        handle
            .wait_for_response(|response: &notify_rust::NotificationResponse| {
                if notification_response_requests_focus(response) {
                    if let Err(error) = focus_main_window(&response_app) {
                        vidcord_log(&format!(
                            "System notification activation could not focus vidcord: {error}"
                        ));
                    }
                }
            })
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
pub async fn send_system_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<bool, String> {
    let result =
        tokio::task::spawn_blocking(move || send_system_notification_blocking(&app, &title, &body))
            .await
            .map_err(|error| error.to_string())?;

    if let Err(error) = &result {
        vidcord_log(&format!("System notification delivery failed: {error}"));
    }
    result
}

fn send_system_notification_blocking(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
) -> Result<bool, String> {
    use tauri::Manager;
    let is_focused = app
        .get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    deliver_notification_if_unfocused(is_focused, || {
        deliver_platform_notification(app, title, body)
    })
}

#[tauri::command]
pub async fn resolve_output_path(
    input_path: String,
    output_directory: Option<String>,
    use_input_directory: Option<bool>,
    output_extension: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        resolve_output_path_blocking(
            input_path,
            output_directory,
            use_input_directory,
            output_extension,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn resolve_batch_output_paths(
    input_paths: Vec<String>,
    output_directory: Option<String>,
    use_input_directory: Option<bool>,
    staging: Option<bool>,
    output_extension: Option<String>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let output_extension = output_extension.unwrap_or_else(|| "mp4".into());
        if output_extension != "mp4" {
            return Err("Invalid output format".into());
        }

        let staging = staging.unwrap_or(false);
        let staging_path = if staging {
            let directory = staging_directory();
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            Some(directory)
        } else {
            None
        };
        let mut reserved = HashSet::new();
        let mut outputs = Vec::with_capacity(input_paths.len());
        for input_path in input_paths {
            let input = std::path::PathBuf::from(&input_path);
            let directory = if let Some(staging_path) = staging_path.as_ref() {
                staging_path.clone()
            } else if use_input_directory.unwrap_or(false) {
                input
                    .parent()
                    .filter(|directory| directory.is_dir())
                    .ok_or_else(|| {
                        "The imported clip's folder is no longer available.".to_string()
                    })?
                    .to_path_buf()
            } else if let Some(directory) = output_directory
                .as_deref()
                .filter(|path| !path.trim().is_empty())
            {
                let directory = std::path::PathBuf::from(directory);
                if !directory.is_dir() {
                    return Err(
                        "The custom output folder is no longer available. Choose it again.".into(),
                    );
                }
                directory
            } else {
                let downloads = dirs::download_dir()
                    .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
                    .ok_or("Cannot find Downloads folder")?;
                std::fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
                downloads
            };

            let output =
                unique_output_path_with_reserved(&input, &directory, &output_extension, &reserved);
            reserved.insert(output.clone());
            outputs.push(output.to_string_lossy().into_owned());
        }
        Ok(outputs)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn unique_output_path(
    input_path: &std::path::Path,
    directory: &std::path::Path,
    output_extension: &str,
) -> std::path::PathBuf {
    let stem = input_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");

    let suffix = if output_extension == "png" {
        "snapshot"
    } else {
        "vidcord"
    };

    let mut candidate = directory.join(format!("{stem}-{suffix}.{output_extension}"));
    let mut counter = 1u32;
    while candidate.exists() {
        candidate = directory.join(format!("{stem}-{suffix}-{counter}.{output_extension}"));
        counter += 1;
    }
    candidate
}

fn unique_output_path_with_reserved(
    input_path: &std::path::Path,
    directory: &std::path::Path,
    output_extension: &str,
    reserved: &HashSet<std::path::PathBuf>,
) -> std::path::PathBuf {
    let stem = input_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let suffix = if output_extension == "png" {
        "snapshot"
    } else {
        "vidcord"
    };

    let mut candidate = directory.join(format!("{stem}-{suffix}.{output_extension}"));
    let mut counter = 1u32;
    while candidate.exists()
        || reserved
            .iter()
            .any(|path| output_path_key(path) == output_path_key(&candidate))
    {
        candidate = directory.join(format!("{stem}-{suffix}-{counter}.{output_extension}"));
        counter += 1;
    }
    candidate
}

fn output_path_key(path: &std::path::Path) -> String {
    #[cfg(target_os = "windows")]
    {
        path.to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase()
    }
    #[cfg(target_os = "macos")]
    {
        path.to_string_lossy().to_ascii_lowercase()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        path.to_string_lossy().into_owned()
    }
}

fn valid_output_extension(extension: &str) -> bool {
    matches!(
        extension,
        "mp4" | "mov" | "mkv" | "webm" | "avi" | "flv" | "wmv" | "gif" | "png"
    )
}

fn resolve_output_path_blocking(
    input_path: String,
    output_directory: Option<String>,
    use_input_directory: Option<bool>,
    output_extension: Option<String>,
) -> Result<String, String> {
    let output_extension = output_extension.unwrap_or_else(|| "mp4".into());
    if !valid_output_extension(&output_extension) {
        return Err("Invalid output format".into());
    }
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

    Ok(unique_output_path(p, &directory, &output_extension)
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
pub async fn resolve_staging_output_path(
    input_path: String,
    output_extension: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output_extension = output_extension.unwrap_or_else(|| "mp4".into());
        if !valid_output_extension(&output_extension) || output_extension == "png" {
            return Err("Invalid output format".into());
        }
        let staging = staging_directory();
        std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        Ok(unique_output_path(
            std::path::Path::new(&input_path),
            &staging,
            &output_extension,
        )
        .to_string_lossy()
        .into_owned())
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
        publish_to_temporary(&staged, &temp_path)?;
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

fn copy_file_to_new_destination(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let mut destination_file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "The selected output filename is already in use.".to_string()
            } else {
                error.to_string()
            }
        })?;

    let result = (|| -> Result<(), String> {
        let mut source_file = std::fs::File::open(source).map_err(|error| error.to_string())?;
        std::io::copy(&mut source_file, &mut destination_file)
            .map_err(|error| error.to_string())?;
        use std::io::Write;
        destination_file
            .flush()
            .and_then(|_| destination_file.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    drop(destination_file);
    if result.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    result
}

fn publish_staged_output_without_replacing_blocking(
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

    let mut temp_path = parent.join(format!(
        ".{file_name}.vidcord-batch-{}.tmp",
        std::process::id()
    ));
    let mut suffix = 1u32;
    while temp_path.exists() {
        temp_path = parent.join(format!(
            ".{file_name}.vidcord-batch-{}-{suffix}.tmp",
            std::process::id()
        ));
        suffix += 1;
    }

    let publish_result = (|| -> Result<(), String> {
        publish_to_temporary(&staged, &temp_path)?;
        match std::fs::hard_link(&temp_path, &destination) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err("The selected output filename is already in use.".to_string());
            }
            Err(_) => copy_file_to_new_destination(&temp_path, &destination)?,
        }
        std::fs::remove_file(&temp_path).map_err(|error| error.to_string())?;
        std::fs::remove_file(&staged).map_err(|error| error.to_string())?;
        Ok(())
    })();

    if publish_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    publish_result?;
    Ok(destination.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
pub struct BatchPublicationPayload {
    pub published_paths: Vec<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn publish_batch_staged_outputs(
    staged_paths: Vec<String>,
    destination_paths: Vec<String>,
) -> Result<BatchPublicationPayload, String> {
    if staged_paths.len() != destination_paths.len() {
        return Err("Batch staged outputs and destinations must have the same length.".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let mut published_paths = Vec::with_capacity(staged_paths.len());
        for (index, (staged_path, destination_path)) in
            staged_paths.into_iter().zip(destination_paths).enumerate()
        {
            match publish_staged_output_without_replacing_blocking(staged_path, destination_path) {
                Ok(path) => published_paths.push(path),
                Err(error) => {
                    return Ok(BatchPublicationPayload {
                        published_paths,
                        error: Some(format!("Output {} could not be saved: {error}", index + 1)),
                    });
                }
            }
        }
        Ok(BatchPublicationPayload {
            published_paths,
            error: None,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn publish_to_temporary(
    staged: &std::path::Path,
    temporary_path: &std::path::Path,
) -> Result<bool, String> {
    if std::fs::hard_link(staged, temporary_path).is_ok() {
        std::fs::OpenOptions::new()
            .write(true)
            .open(temporary_path)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
        return Ok(true);
    }

    let mut source = std::fs::File::open(staged).map_err(|error| error.to_string())?;
    let mut temporary = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(temporary_path)
        .map_err(|error| error.to_string())?;
    std::io::copy(&mut source, &mut temporary).map_err(|error| error.to_string())?;
    use std::io::Write;
    temporary.flush().map_err(|error| error.to_string())?;
    temporary.sync_all().map_err(|error| error.to_string())?;
    Ok(false)
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
        deliver_notification_if_unfocused, escape_xdg_notification_markup,
        is_cargo_target_profile_directory, macos_clipboard_filename, macos_notification_arguments,
        normalize_windows_shell_path, notification_response_requests_focus, output_path_key,
        publish_staged_output_blocking, publish_staged_output_without_replacing_blocking,
        publish_to_temporary, resolve_output_path_blocking, staging_directory, unique_output_path,
        unique_output_path_with_reserved, validated_clipboard_file, without_appimage_library_paths,
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
            unique_output_path(input, &directory, "mp4"),
            directory.join("holiday-vidcord-1.mp4")
        );
        assert_eq!(std::fs::read(&first).unwrap(), b"existing");
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn batch_output_paths_reserve_duplicate_stems_in_memory() {
        let directory = std::env::temp_dir().join(format!(
            "vidcord_batch_output_path_test_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let mut reserved = std::collections::HashSet::new();
        let input = std::path::Path::new("holiday.mov");

        let first = unique_output_path_with_reserved(input, &directory, "mp4", &reserved);
        reserved.insert(first.clone());
        let second = unique_output_path_with_reserved(input, &directory, "mp4", &reserved);

        assert_eq!(first, directory.join("holiday-vidcord.mp4"));
        assert_eq!(second, directory.join("holiday-vidcord-1.mp4"));
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn batch_output_path_case_collision_matches_filesystem_conventions() {
        let directory = std::env::temp_dir().join(format!(
            "vidcord_batch_case_output_path_test_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let mut reserved = std::collections::HashSet::new();
        let first = directory.join("Holiday-vidcord.mp4");
        reserved.insert(first.clone());

        let second = unique_output_path_with_reserved(
            std::path::Path::new("holiday.mov"),
            &directory,
            "mp4",
            &reserved,
        );

        if cfg!(any(target_os = "windows", target_os = "macos")) {
            assert_eq!(second, directory.join("holiday-vidcord-1.mp4"));
        } else {
            assert_eq!(second, directory.join("holiday-vidcord.mp4"));
        }
        let case_variant = directory.join("holiday-vidcord.mp4");
        if cfg!(any(target_os = "windows", target_os = "macos")) {
            assert_eq!(output_path_key(&first), output_path_key(&case_variant));
        } else {
            assert_ne!(output_path_key(&first), output_path_key(&case_variant));
        }
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn source_destination_uses_the_imported_clips_directory() {
        let directory =
            std::env::temp_dir().join(format!("vidcord_source_output_test_{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let input = directory.join("source.mov");
        std::fs::write(&input, b"video").unwrap();

        let output = resolve_output_path_blocking(
            input.to_string_lossy().into_owned(),
            None,
            Some(true),
            Some("mp4".into()),
        )
        .unwrap();

        assert_eq!(
            std::path::Path::new(&output).parent(),
            Some(directory.as_path())
        );
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn gif_output_path_uses_gif_extension() {
        let directory = std::env::temp_dir().join(format!(
            "vidcord_gif_output_path_test_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();

        assert_eq!(
            unique_output_path(std::path::Path::new("clip.mov"), &directory, "gif"),
            directory.join("clip-vidcord.gif")
        );
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn snapshot_output_path_uses_snapshot_suffix_and_png_extension() {
        let directory = std::env::temp_dir().join(format!(
            "vidcord_snapshot_output_path_test_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();

        assert_eq!(
            unique_output_path(std::path::Path::new("clip.mov"), &directory, "png"),
            directory.join("clip-snapshot.png")
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

    #[test]
    fn batch_staged_output_never_replaces_an_existing_destination() {
        let staging = staging_directory();
        std::fs::create_dir_all(&staging).unwrap();
        let staged = staging.join(format!(
            "publish-batch-collision-{}.mp4",
            std::process::id()
        ));
        std::fs::write(&staged, b"compressed-video").unwrap();

        let destination_dir = std::env::temp_dir().join(format!(
            "vidcord_publish_batch_collision_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&destination_dir).unwrap();
        let destination = destination_dir.join("saved.mp4");
        std::fs::write(&destination, b"existing").unwrap();

        assert!(publish_staged_output_without_replacing_blocking(
            staged.to_string_lossy().into_owned(),
            destination.to_string_lossy().into_owned(),
        )
        .is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"existing");
        assert!(staged.exists());

        std::fs::remove_file(staged).ok();
        std::fs::remove_dir_all(destination_dir).ok();
    }

    #[test]
    fn staged_output_uses_a_same_filesystem_hard_link_when_available() {
        let directory =
            std::env::temp_dir().join(format!("vidcord_publish_link_test_{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let staged = directory.join("staged.mp4");
        let temporary = directory.join("temporary.mp4");
        std::fs::write(&staged, b"compressed-video").unwrap();

        assert!(publish_to_temporary(&staged, &temporary).unwrap());
        assert_eq!(std::fs::read(&temporary).unwrap(), b"compressed-video");

        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn focused_window_suppresses_system_notification_delivery() {
        let mut delivered = false;
        let result = deliver_notification_if_unfocused(true, || {
            delivered = true;
            Ok(())
        })
        .unwrap();

        assert!(!result);
        assert!(!delivered);
    }

    #[test]
    fn unfocused_window_propagates_notification_delivery_result() {
        assert!(deliver_notification_if_unfocused(false, || Ok(())).unwrap());
        assert_eq!(
            deliver_notification_if_unfocused(false, || Err("service unavailable".to_string())),
            Err("service unavailable".to_string())
        );
    }

    #[test]
    fn notification_activation_focuses_only_for_the_default_action() {
        use notify_rust::{CloseReason, NotificationResponse};

        assert!(notification_response_requests_focus(
            &NotificationResponse::Default
        ));
        assert!(notification_response_requests_focus(
            &NotificationResponse::Action("default".to_string())
        ));
        assert!(!notification_response_requests_focus(
            &NotificationResponse::Action("other".to_string())
        ));
        assert!(!notification_response_requests_focus(
            &NotificationResponse::Closed(CloseReason::Dismissed)
        ));
    }

    #[test]
    fn macos_development_notification_values_are_passed_as_data_arguments() {
        let title = "Compression \"Complete\"";
        let body = "Saved C:\\clips\\one.mp4\nReady.";
        let args = macos_notification_arguments(title, body);

        assert_eq!(args[7], title);
        assert_eq!(args[8], body);
        assert!(!args[3].contains(title));
        assert!(!args[3].contains(body));
    }

    #[test]
    fn macos_clipboard_filenames_preserve_each_file_item_name() {
        let files = [
            std::path::PathBuf::from("/tmp/clip one.mp4"),
            std::path::PathBuf::from("/tmp/clip-two.mp4"),
        ];
        let names = files
            .iter()
            .map(|file| macos_clipboard_filename(file))
            .collect::<Vec<_>>();
        assert_eq!(names.join("\r"), "clip one.mp4\rclip-two.mp4");
    }

    #[test]
    fn linux_notification_body_preserves_markup_as_visible_text() {
        assert_eq!(
            escape_xdg_notification_markup("Failed <clip> & retry"),
            "Failed &lt;clip&gt; &amp; retry"
        );
    }

    #[test]
    fn windows_notification_uses_fallback_identity_in_cargo_builds() {
        assert!(is_cargo_target_profile_directory(std::path::Path::new(
            "/project/target/debug"
        )));
        assert!(is_cargo_target_profile_directory(std::path::Path::new(
            "/project/target/x86_64-pc-windows-msvc/release"
        )));
        assert!(!is_cargo_target_profile_directory(std::path::Path::new(
            "/Applications/vidcord"
        )));
    }

    #[test]
    fn windows_shell_paths_remove_extended_length_drive_prefixes() {
        assert_eq!(
            normalize_windows_shell_path(std::path::Path::new(
                r"\\?\C:\Users\andy\Videos\clip-vidcord.mp4"
            )),
            std::path::PathBuf::from(r"C:\Users\andy\Videos\clip-vidcord.mp4")
        );
    }

    #[test]
    fn windows_shell_paths_convert_extended_length_unc_prefixes() {
        assert_eq!(
            normalize_windows_shell_path(std::path::Path::new(
                r"\\?\UNC\server\share\clip-vidcord.mp4"
            )),
            std::path::PathBuf::from(r"\\server\share\clip-vidcord.mp4")
        );
    }

    #[test]
    fn windows_shell_paths_leave_normal_paths_unchanged() {
        let path = std::path::Path::new(r"D:\Videos\clip-vidcord.mp4");
        assert_eq!(normalize_windows_shell_path(path), path);
    }
}
