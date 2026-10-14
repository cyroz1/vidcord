//! Original-file delivery for WebKitGTK, whose media backend rejects custom URI schemes.
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ring::rand::{SecureRandom, SystemRandom};
use tauri::Manager;

type Sources = Arc<Mutex<HashMap<String, PathBuf>>>;
struct Server {
    port: u16,
    sources: Sources,
}
static SERVER: OnceLock<Result<Server, String>> = OnceLock::new();

impl Server {
    fn start() -> Result<Self, String> {
        let listener =
            TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let sources: Sources = Arc::default();
        let owned_sources = Arc::clone(&sources);
        let active = Arc::new(AtomicUsize::new(0));
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if active.fetch_add(1, Ordering::AcqRel) >= 8 {
                    active.fetch_sub(1, Ordering::AcqRel);
                    continue;
                }
                let sources = Arc::clone(&owned_sources);
                let active = Arc::clone(&active);
                std::thread::spawn(move || {
                    let _ = serve(stream, port, &sources);
                    active.fetch_sub(1, Ordering::AcqRel);
                });
            }
        });
        Ok(Self { port, sources })
    }

    fn insert(&self, path: PathBuf) -> Result<String, String> {
        let mut random = [0u8; 32];
        SystemRandom::new()
            .fill(&mut random)
            .map_err(|_| "Could not create a private preview URL".to_string())?;
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let mut sources = self.sources.lock().unwrap_or_else(|e| e.into_inner());
        if sources.len() >= 16 {
            return Err("Too many active preview sources".into());
        }
        sources.insert(format!("/{token}"), path);
        Ok(format!("http://127.0.0.1:{}/{token}", self.port))
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
        let server = SERVER
            .get_or_init(Server::start)
            .as_ref()
            .map_err(Clone::clone)?;
        server.insert(path).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn release_preview_source(url: String) {
    if let Some(Ok(server)) = SERVER.get() {
        if let Some(token) = url.strip_prefix(&format!("http://127.0.0.1:{}/", server.port)) {
            server
                .sources
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&format!("/{token}"));
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
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

fn serve(mut stream: TcpStream, port: u16, sources: &Sources) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new((&stream).take(8193));
    let mut request = String::new();
    reader.read_line(&mut request)?;
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let mut host = String::new();
    let mut range = None;
    let mut consumed = request.len();
    loop {
        let mut line = String::new();
        let count = reader.read_line(&mut line)?;
        consumed += count;
        if consumed > 8192 || count == 0 {
            return reply(&mut stream, "400 Bad Request");
        }
        if line == "\r\n" {
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
    if host != format!("127.0.0.1:{port}") {
        return reply(&mut stream, "403 Forbidden");
    }
    if method != "GET" && method != "HEAD" {
        return reply(&mut stream, "405 Method Not Allowed");
    }
    let path = sources
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&target)
        .cloned();
    let Some(path) = path else {
        return reply(&mut stream, "404 Not Found");
    };
    let Ok(mut file) = File::open(&path) else {
        return reply(&mut stream, "404 Not Found");
    };
    let length = file.metadata()?.len();
    let (start, end) = match &range {
        Some(header) => match byte_range(header, length) {
            Some(bounds) => bounds,
            None => {
                return write!(stream, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{length}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
        },
        None => (0, length.saturating_sub(1)),
    };
    let count = if length == 0 { 0 } else { end - start + 1 };
    let mime = match path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "wmv" => "video/x-ms-wmv",
        _ => "application/octet-stream",
    };
    let status = if range.is_some() {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n")?;
    if range.is_some() {
        write!(stream, "Content-Range: bytes {start}-{end}/{length}\r\n")?;
    }
    write!(stream, "\r\n")?;
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

    #[test]
    fn server_streams_only_authorized_files_and_honors_revocation() {
        let server = Server::start().unwrap();
        let path =
            std::env::temp_dir().join(format!("vidcord-preview-test-{}.mp4", std::process::id()));
        std::fs::write(&path, b"0123456789").unwrap();
        let url = server.insert(path.clone()).unwrap();
        let target = url::Url::parse(&url).unwrap().path().to_string();
        let request = |host: &str, target: &str, extra: &str| {
            let mut stream =
                TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, server.port)).unwrap();
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
        };
        let host = format!("127.0.0.1:{}", server.port);
        let response = request(&host, &target, "Range: bytes=2-5\r\n");
        assert!(response.starts_with("HTTP/1.1 206"));
        assert!(response.contains("Content-Range: bytes 2-5/10"));
        assert!(response.ends_with("\r\n\r\n2345"));
        let complete = request(&host, &target, "");
        assert!(complete.starts_with("HTTP/1.1 200"));
        assert!(complete.contains("Content-Type: video/mp4"));
        assert!(complete.ends_with("\r\n\r\n0123456789"));
        assert!(request(&host, &target, "Range: bytes=10-\r\n").starts_with("HTTP/1.1 416"));
        assert!(request("attacker.example", &target, "").starts_with("HTTP/1.1 403"));
        assert!(request(&host, "/../../etc/passwd", "").starts_with("HTTP/1.1 404"));
        server.sources.lock().unwrap().remove(&target);
        assert!(request(&host, &target, "").starts_with("HTTP/1.1 404"));
        std::fs::remove_file(path).unwrap();
    }
}
