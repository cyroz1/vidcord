//! Original-file delivery for WebKitGTK, whose media backend rejects custom URI schemes.
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ring::rand::{SecureRandom, SystemRandom};
use tauri::Manager;

const MAX_PREVIEW_SOURCES: usize = 16;

/// A registered preview file. The canonical path was scope-checked at
/// prepare time; the stored device/inode pair lets `serve()` verify that the
/// path still names the same file before opening it, so a later symlink swap
/// cannot redirect the server to an out-of-scope target.
#[derive(Clone)]
struct PreviewSource {
    path: PathBuf,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    inserted: u64,
}

#[derive(Default)]
struct SourceTable {
    entries: HashMap<String, PreviewSource>,
    next_inserted: u64,
}

struct Server {
    port: u16,
    host: String,
    sources: Arc<Mutex<SourceTable>>,
    /// Set by the accept thread for its whole lifetime (cleared by a drop
    /// guard, so a panic clears it too). A cached server whose accept thread
    /// is gone must not keep handing out URLs for a dead port.
    alive: Arc<AtomicBool>,
}

impl Server {
    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }
}

/// Clears the server's liveness flag when the accept thread exits or panics.
struct AcceptAliveGuard(Arc<AtomicBool>);

impl Drop for AcceptAliveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Owns one request-concurrency slot: dropping it (including while unwinding
/// a panic inside `serve()`) returns the slot, so a panic cannot leak one of
/// the eight slots permanently.
struct ActiveRequestGuard(Arc<AtomicUsize>);

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

// Only a successful start is cached: a failed bind leaves the slot empty so
// the next prepare retries instead of replaying the same error forever.
static SERVER: Mutex<Option<Arc<Server>>> = Mutex::new(None);

fn current_server() -> Option<Arc<Server>> {
    SERVER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(Arc::clone)
}

fn preview_server() -> Result<Arc<Server>, String> {
    let mut slot = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(server) = slot.as_ref() {
        if server.is_alive() {
            return Ok(Arc::clone(server));
        }
        // The accept thread is gone: drop the dead server and restart below
        // instead of handing out URLs for a port nothing listens on. The old
        // server's registrations die with it; its URLs were unusable anyway.
        crate::log::vidcord_log("Preview server: accept thread stopped; restarting the server");
        *slot = None;
    }
    let server = Arc::new(Server::start()?);
    *slot = Some(Arc::clone(&server));
    Ok(server)
}

/// Drop every registered preview source. Called when the webview starts a
/// fresh page load: the old page's URLs are dead, so its slots must not leak
/// for the rest of the process lifetime.
pub(crate) fn clear_preview_sources() {
    if let Some(server) = current_server() {
        server
            .sources
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .clear();
    }
}

impl Server {
    fn start() -> Result<Self, String> {
        let listener =
            TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let sources: Arc<Mutex<SourceTable>> = Arc::default();
        let server = Self {
            port,
            host: format!("127.0.0.1:{port}"),
            sources,
            alive: Arc::new(AtomicBool::new(true)),
        };
        let owned_sources = Arc::clone(&server.sources);
        let host_header = server.host.clone();
        let active = Arc::new(AtomicUsize::new(0));
        let alive_guard = AcceptAliveGuard(Arc::clone(&server.alive));
        std::thread::Builder::new()
            .name("vidcord-preview-server".to_string())
            .spawn(move || {
                // Dropping this guard on exit or panic marks the server dead
                // so `preview_server()` restarts it instead of reusing it.
                let _alive_guard = alive_guard;
                let mut consecutive_accept_errors: u32 = 0;
                for incoming in listener.incoming() {
                    let stream = match incoming {
                        Ok(stream) => {
                            consecutive_accept_errors = 0;
                            stream
                        }
                        Err(error) => {
                            consecutive_accept_errors = consecutive_accept_errors.saturating_add(1);
                            // A persistent accept error (for example EMFILE)
                            // must not spin at full speed flooding the log:
                            // back off exponentially up to a second, and only
                            // log the first failure and every doubling.
                            if consecutive_accept_errors == 1
                                || consecutive_accept_errors.is_power_of_two()
                            {
                                crate::log::vidcord_log(&format!(
                                    "Preview server: accept failed: {error}"
                                ));
                            }
                            let shift = (consecutive_accept_errors - 1).min(5);
                            std::thread::sleep(Duration::from_millis((50u64 << shift).min(1000)));
                            continue;
                        }
                    };
                    if active.fetch_add(1, Ordering::AcqRel) >= 8 {
                        active.fetch_sub(1, Ordering::AcqRel);
                        continue;
                    }
                    // The guard returns the slot on drop, including when
                    // `serve()` panics or the spawn below fails and drops
                    // the closure.
                    let request_guard = ActiveRequestGuard(Arc::clone(&active));
                    let sources = Arc::clone(&owned_sources);
                    let host = host_header.clone();
                    let spawned = std::thread::Builder::new()
                        .name("vidcord-preview-request".to_string())
                        .spawn(move || {
                            let _request_guard = request_guard;
                            if let Err(error) = serve(stream, &host, &sources) {
                                crate::log::vidcord_log(&format!(
                                    "Preview server: request failed: {error}"
                                ));
                            }
                        });
                    if let Err(error) = spawned {
                        crate::log::vidcord_log(&format!(
                            "Preview server: could not spawn a request thread: {error}"
                        ));
                    }
                }
            })
            .map_err(|e| {
                server.alive.store(false, Ordering::Release);
                e.to_string()
            })?;
        Ok(server)
    }

    fn insert(&self, path: PathBuf) -> Result<String, String> {
        // Store the canonical path so serve-time validation (dev/ino on
        // Unix, canonical comparison elsewhere) checks the same resolved
        // form the scope check saw.
        let path = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let (dev, ino) = {
            use std::os::unix::fs::MetadataExt;
            (metadata.dev(), metadata.ino())
        };
        let mut random = [0u8; 32];
        SystemRandom::new()
            .fill(&mut random)
            .map_err(|_| "Could not create a private preview URL".to_string())?;
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let mut sources = self.sources.lock().unwrap_or_else(|e| e.into_inner());
        // At capacity, evict the oldest registration instead of failing:
        // a slot leaked by a reload or a missed release must not break every
        // later preview for the life of the process.
        if sources.entries.len() >= MAX_PREVIEW_SOURCES {
            if let Some(oldest) = sources
                .entries
                .iter()
                .min_by_key(|(_, source)| source.inserted)
                .map(|(key, _)| key.clone())
            {
                sources.entries.remove(&oldest);
            }
        }
        let inserted = sources.next_inserted;
        sources.next_inserted += 1;
        sources.entries.insert(
            format!("/{token}"),
            PreviewSource {
                path,
                #[cfg(unix)]
                dev,
                #[cfg(unix)]
                ino,
                inserted,
            },
        );
        Ok(format!("http://127.0.0.1:{}/{token}", self.port))
    }

    fn remove(&self, token_path: &str) {
        self.sources
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .remove(token_path);
    }
}

#[tauri::command]
pub async fn prepare_preview_source(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<String>, String> {
    // Other platforms support Tauri's existing scoped asset protocol directly.
    if !cfg!(target_os = "linux") {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
        if !path.is_file() || !app.asset_protocol_scope().is_allowed(&path) {
            return Err("The preview file is outside the allowed asset scope".into());
        }
        preview_server()?.insert(path).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn release_preview_source(url: String) {
    if let Some(server) = current_server() {
        if let Some(token) = url.strip_prefix(&format!("http://127.0.0.1:{}/", server.port)) {
            server.remove(&format!("/{token}"));
        }
    }
}

fn byte_range(header: &str, length: u64) -> Option<(u64, u64)> {
    let (start, end) = header.strip_prefix("bytes=")?.split_once('-')?;
    if length == 0 || end.contains(',') {
        return None;
    }
    if start.is_empty() {
        let count = end.parse::<u64>().ok()?.min(length);
        return (count > 0).then_some((length - count, length - 1));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>().ok()?.min(length - 1)
    };
    (start < length && start <= end).then_some((start, end))
}

fn reply(stream: &mut TcpStream, status: &str) -> std::io::Result<()> {
    stream.write_all(
        format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes(),
    )
}

fn serve(
    mut stream: TcpStream,
    expected_host: &str,
    sources: &Arc<Mutex<SourceTable>>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new((&stream).take(8193));
    let mut request = String::new();
    reader.read_line(&mut request)?;
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let mut host = String::new();
    let mut range: Option<String> = None;
    let mut consumed = request.len();
    loop {
        let mut line = String::new();
        let count = reader.read_line(&mut line)?;
        consumed += count;
        if consumed > 8192 || count == 0 {
            return reply(&mut stream, "400 Bad Request");
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("host") {
                host = value.trim().to_owned();
            }
            if name.eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_owned());
            }
        }
    }
    drop(reader);
    // Exact Host validation also blocks DNS rebinding. Only unguessable,
    // explicitly opened file capabilities are served; paths never come from HTTP.
    if host != expected_host {
        return reply(&mut stream, "403 Forbidden");
    }
    if method != "GET" && method != "HEAD" {
        return reply(&mut stream, "405 Method Not Allowed");
    }
    let source = sources
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entries
        .get(target)
        .cloned();
    let Some(source) = source else {
        return reply(&mut stream, "404 Not Found");
    };
    // Re-validate the stored file at serve time, so a symlink swapped in
    // after preparation cannot redirect the request elsewhere. On Unix that
    // needs no per-request canonicalize (a full per-component path walk on
    // every range request): open the stored path first and let the fstat
    // dev/ino check on the opened handle below reject the request if the
    // path now names a different file, which any symlink swap does. Other
    // platforms keep the canonicalize comparison as the fallback.
    #[cfg(unix)]
    let Ok(mut file) = File::open(&source.path) else {
        return reply(&mut stream, "404 Not Found");
    };
    #[cfg(not(unix))]
    let Some(mut file) = (|| {
        let canonical = std::fs::canonicalize(&source.path).ok()?;
        if canonical != source.path {
            return None;
        }
        File::open(&canonical).ok()
    })() else {
        return reply(&mut stream, "404 Not Found");
    };
    let length = match file.metadata() {
        Ok(metadata) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.dev() != source.dev || metadata.ino() != source.ino {
                    return reply(&mut stream, "404 Not Found");
                }
            }
            metadata.len()
        }
        Err(error) => {
            crate::log::vidcord_log(&format!(
                "Preview server: could not stat a preview file: {error}"
            ));
            return reply(&mut stream, "500 Internal Server Error");
        }
    };
    let (start, end) = match &range {
        Some(header) => match byte_range(header, length) {
            Some(bounds) => bounds,
            None => {
                return stream.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{length}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
            }
        },
        None => (0, length.saturating_sub(1)),
    };
    let count = if length == 0 { 0 } else { end - start + 1 };
    let extension = source
        .path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("");
    let mime = if extension.eq_ignore_ascii_case("mp4") || extension.eq_ignore_ascii_case("m4v") {
        "video/mp4"
    } else if extension.eq_ignore_ascii_case("mov") {
        "video/quicktime"
    } else if extension.eq_ignore_ascii_case("webm") {
        "video/webm"
    } else if extension.eq_ignore_ascii_case("mkv") {
        "video/x-matroska"
    } else if extension.eq_ignore_ascii_case("avi") {
        "video/x-msvideo"
    } else if extension.eq_ignore_ascii_case("wmv") {
        "video/x-ms-wmv"
    } else {
        "application/octet-stream"
    };
    let status = if range.is_some() {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    let mut header = format!("HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n");
    if range.is_some() {
        header.push_str(&format!("Content-Range: bytes {start}-{end}/{length}\r\n"));
    }
    header.push_str("\r\n");
    stream.write_all(header.as_bytes())?;
    if method == "GET" && count > 0 {
        file.seek(SeekFrom::Start(start))?;
        std::io::copy(&mut file.take(count), &mut stream)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_guard_returns_the_slot_on_drop() {
        let active = Arc::new(AtomicUsize::new(0));
        active.fetch_add(1, Ordering::AcqRel);
        let guard = ActiveRequestGuard(Arc::clone(&active));
        assert_eq!(active.load(Ordering::Acquire), 1);
        drop(guard);
        assert_eq!(active.load(Ordering::Acquire), 0);
    }

    #[test]
    fn server_liveness_follows_the_accept_guard() {
        let server = Server::start().unwrap();
        assert!(server.is_alive());
        // Simulate the accept thread dying: clearing the flag (which its
        // drop guard does) makes the cached server ineligible for reuse.
        server.alive.store(false, Ordering::Release);
        assert!(!server.is_alive());
    }

    #[test]
    fn ranges_cover_seeking_suffixes_and_invalid_requests() {
        assert_eq!(byte_range("bytes=2-5", 10), Some((2, 5)));
        assert_eq!(byte_range("bytes=7-", 10), Some((7, 9)));
        assert_eq!(byte_range("bytes=-4", 10), Some((6, 9)));
        assert_eq!(byte_range("bytes=0-100", 10), Some((0, 9)));
        for value in [
            "bytes=10-",
            "bytes=5-2",
            "bytes=-0",
            "bytes=0-1,4-5",
            "garbage",
        ] {
            assert_eq!(byte_range(value, 10), None);
        }
        assert_eq!(byte_range("bytes=0-", 0), None);
    }

    fn request(port: u16, host: &str, target: &str, extra: &str) -> String {
        let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(
            stream,
            "GET {target} HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn server_streams_only_authorized_files_and_honors_revocation() {
        let server = Server::start().unwrap();
        let path =
            std::env::temp_dir().join(format!("vidcord-preview-test-{}.mp4", std::process::id()));
        std::fs::write(&path, b"0123456789").unwrap();
        let url = server.insert(path.clone()).unwrap();
        let target = url::Url::parse(&url).unwrap().path().to_string();
        let host = format!("127.0.0.1:{}", server.port);
        let response = request(server.port, &host, &target, "Range: bytes=2-5\r\n");
        assert!(response.starts_with("HTTP/1.1 206"));
        assert!(response.contains("Content-Range: bytes 2-5/10"));
        assert!(response.ends_with("\r\n\r\n2345"));
        let complete = request(server.port, &host, &target, "");
        assert!(complete.starts_with("HTTP/1.1 200"));
        assert!(complete.contains("Content-Type: video/mp4"));
        assert!(complete.ends_with("\r\n\r\n0123456789"));
        assert!(request(server.port, &host, &target, "Range: bytes=10-\r\n")
            .starts_with("HTTP/1.1 416"));
        assert!(request(server.port, "attacker.example", &target, "").starts_with("HTTP/1.1 403"));
        assert!(request(server.port, &host, "/../../etc/passwd", "").starts_with("HTTP/1.1 404"));
        // LF-only header termination is accepted.
        let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, server.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(stream, "GET {target} HTTP/1.1\nHost: {host}\n\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        server.remove(&target);
        assert!(request(server.port, &host, &target, "").starts_with("HTTP/1.1 404"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn insert_evicts_the_oldest_source_at_capacity() {
        let server = Server::start().unwrap();
        let dir =
            std::env::temp_dir().join(format!("vidcord-preview-evict-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut urls = Vec::new();
        for index in 0..=MAX_PREVIEW_SOURCES {
            let path = dir.join(format!("clip-{index}.mp4"));
            std::fs::write(&path, b"0123456789").unwrap();
            urls.push(server.insert(path).unwrap());
        }
        let host = format!("127.0.0.1:{}", server.port);
        let first_target = url::Url::parse(&urls[0]).unwrap().path().to_string();
        let last_target = url::Url::parse(urls.last().unwrap())
            .unwrap()
            .path()
            .to_string();
        assert_eq!(
            server.sources.lock().unwrap().entries.len(),
            MAX_PREVIEW_SOURCES
        );
        assert!(request(server.port, &host, &first_target, "").starts_with("HTTP/1.1 404"));
        assert!(request(server.port, &host, &last_target, "").starts_with("HTTP/1.1 200"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn serve_refuses_a_symlink_swapped_after_prepare() {
        let server = Server::start().unwrap();
        let dir = std::env::temp_dir().join(format!("vidcord-preview-swap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let allowed = dir.join("allowed.mp4");
        let outside = dir.join("outside.mp4");
        std::fs::write(&allowed, b"allowed-data").unwrap();
        std::fs::write(&outside, b"outside-data").unwrap();
        let url = server.insert(allowed.clone()).unwrap();
        let target = url::Url::parse(&url).unwrap().path().to_string();
        // Swap the prepared path for a symlink to a different file.
        std::fs::remove_file(&allowed).unwrap();
        std::os::unix::fs::symlink(&outside, &allowed).unwrap();
        let host = format!("127.0.0.1:{}", server.port);
        let response = request(server.port, &host, &target, "");
        assert!(response.starts_with("HTTP/1.1 404"));
        assert!(!response.contains("outside-data"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
