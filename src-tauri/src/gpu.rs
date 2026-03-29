use std::collections::HashMap;
use std::sync::OnceLock;

static GPU_CACHE: OnceLock<HashMap<String, bool>> = OnceLock::new();

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
            // Detection failed — enable all to avoid hiding valid encoders
            for v in gpus.values_mut() {
                *v = true;
            }
        }
        gpus
    })
}

fn detect_gpus() -> Option<HashMap<String, bool>> {
    let mut gpus = HashMap::from([
        ("nvidia".to_string(), false),
        ("amd".to_string(), false),
        ("intel".to_string(), false),
        ("apple".to_string(), false),
    ]);

    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("system_profiler")
            .arg("SPDisplaysDataType")
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        if text.contains("nvidia") { *gpus.get_mut("nvidia").unwrap() = true; }
        if text.contains("amd") || text.contains("radeon") { *gpus.get_mut("amd").unwrap() = true; }
        if text.contains("intel") { *gpus.get_mut("intel").unwrap() = true; }
        let apple_re = regex_lite::Regex::new(r"\bm\d+\b").unwrap();
        if text.contains("apple") || apple_re.is_match(&text) { *gpus.get_mut("apple").unwrap() = true; }
    }

    #[cfg(target_os = "windows")]
    {
        #[allow(unused_mut)]
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let out = cmd.output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        if text.contains("nvidia") { *gpus.get_mut("nvidia").unwrap() = true; }
        if text.contains("amd") || text.contains("radeon") { *gpus.get_mut("amd").unwrap() = true; }
        if text.contains("intel") { *gpus.get_mut("intel").unwrap() = true; }
    }

    #[cfg(target_os = "linux")]
    {
        let out = std::process::Command::new("lspci")
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        for line in text.lines() {
            if line.contains("vga") || line.contains("display") || line.contains("3d") {
                if line.contains("nvidia") { *gpus.get_mut("nvidia").unwrap() = true; }
                if line.contains("amd") || line.contains("radeon") { *gpus.get_mut("amd").unwrap() = true; }
                if line.contains("intel") { *gpus.get_mut("intel").unwrap() = true; }
            }
        }
    }

    Some(gpus)
}

