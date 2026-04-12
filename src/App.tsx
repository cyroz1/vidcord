import { useEffect, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";
import Toast from "./components/Toast";
import ProgressSection from "./components/ProgressSection";
import PreviewPane from "./components/PreviewPane";
import EncodersDialog from "./components/EncodersDialog";
import { useToasts } from "./hooks/useToasts";
import { useSettings } from "./hooks/useSettings";
import { useEncoders } from "./hooks/useEncoders";
import {
  useCompression,
  calculateBitrate,
  resolutionToShortSide,
  computeTargetDimensions,
  type ProbeData,
} from "./hooks/useCompression";
import pkg from "../package.json";

const CURRENT_VERSION = pkg.version;
const DISPLAY_VERSION = (() => {
  const [major = "0", minor = "0"] = String(CURRENT_VERSION).split(".");
  return `v${major}.${minor}`;
})();

const QUALITY_PRESETS = [
  { label: "10MB, 480p", size_mb: 10, target_h: 480 },
  { label: "25MB, 480p", size_mb: 25, target_h: 480 },
  { label: "50MB, 720p", size_mb: 50, target_h: 720 },
  { label: "100MB, 1080p", size_mb: 100, target_h: 1080 },
  { label: "500MB, native res", size_mb: 500, target_h: null },
];

const RESOLUTION_OPTIONS = ["Native", "4K", "1440p", "1080p", "720p", "480p"];

const SLIDER_MAX = 10000;
const MIN_TRIM_GAP = 1;

function buildScaleFilter(
  ow: number,
  oh: number,
  targetH: number | null,
  targetShort: number | null,
  encoder: string
): string | null {
  const dims = computeTargetDimensions(ow, oh, targetH, targetShort);
  if (encoder.endsWith("_vaapi")) {
    return dims ? `${dims[0]}:${dims[1]}` : "iw:ih";
  }
  return dims ? `scale=${dims[0]}:${dims[1]}` : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
}

export default function App() {
  // --- Hooks ---
  const { toasts, addToast, removeToast } = useToasts();
  const {
    settingsRef,
    settingsLoaded,
    qualityIdx,
    setQualityIdx,
    advancedMode,
    setAdvancedMode,
    advSize,
    setAdvSize,
    advResolution,
    setAdvResolution,
    advEncoder,
    setAdvEncoder,
    removeAudio,
    setRemoveAudio,
    saveSettings,
  } = useSettings();
  const { encoders, encoderIdx, setEncoderIdx } = useEncoders({
    settingsLoaded,
    savedEncoderLabel: settingsRef.current.encoder_label as string | undefined,
    savedEncoderIndex: (settingsRef.current.encoder_index as number) ?? 0,
    onFfmpegMissing: () =>
      addToast(
        "error",
        "FFmpeg Not Found",
        "FFmpeg was not found on PATH. Install FFmpeg and restart vidcord to enable compression."
      ),
  });
  const { compressing, setCompressing, progress, eta, cancelCompress, resetProgress } =
    useCompression({ onToast: addToast });

  // --- File state ---
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState("Drag a video here or click Browse");
  const [probeData, setProbeData] = useState<ProbeData | null>(null);
  const [startVal, setStartVal] = useState(0);
  const [endVal, setEndVal] = useState(SLIDER_MAX);

  // --- UI state ---
  const [updateInfo, setUpdateInfo] = useState<{ version: string; url: string } | null>(null);
  const [encodersDialogText, setEncodersDialogText] = useState<string | null>(null);

  // --- File loading ---
  const loadVideo = useCallback(async (path: string) => {
    if (!/\.(mp4|avi|mov|mkv|flv|wmv|webm)$/i.test(path)) {
      setFileName("Unsupported file format.");
      return;
    }
    setFilePath(path);
    setFileName(path.split(/[\\/]/).pop() ?? path);
    setStartVal(0);
    setEndVal(SLIDER_MAX);
    resetProgress();
    try {
      const data = await invoke<ProbeData>("probe", { path });
      setProbeData(data);
    } catch (e) {
      setFileName(`Error loading video: ${e}`);
      setProbeData(null);
    }
  }, [resetProgress]);

  const browseFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "avi", "mov", "mkv", "flv", "wmv", "webm"] }],
    });
    if (selected && typeof selected === "string") await loadVideo(selected);
  }, [loadVideo]);

  // --- OS file-open integrations ---
  useEffect(() => {
    const unsub = listen<string>("open-file", (e) => loadVideo(e.payload));
    return () => { unsub.then((fn) => fn()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unlisten = listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
      if (e.payload.paths.length > 0) loadVideo(e.payload.paths[0]);
    });
    return () => { unlisten.then((fn: () => void) => fn()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const suppressContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    window.addEventListener("contextmenu", suppressContextMenu);
    return () => {
      window.removeEventListener("contextmenu", suppressContextMenu);
    };
  }, []);

  // --- Update check ---
  useEffect(() => {
    if (!settingsLoaded) return;
    const lastCheck = (settingsRef.current.update_last_check as number) ?? 0;
    if (Date.now() / 1000 - lastCheck < 6 * 3600) return;
    invoke<{ update_available: boolean; latest_version?: string; release_url?: string }>(
      "check_for_updates",
      { currentVersion: CURRENT_VERSION }
    )
      .then((r) => {
        saveSettings({ update_last_check: Date.now() / 1000 });
        if (r.update_available && r.latest_version && r.release_url)
          setUpdateInfo({ version: r.latest_version, url: r.release_url });
      })
      .catch(() => {});
  }, [saveSettings, settingsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Compression ---
  const startCompress = useCallback(async () => {
    if (!filePath || !probeData) {
      addToast("warning", "Warning", "No file selected!");
      setCompressing(false);
      return;
    }
    const duration = probeData.duration;
    const startTime = (startVal / SLIDER_MAX) * duration;
    const endTime = (endVal / SLIDER_MAX) * duration;
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
        const mapped = encoders.find((e) => e.label === customEnc || e.name === customEnc);
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
    if (probeData.bitrate > 0 && videoBitrate > probeData.bitrate) videoBitrate = probeData.bitrate;

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
        vaapi_device: encoderName.endsWith("_vaapi")
          ? await invoke<string | null>("get_vaapi_device")
          : null,
      },
    }).catch((e) => { addToast("error", "Error", String(e)); return null; });

    if (outputPath) {
      addToast("success", "Success", "Compression complete!");
      invoke("show_in_file_explorer", { path: outputPath }).catch(() => {});
    }
  }, [
    filePath, probeData, startVal, endVal, advancedMode, advSize, advResolution,
    advEncoder, qualityIdx, encoderIdx, encoders, removeAudio, addToast, setCompressing,
  ]);

  const showEncoders = useCallback(async () => {
    const text = await invoke<string>("list_ffmpeg_video_encoders").catch((e) => `Error: ${e}`);
    setEncodersDialogText(text);
  }, []);

  // --- Derived values ---
  const startTime = probeData ? (startVal / SLIDER_MAX) * probeData.duration : 0;
  const endTime = probeData ? (endVal / SLIDER_MAX) * probeData.duration : 0;
  const startPct = (startVal / SLIDER_MAX) * 100;
  const endPct = (endVal / SLIDER_MAX) * 100;
  const lowerAdvEnc = advEncoder.toLowerCase();
  const predictedEncoder = advEncoder
    ? encoders.find((enc) => enc.name.toLowerCase().startsWith(lowerAdvEnc))?.name
    : undefined;
  const showPrediction = predictedEncoder && predictedEncoder.toLowerCase() !== lowerAdvEnc;

  return (
    <div className="app">
      {/* Update banner */}
      {updateInfo && (
        <div className="update-banner">
          <span>Version {updateInfo.version} available.</span>
          <a
            href={updateInfo.url}
            onClick={(e) => { e.preventDefault(); openUrl(updateInfo.url); }}
          >
            Download
          </a>
          <button className="update-dismiss" onClick={() => setUpdateInfo(null)}>✕</button>
        </div>
      )}

      <div className="scroll-area">
        {/* Drop zone */}
        <div
          className={`drop-zone${filePath ? " has-file" : ""}`}
          onClick={browseFile}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) loadVideo((f as File & { path?: string }).path ?? f.name);
          }}
        >
          <span className="drop-label">{fileName}</span>
          <button className="browse-btn" onClick={(e) => { e.stopPropagation(); browseFile(); }}>
            Browse File
          </button>
        </div>

        {/* Basic settings */}
        {!advancedMode && (
          <div className="row settings-row">
            <label>
              Target
              <select
                value={qualityIdx}
                onChange={(e) => { setQualityIdx(+e.target.value); saveSettings({ quality_index: +e.target.value }); }}
              >
                {QUALITY_PRESETS.map((p, i) => (
                  <option key={p.label} value={i}>{p.label}</option>
                ))}
              </select>
            </label>
            <label>
              Encoder
              <div className="encoder-row">
                <select
                  value={encoderIdx}
                  onChange={(e) => {
                    setEncoderIdx(+e.target.value);
                    saveSettings({ encoder_index: +e.target.value, encoder_label: encoders[+e.target.value]?.label });
                  }}
                >
                  {encoders.map((e, i) => (
                    <option key={e.name} value={i}>{e.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`mute-btn${removeAudio ? " active" : ""}`}
                  onClick={() => {
                    const next = !removeAudio;
                    setRemoveAudio(next);
                    saveSettings({ remove_audio: next });
                  }}
                >
                  {removeAudio ? "Unmute" : "Mute"}
                </button>
              </div>
            </label>
          </div>
        )}

        {/* Advanced settings */}
        {advancedMode && (
          <div className="row settings-row advanced">
            <label>
              Size (MB)
              <input
                type="number"
                min="0.1"
                step="0.1"
                placeholder="MB"
                value={advSize}
                onChange={(e) => { setAdvSize(e.target.value); saveSettings({ advanced_target_size: e.target.value }); }}
              />
            </label>
            <label>
              Resolution
              <select
                value={advResolution}
                onChange={(e) => { setAdvResolution(e.target.value); saveSettings({ advanced_resolution: e.target.value }); }}
              >
                {RESOLUTION_OPTIONS.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label className="encoder-label">
              Encoder
              <div className="encoder-row">
                <div style={{ position: "relative", flex: 1, display: "flex" }}>
                  {showPrediction && (
                    <input
                      type="text"
                      value={predictedEncoder}
                      readOnly
                      style={{
                        position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                        width: "100%", color: "var(--text-disabled)", pointerEvents: "none",
                        zIndex: 0, borderColor: "transparent", background: "transparent",
                      }}
                      tabIndex={-1}
                    />
                  )}
                  <input
                    type="text"
                    placeholder="e.g. libx264"
                    value={advEncoder}
                    style={{ position: "relative", zIndex: 1, backgroundColor: "transparent", width: "100%" }}
                    onChange={(e) => { setAdvEncoder(e.target.value); saveSettings({ advanced_encoder: e.target.value }); }}
                    onKeyDown={(e) => {
                      if (e.key === "Tab" && showPrediction) {
                        e.preventDefault();
                        setAdvEncoder(predictedEncoder!);
                        saveSettings({ advanced_encoder: predictedEncoder! });
                      }
                    }}
                  />
                </div>
                <button
                  type="button"
                  className={`mute-btn${removeAudio ? " active" : ""}`}
                  onClick={() => {
                    const next = !removeAudio;
                    setRemoveAudio(next);
                    saveSettings({ remove_audio: next });
                  }}
                >
                  {removeAudio ? "Unmute" : "Mute"}
                </button>
                <button className="icon-btn" title="Show FFmpeg encoders" onClick={showEncoders}>
                  ℹ
                </button>
              </div>
            </label>
          </div>
        )}

        {/* Trim slider */}
        <div className="trim-section">
          <span className="section-title">Trim Video</span>
          <div className="slider-row trim-dual-row">
            <span className="time-label time-label-left">{startTime.toFixed(1)}s</span>
            <div className="trim-dual-wrap">
              <div className="trim-dual-track" />
              <div
                className="trim-dual-range"
                style={{
                  left: `${startPct}%`,
                  width: `${Math.max(endPct - startPct, 0)}%`,
                }}
              />
              <input
                className="trim-handle trim-start-handle"
                type="range"
                min={0}
                max={SLIDER_MAX}
                value={startVal}
                onChange={(e) => {
                  const next = +e.target.value;
                  setStartVal(Math.min(next, endVal - MIN_TRIM_GAP));
                }}
                aria-label="Trim start"
              />
              <input
                className="trim-handle trim-end-handle"
                type="range"
                min={0}
                max={SLIDER_MAX}
                value={endVal}
                onChange={(e) => {
                  const next = +e.target.value;
                  setEndVal(Math.max(next, startVal + MIN_TRIM_GAP));
                }}
                aria-label="Trim end"
              />
            </div>
            <span className="time-label time-label-right">{endTime.toFixed(1)}s</span>
          </div>
        </div>

        {/* Preview */}
        <PreviewPane filePath={filePath} startTime={startTime} endTime={endTime} probeData={probeData} />

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
          <span className="version">{DISPLAY_VERSION}</span>
          <a
            href="https://github.com/cyroz1/vidcord"
            onClick={(e) => { e.preventDefault(); openUrl("https://github.com/cyroz1/vidcord"); }}
            className="gh-link"
            aria-label="GitHub"
            title="GitHub"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
          <label className="toggle-label footer-toggle advanced-toggle">
            <span>Advanced Mode</span>
            <span className="toggle-track">
              <input
                type="checkbox"
                className="toggle-input"
                checked={advancedMode}
                onChange={(e) => { setAdvancedMode(e.target.checked); saveSettings({ advanced_mode: e.target.checked }); }}
              />
              <span className="toggle-thumb" />
            </span>
          </label>
        </div>
      </div>

      {/* Encoders dialog */}
      {encodersDialogText !== null && (
        <EncodersDialog text={encodersDialogText} onClose={() => setEncodersDialogText(null)} />
      )}

      {/* Toasts */}
      <div className="toast-container">
        {toasts.map((t) => (
          <Toast key={t.id} {...t} onClose={() => removeToast(t.id)} />
        ))}
      </div>
    </div>
  );
}
