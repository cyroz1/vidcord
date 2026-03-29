import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./App.css";
import Toast from "./components/Toast";
import ProgressSection from "./components/ProgressSection";
import PreviewPane from "./components/PreviewPane";

const CURRENT_VERSION = "v5.6";

const QUALITY_PRESETS = [
  { label: "10MB, 480p", size_mb: 10, target_h: 480 },
  { label: "25MB, 480p", size_mb: 25, target_h: 480 },
  { label: "50MB, 720p", size_mb: 50, target_h: 720 },
  { label: "100MB, 1080p", size_mb: 100, target_h: 1080 },
  { label: "500MB, native res", size_mb: 500, target_h: null },
];

const RESOLUTION_OPTIONS = ["Native", "4K", "1440p", "1080p", "720p", "480p"];

type Encoder = { name: string; label: string };
type ToastMsg = { id: number; type: "success" | "error" | "warning" | "info"; title: string; message: string };
type ProbeData = { duration: number; width: number; height: number; bitrate: number };
type Settings = Record<string, unknown>;

function resolutionToShortSide(choice: string): number | null {
  const map: Record<string, number> = { "4k": 2160, "2160p": 2160, "1440p": 1440, "1080p": 1080, "720p": 720, "480p": 480 };
  return map[choice.toLowerCase()] ?? null;
}

function computeTargetDimensions(
  ow: number, oh: number, targetH: number | null, targetShort: number | null
): [number, number] | null {
  if (ow <= 0 || oh <= 0) return null;
  if (targetShort) {
    if (targetShort >= Math.min(ow, oh)) return null;
    const scale = targetShort / Math.min(ow, oh);
    let tw = Math.ceil(ow * scale);
    let th = Math.ceil(oh * scale);
    if (tw % 2 !== 0) tw++;
    if (th % 2 !== 0) th++;
    return [tw, th];
  }
  if (targetH) {
    if (targetH >= oh) return null;
    let th = targetH;
    let tw = Math.ceil((ow / oh) * th);
    if (tw % 2 !== 0) tw++;
    if (th % 2 !== 0) th++;
    return [tw, th];
  }
  return null;
}

function calculateBitrate(sizeMb: number, durationSec: number, removeAudio: boolean): number {
  const totalKbits = sizeMb * 1024 * 8;
  const audioKbits = removeAudio ? 0 : 128 * durationSec;
  const videoBitrate = (totalKbits - audioKbits) / durationSec;
  return Math.max(100, Math.floor(videoBitrate * 0.9));
}

let toastId = 0;

export default function App() {
  // File state
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState("Drag a video here or click Browse");
  const [probeData, setProbeData] = useState<ProbeData | null>(null);

  // Slider state (0..10000 = 0..duration)
  const [startVal, setStartVal] = useState(0);
  const [endVal, setEndVal] = useState(10000);
  const sliderMax = 10000;

  // Settings
  const [qualityIdx, setQualityIdx] = useState(0);
  const [encoders, setEncoders] = useState<Encoder[]>([{ name: "libx264", label: "CPU (libx264)" }]);
  const [encoderIdx, setEncoderIdx] = useState(0);
  const [removeAudio, setRemoveAudio] = useState(false);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advSize, setAdvSize] = useState("");
  const [advResolution, setAdvResolution] = useState("Native");
  const [advEncoder, setAdvEncoder] = useState("");

  // Compression state
  const [compressing, setCompressing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [eta, setEta] = useState("Ready");

  // Update notification
  const [updateInfo, setUpdateInfo] = useState<{ version: string; url: string } | null>(null);

  // Toasts
  const [toasts, setToasts] = useState<ToastMsg[]>([]);

  const addToast = useCallback((type: ToastMsg["type"], title: string, message: string) => {
    const id = ++toastId;
    setToasts(t => [...t, { id, type, title, message }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  // Settings persistence
  const settingsRef = useRef<Settings>({});

  useEffect(() => {
    (async () => {
      const s = await invoke<Settings>("load_settings").catch(() => ({}));
      settingsRef.current = s;
      if (typeof s.quality_index === "number") setQualityIdx(s.quality_index);
      if (typeof s.advanced_mode === "boolean") setAdvancedMode(s.advanced_mode);
      if (typeof s.advanced_target_size === "string") setAdvSize(s.advanced_target_size);
      if (typeof s.advanced_resolution === "string") setAdvResolution(s.advanced_resolution);
      if (typeof s.advanced_encoder === "string") setAdvEncoder(s.advanced_encoder);
    })();
  }, []);

  const saveSettings = useCallback((patch: Settings) => {
    settingsRef.current = { ...settingsRef.current, ...patch };
    invoke("save_settings", { settings: settingsRef.current }).catch(() => {});
  }, []);

  // Encoder detection
  useEffect(() => {
    invoke<Encoder[]>("detect_encoders").then(list => {
      if (list.length > 0) {
        setEncoders(list);
        const savedLabel = settingsRef.current.encoder_label as string | undefined;
        if (savedLabel) {
          const idx = list.findIndex(e => e.label === savedLabel);
          if (idx >= 0) { setEncoderIdx(idx); return; }
        }
        const savedIdx = (settingsRef.current.encoder_index as number) ?? 0;
        setEncoderIdx(Math.min(savedIdx, list.length - 1));
      }
    }).catch(() => {});
  }, []);

  // File drop via OS / drag-drop
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    const unlisten = win.onFileDropEvent(e => {
      if (e.payload.type === "drop" && e.payload.paths.length > 0) {
        loadVideo(e.payload.paths[0]);
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Compression events
  useEffect(() => {
    const unsub1 = listen<{ percent: number; eta: string; status: string }>("compress-progress", e => {
      setProgress(e.payload.percent);
      setEta(`${e.payload.status} ETA: ${e.payload.eta}`);
    });
    const unsub2 = listen<{ success: boolean; message: string }>("compress-done", e => {
      setCompressing(false);
      setProgress(e.payload.success ? 100 : 0);
      setEta(e.payload.message);
    });
    return () => { unsub1.then(fn => fn()); unsub2.then(fn => fn()); };
  }, []);

  // Update check (once per session, respecting 6h cooldown)
  useEffect(() => {
    const lastCheck = (settingsRef.current.update_last_check as number) ?? 0;
    if (Date.now() / 1000 - lastCheck < 6 * 3600) return;
    saveSettings({ update_last_check: Date.now() / 1000 });
    invoke<{ update_available: boolean; latest_version?: string; release_url?: string }>(
      "check_for_updates", { currentVersion: CURRENT_VERSION }
    ).then(r => {
      if (r.update_available && r.latest_version && r.release_url) {
        setUpdateInfo({ version: r.latest_version, url: r.release_url });
      }
    }).catch(() => {});
  }, [saveSettings]);

  const loadVideo = useCallback(async (path: string) => {
    const supported = /\.(mp4|avi|mov|mkv|flv|wmv|webm)$/i.test(path);
    if (!supported) {
      setFileName("Unsupported file format.");
      return;
    }
    setFilePath(path);
    setFileName(path.split(/[\\/]/).pop() ?? path);
    setStartVal(0);
    setEndVal(sliderMax);
    setProgress(0);
    setEta("Ready");
    try {
      const data = await invoke<ProbeData>("probe", { path });
      setProbeData(data);
    } catch (e) {
      setFileName(`Error loading video: ${e}`);
      setProbeData(null);
    }
  }, []);

  const browseFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "avi", "mov", "mkv", "flv", "wmv", "webm"] }],
    });
    if (selected && typeof selected === "string") {
      await loadVideo(selected);
    }
  }, [loadVideo]);

  const startCompress = useCallback(async () => {
    if (!filePath || !probeData) {
      addToast("warning", "Warning", "No file selected!");
      setCompressing(false);
      return;
    }

    const duration = probeData.duration;
    const startTime = (startVal / sliderMax) * duration;
    const endTime = (endVal / sliderMax) * duration;
    const clipDuration = endTime - startTime;
    if (clipDuration <= 0) {
      addToast("warning", "Warning", "Invalid trim range.");
      setCompressing(false);
      return;
    }

    let targetSize: number;
    let targetH: number | null = null;
    let targetShort: number | null = null;
    let encoderName: string;

    if (advancedMode) {
      const sz = parseFloat(advSize);
      if (!advSize || isNaN(sz) || sz <= 0) {
        addToast("warning", "Warning", "Enter a valid target size in MB.");
        setCompressing(false);
        return;
      }
      targetSize = sz;
      targetShort = resolutionToShortSide(advResolution);
      const customEnc = advEncoder.trim();
      if (customEnc) {
        const mapped = encoders.find(e => e.label === customEnc || e.name === customEnc);
        encoderName = mapped?.name ?? customEnc;
      } else {
        encoderName = encoders[encoderIdx]?.name ?? "libx264";
      }
    } else {
      const preset = QUALITY_PRESETS[qualityIdx];
      targetSize = preset.size_mb;
      targetH = preset.target_h;
      encoderName = encoders[encoderIdx]?.name ?? "libx264";
    }

    let videoBitrate = calculateBitrate(targetSize, clipDuration, removeAudio);
    if (probeData.bitrate > 0 && videoBitrate > probeData.bitrate) {
      videoBitrate = probeData.bitrate;
    }

    // Determine output path (Rust resolves Downloads dir + auto-increments)
    const resolvedOutput = await invoke<string>("resolve_output_path", { inputPath: filePath }).catch(() => null);
    if (!resolvedOutput) {
      addToast("error", "Error", "Could not resolve output path.");
      setCompressing(false);
      return;
    }

    const outputPath = await invoke<string>("compress_video", {
      opts: {
        input_path: filePath,
        output_path: resolvedOutput,
        encoder: encoderName,
        video_bitrate_k: videoBitrate,
        start_time: startTime,
        end_time: endTime,
        remove_audio: removeAudio,
        scale_filter: buildScaleFilter(probeData.width, probeData.height, targetH, targetShort, encoderName),
        vaapi_device: encoderName.endsWith("_vaapi") ? await invoke<string | null>("get_vaapi_device") : null,
      }
    }).catch(e => {
      addToast("error", "Error", String(e));
      return null;
    });

    if (outputPath) {
      addToast("success", "Success", "Compression complete!");
      invoke("show_in_file_explorer", { path: outputPath }).catch(() => {});
    }
  }, [filePath, probeData, startVal, endVal, advancedMode, advSize, advResolution, advEncoder, qualityIdx, encoderIdx, encoders, removeAudio, addToast]);

  function buildScaleFilter(ow: number, oh: number, targetH: number | null, targetShort: number | null, encoder: string): string | null {
    const dims = computeTargetDimensions(ow, oh, targetH, targetShort);
    if (encoder.endsWith("_vaapi")) {
      return dims ? `${dims[0]}:${dims[1]}` : "iw:ih";
    }
    return dims ? `scale=${dims[0]}:${dims[1]}` : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  }

  const cancelCompress = useCallback(() => {
    invoke("cancel_compression").catch(() => {});
    setCompressing(false);
    setEta("Cancelled");
  }, []);

  const showEncoders = useCallback(async () => {
    const text = await invoke<string>("list_ffmpeg_video_encoders").catch(e => `Error: ${e}`);
    addToast("info", "FFmpeg Video Encoders", text.slice(0, 800) + (text.length > 800 ? "\n…" : ""));
  }, [addToast]);

  const startTime = probeData ? (startVal / sliderMax) * probeData.duration : 0;
  const endTime = probeData ? (endVal / sliderMax) * probeData.duration : 0;

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <img src="/icon.png" className="app-icon" alt="vidcord" />
        <h1 className="app-title">vidcord</h1>
      </div>

      {/* Update banner */}
      {updateInfo && (
        <div className="update-banner">
          <span>Version {updateInfo.version} available.</span>
          <a href={updateInfo.url} target="_blank" rel="noreferrer">Download</a>
          <button className="update-dismiss" onClick={() => setUpdateInfo(null)}>✕</button>
        </div>
      )}

      <div className="scroll-area">
        {/* Drop zone */}
        <div
          className={`drop-zone${filePath ? " has-file" : ""}`}
          onClick={browseFile}
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) loadVideo((f as File & { path?: string }).path ?? f.name);
          }}
        >
          <span className="drop-label">{fileName}</span>
          <button className="browse-btn" onClick={e => { e.stopPropagation(); browseFile(); }}>Browse File</button>
        </div>

        {/* Basic settings */}
        {!advancedMode && (
          <div className="row settings-row">
            <label>Target
              <select value={qualityIdx} onChange={e => { setQualityIdx(+e.target.value); saveSettings({ quality_index: +e.target.value }); }}>
                {QUALITY_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
              </select>
            </label>
            <label>Encoder
              <select value={encoderIdx} onChange={e => { setEncoderIdx(+e.target.value); saveSettings({ encoder_index: +e.target.value, encoder_label: encoders[+e.target.value]?.label }); }}>
                {encoders.map((e, i) => <option key={e.name} value={i}>{e.label}</option>)}
              </select>
            </label>
          </div>
        )}

        {/* Advanced settings */}
        {advancedMode && (
          <div className="row settings-row advanced">
            <label>Size (MB)
              <input
                type="number" min="0.1" step="0.1" placeholder="MB"
                value={advSize}
                onChange={e => { setAdvSize(e.target.value); saveSettings({ advanced_target_size: e.target.value }); }}
              />
            </label>
            <label>Resolution
              <select value={advResolution} onChange={e => { setAdvResolution(e.target.value); saveSettings({ advanced_resolution: e.target.value }); }}>
                {RESOLUTION_OPTIONS.map(r => <option key={r}>{r}</option>)}
              </select>
            </label>
            <label className="encoder-label">Encoder
              <div className="encoder-row">
                <input
                  type="text" placeholder="e.g. libx264"
                  value={advEncoder}
                  onChange={e => { setAdvEncoder(e.target.value); saveSettings({ advanced_encoder: e.target.value }); }}
                />
                <button className="icon-btn" title="Show FFmpeg encoders" onClick={showEncoders}>ℹ</button>
              </div>
            </label>
          </div>
        )}

        {/* Remove audio */}
        <div className="row options-row">
          <label className="checkbox-label">
            <input type="checkbox" checked={removeAudio} onChange={e => setRemoveAudio(e.target.checked)} />
            Remove Audio
          </label>
        </div>

        {/* Trim sliders */}
        <div className="trim-section">
          <span className="section-title">Trim Video</span>
          <div className="slider-row">
            <span className="slider-label">Start</span>
            <input
              type="range" min={0} max={sliderMax} value={startVal}
              onChange={e => {
                const v = Math.min(+e.target.value, endVal);
                setStartVal(v);
              }}
            />
            <span className="time-label">{startTime.toFixed(1)}s</span>
          </div>
          <div className="slider-row">
            <span className="slider-label">End</span>
            <input
              type="range" min={0} max={sliderMax} value={endVal}
              onChange={e => {
                const v = Math.max(+e.target.value, startVal);
                setEndVal(v);
              }}
            />
            <span className="time-label">{endTime.toFixed(1)}s</span>
          </div>
        </div>

        {/* Preview */}
        <PreviewPane
          filePath={filePath}
          startTime={startTime}
          endTime={endTime}
          probeData={probeData}
        />

        {/* Compress button */}
        <button
          className={`compress-btn${compressing ? " cancel" : ""}`}
          onClick={compressing ? cancelCompress : () => { setCompressing(true); startCompress(); }}
          disabled={compressing && progress > 0 && progress < 5}
        >
          {compressing ? "Cancel" : "Compress Video"}
        </button>

        {/* Progress */}
        <ProgressSection progress={progress} eta={eta} />

        {/* Footer */}
        <div className="footer">
          <span className="version">{CURRENT_VERSION}</span>
          <a href="https://github.com/cyroz1/vidcord" target="_blank" rel="noreferrer" className="gh-link">GitHub</a>
          <label className="checkbox-label advanced-toggle">
            <input
              type="checkbox" checked={advancedMode}
              onChange={e => { setAdvancedMode(e.target.checked); saveSettings({ advanced_mode: e.target.checked }); }}
            />
            Advanced Mode
          </label>
        </div>
      </div>

      {/* Toasts */}
      <div className="toast-container">
        {toasts.map(t => (
          <Toast key={t.id} {...t} onClose={() => removeToast(t.id)} />
        ))}
      </div>
    </div>
  );
}
