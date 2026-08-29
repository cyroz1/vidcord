import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type SyntheticEvent,
} from "react";
import {
  getAvailableCropOptions,
  formatAverageBitrate,
  formatFrameRate,
  formatVideoDuration,
} from "../videoMetadata";
import WebTrimTimeline from "./WebTrimTimeline";
import { playheadForTrimHandleChange } from "./trimPlayhead";
import {
  GIF_PRESETS,
  getAvailableFpsOptions,
  QUALITY_PRESETS,
  RESOLUTION_OPTIONS,
  createExportPlan,
  type ExportPlan,
} from "./exportPlan";
import { BrowserFfmpegEngine } from "./ffmpegEngine";
import DesktopUpgrade from "./DesktopUpgrade";
import { exportBrowserFile } from "./webExporter";
import {
  areBrowserSettingsEqual,
  createBrowserPresetId,
  loadBrowserPresets,
  loadBrowserSettings,
  normalizeBrowserFps,
  saveBrowserPresets,
  saveBrowserSettings,
  type BrowserMode,
  type BrowserPreset,
  type BrowserSettings,
} from "./webSettings";
import {
  blobFromCanvas,
  downloadBlob,
  fileStem,
  formatClock,
  formatFileSize,
  getPreviewUrl,
  isVideoFile,
  readVideoMetadata,
  tryCopyBlobToClipboard,
  type BrowserVideoMetadata,
} from "./webMedia";
import "./WebApp.css";

type Notice = { type: "success" | "error" | "warning" | "info"; message: string };

type IconName = "video" | "upload" | "sliders" | "snapshot" | "download" | "check" | "spark";

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (name === "upload") {
    return (
      <svg {...common}>
        <path d="M12 16V4" />
        <path d="m7 9 5-5 5 5" />
        <path d="M5 20h14" />
      </svg>
    );
  }
  if (name === "sliders") {
    return (
      <svg {...common}>
        <path d="M4 6h16M4 12h16M4 18h16" />
        <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
        <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
        <circle cx="11" cy="18" r="2" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (name === "snapshot") {
    return (
      <svg {...common}>
        <path d="M4 7h3l1.5-2h7L17 7h3v11H4Z" />
        <circle cx="12" cy="12.5" r="3.2" />
      </svg>
    );
  }
  if (name === "download") {
    return (
      <svg {...common}>
        <path d="M12 4v11" />
        <path d="m7 11 5 5 5-5" />
        <path d="M5 20h14" />
      </svg>
    );
  }
  if (name === "check") {
    return (
      <svg {...common}>
        <path d="m5 12 4 4L19 6" />
      </svg>
    );
  }
  if (name === "spark") {
    return (
      <svg {...common}>
        <path d="m12 3 1.35 5.65L19 10l-5.65 1.35L12 17l-1.35-5.65L5 10l5.65-1.35Z" />
        <path d="m19 16 .55 2.45L22 19l-2.45.55L19 22l-.55-2.45L16 19l2.45-.55Z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m10 9 5 3-5 3V9Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function Logo() {
  return (
    <div className="web-logo" aria-label="vidcord">
      <img className="web-logo-mark" src="/icon.png" alt="" width={34} height={34} />
      <span>vidcord</span>
    </div>
  );
}

function formatMetadata(metadata: BrowserVideoMetadata): string {
  const frameRate =
    typeof metadata.frameRate === "number" &&
    Number.isFinite(metadata.frameRate) &&
    metadata.frameRate > 0
      ? formatFrameRate(metadata.frameRate)
      : "FPS unavailable";
  const codecValue = metadata.codec.trim();
  const codec = codecValue && codecValue.toLowerCase() !== "unknown" ? codecValue : "Browser media";
  const bitrate =
    Number.isFinite(metadata.bitrateKbps) && metadata.bitrateKbps > 0
      ? `~${formatAverageBitrate(metadata.bitrateKbps)} average`
      : "Bitrate unavailable";
  const duration =
    Number.isFinite(metadata.duration) && metadata.duration > 0
      ? formatVideoDuration(metadata.duration)
      : "Duration unavailable";
  return `${metadata.width}×${metadata.height} · ${frameRate} · ${codec} · ${bitrate} · ${duration}`;
}

function browserModeLabel(mode: BrowserMode): string {
  if (mode === "advanced") return "Advanced";
  if (mode === "lossless") return "Lossless Trim";
  if (mode === "gif") return "GIF";
  return "Compress";
}

function WebApp() {
  const [settings, setSettings] = useState<BrowserSettings>(() => loadBrowserSettings());
  const settingsRef = useRef(settings);
  const [presets, setPresets] = useState<BrowserPreset[]>(() => loadBrowserPresets());
  const [selectedPresetId, setSelectedPresetId] = useState("autosave");
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<BrowserVideoMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState("Ready");
  const [wasmReady, setWasmReady] = useState(false);
  const [wasmLoading, setWasmLoading] = useState(false);
  const [lastExport, setLastExport] = useState<{ name: string; bytes: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadGenerationRef = useRef(0);
  const exportCancelledRef = useRef(false);
  const engineRef = useRef<BrowserFfmpegEngine | null>(null);

  const activeFile = files[activeFileIndex] ?? null;
  const batchMode = files.length > 1;
  const activeMode: BrowserMode | "batch" = batchMode ? "batch" : settings.mode;
  const exportMode: BrowserMode = activeMode === "batch" ? "compress" : activeMode;
  const duration = metadata?.duration ?? 0;
  const cropOptions = useMemo(
    () => getAvailableCropOptions(metadata?.width, metadata?.height),
    [metadata?.height, metadata?.width]
  );
  const standardFpsOptions = useMemo(
    () => getAvailableFpsOptions(metadata?.frameRate),
    [metadata?.frameRate]
  );
  const plan = useMemo<ExportPlan | null>(
    () =>
      metadata
        ? createExportPlan(metadata, settings, exportMode, startTime, endTime || metadata.duration)
        : null,
    [endTime, exportMode, metadata, settings, startTime]
  );
  const currentPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null;
  const presetIsCurrent = currentPreset
    ? areBrowserSettingsEqual(settings, currentPreset.settings)
    : false;

  const showNotice = useCallback((type: Notice["type"], message: string) => {
    setNotice({ type, message });
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
    const timeout = window.setTimeout(() => saveBrowserSettings(settings), 250);
    return () => window.clearTimeout(timeout);
  }, [settings]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    return () => engineRef.current?.dispose();
  }, []);

  useEffect(() => {
    const file = activeFile;
    const generation = ++loadGenerationRef.current;
    if (!file) {
      setPreviewUrl(null);
      setMetadata(null);
      setMetadataLoading(false);
      setStartTime(0);
      setEndTime(0);
      setCurrentTime(0);
      return;
    }

    const url = getPreviewUrl(file);
    setPreviewUrl(url);
    setMetadata(null);
    setMetadataLoading(true);
    setCurrentTime(0);
    void readVideoMetadata(file)
      .then((nextMetadata) => {
        if (generation !== loadGenerationRef.current) return;
        setMetadata(nextMetadata);
        setStartTime(0);
        setEndTime(nextMetadata.duration);
      })
      .catch((error: unknown) => {
        if (generation === loadGenerationRef.current) {
          showNotice("error", String(error));
          setEndTime(0);
        }
      })
      .finally(() => {
        if (generation === loadGenerationRef.current) setMetadataLoading(false);
      });

    return () => URL.revokeObjectURL(url);
  }, [activeFile, showNotice]);

  const patchSettings = useCallback((patch: Partial<BrowserSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    setSelectedPresetId("autosave");
  }, []);

  const selectMode = useCallback(
    (mode: BrowserMode) => {
      if (batchMode) return;
      patchSettings(
        mode === "compress" &&
          !standardFpsOptions.some((option) => option.value === settingsRef.current.fps)
          ? { mode, fps: "off" }
          : { mode }
      );
    },
    [batchMode, patchSettings, standardFpsOptions]
  );

  const selectPreset = useCallback(
    (id: string) => {
      if (id === "autosave") {
        setSelectedPresetId("autosave");
        return;
      }
      const preset = presets.find((item) => item.id === id);
      if (!preset) return;
      settingsRef.current = preset.settings;
      setSettings(preset.settings);
      setSelectedPresetId(preset.id);
    },
    [presets]
  );

  const savePreset = useCallback(() => {
    const suggested = currentPreset?.name ?? "My export";
    const entered = window.prompt("Name this browser preset", suggested);
    const name = entered?.trim().replace(/\s+/g, " ").slice(0, 40) ?? "";
    if (!name) return;

    const existing = presets.findIndex(
      (preset) => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    if (existing < 0 && presets.length >= 20) {
      showNotice("warning", "You can save up to 20 presets.");
      return;
    }
    const id = existing >= 0 ? presets[existing].id : createBrowserPresetId();
    const nextPreset = { id, name, settings: settingsRef.current };
    const next =
      existing >= 0
        ? presets.map((preset, index) => (index === existing ? nextPreset : preset))
        : [...presets, nextPreset];
    setPresets(next);
    saveBrowserPresets(next);
    setSelectedPresetId(id);
    showNotice("success", `Preset “${name}” saved.`);
  }, [currentPreset?.name, presets, showNotice]);

  const deletePreset = useCallback(() => {
    if (!currentPreset) return;
    const next = presets.filter((preset) => preset.id !== currentPreset.id);
    setPresets(next);
    saveBrowserPresets(next);
    setSelectedPresetId("autosave");
    showNotice("success", `Preset “${currentPreset.name}” deleted.`);
  }, [currentPreset, presets, showNotice]);

  const acceptFiles = useCallback(
    (candidateFiles: readonly File[]) => {
      const nextFiles = candidateFiles.filter(isVideoFile).slice(0, 12);
      if (nextFiles.length === 0) {
        showNotice("warning", "Choose a video file that the browser can read.");
        return;
      }
      if (candidateFiles.length > nextFiles.length) {
        showNotice("warning", "Some selections were skipped because they are not video files.");
      }
      setFiles(nextFiles);
      setActiveFileIndex(0);
      setLastExport(null);
      setProgress(0);
      setExportStatus("Ready");
    },
    [showNotice]
  );

  const handleFileInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      acceptFiles(Array.from(event.target.files ?? []));
      event.target.value = "";
    },
    [acceptFiles]
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      if (isExporting) return;
      setDragging(false);
      acceptFiles(Array.from(event.dataTransfer.files));
    },
    [acceptFiles, isExporting]
  );

  const seekTo = useCallback(
    (time: number) => {
      const next = Math.max(0, Math.min(time, duration));
      setCurrentTime(next);
      if (videoRef.current) {
        try {
          videoRef.current.currentTime = next;
        } catch {
          // The media element can reject seeks until metadata has settled.
        }
      }
    },
    [duration]
  );

  const handleSnapshot = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !activeFile) return;
    try {
      const blob = await blobFromCanvas(video);
      const name = `${fileStem(activeFile.name)}-snapshot.png`;
      downloadBlob(blob, name);
      showNotice("success", `${name} downloaded.`);
    } catch (error: unknown) {
      showNotice("error", String(error));
    }
  }, [activeFile, showNotice]);

  const startExport = useCallback(async () => {
    if (files.length === 0 || isExporting) return;
    if (!batchMode && !metadata) {
      showNotice("warning", "Wait for the video details to finish loading.");
      return;
    }

    const engine = engineRef.current ?? new BrowserFfmpegEngine();
    engineRef.current = engine;
    exportCancelledRef.current = false;
    setIsExporting(true);
    setWasmLoading(true);
    setProgress(0);
    setExportStatus("Loading the local browser encoder…");
    setLastExport(null);
    const exportSettings =
      batchMode && !standardFpsOptions.some((option) => option.value === settings.fps)
        ? { ...settings, fps: "off" }
        : settings;

    engine.setProgressHandler((value) => {
      setProgress((current) => Math.max(current, value * 100));
    });

    try {
      await engine.load();
      setWasmReady(true);
      setWasmLoading(false);
      let completed = 0;
      let oversized = false;
      for (let index = 0; index < files.length; index += 1) {
        if (exportCancelledRef.current) throw new Error("Export cancelled.");
        const file = files[index];
        const fileMetadata =
          index === activeFileIndex && metadata ? metadata : await readVideoMetadata(file);
        const fileStart = batchMode ? 0 : startTime;
        const fileEnd = batchMode ? fileMetadata.duration : endTime;
        setExportStatus(
          files.length > 1
            ? `Encoding ${index + 1} of ${files.length} · ${file.name}`
            : `Encoding ${file.name}`
        );
        const result = await exportBrowserFile({
          engine,
          file,
          metadata: fileMetadata,
          settings: exportSettings,
          mode: exportMode,
          startTime: fileStart,
          endTime: fileEnd,
          fileIndex: index,
          onProgress: (value, status) => {
            setProgress(((completed + value) / files.length) * 100);
            setExportStatus(files.length > 1 ? `${status} · ${index + 1}/${files.length}` : status);
          },
        });
        downloadBlob(result.blob, result.fileName);
        if (
          settings.mode === "advanced" ||
          settings.mode === "lossless" ||
          settings.mode === "gif"
        ) {
          const copied = await tryCopyBlobToClipboard(result.blob);
          if (copied) setExportStatus("Downloaded and copied to clipboard");
        }
        setLastExport({ name: result.fileName, bytes: result.bytes });
        oversized = oversized || result.wasOversized;
        completed += 1;
        setProgress((completed / files.length) * 100);
      }
      setExportStatus(
        oversized ? "Downloaded · target could not be reached" : "Downloaded successfully"
      );
      showNotice(
        oversized ? "warning" : "success",
        oversized
          ? "The result was downloaded, but it is still above the selected size target."
          : `${completed} ${completed === 1 ? "file" : "files"} downloaded. Processing stayed on this device.`
      );
    } catch (error: unknown) {
      if (exportCancelledRef.current) {
        setExportStatus("Cancelled");
        showNotice("info", "Export cancelled. No upload was made.");
      } else {
        setExportStatus("Export failed");
        showNotice("error", String(error));
      }
    } finally {
      setIsExporting(false);
      setWasmLoading(false);
      engine.setProgressHandler(null);
    }
  }, [
    activeFileIndex,
    batchMode,
    endTime,
    exportMode,
    files,
    isExporting,
    metadata,
    settings,
    showNotice,
    standardFpsOptions,
    startTime,
  ]);

  const cancelExport = useCallback(() => {
    if (!isExporting) return;
    exportCancelledRef.current = true;
    setExportStatus("Cancelling…");
    engineRef.current?.cancel();
  }, [isExporting]);

  const handleVideoTimeUpdate = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    setCurrentTime(event.currentTarget.currentTime);
  }, []);

  const selectedQuality = QUALITY_PRESETS[settings.qualityIndex] ?? QUALITY_PRESETS[0];
  const standardFps = standardFpsOptions.some((option) => option.value === settings.fps)
    ? settings.fps
    : "off";
  const actionLabel = batchMode
    ? `Export ${files.length} videos`
    : activeMode === "gif"
      ? "Create GIF"
      : activeMode === "lossless"
        ? "Trim without re-encoding"
        : plan?.targetSizeMb
          ? `${activeMode === "advanced" ? "Compress" : "Compress"} to ${plan.targetSizeMb} MB`
          : "Export video";
  const outputSummary = batchMode
    ? `${files.length} videos · ${selectedQuality.label}`
    : plan
      ? plan.summary
      : "Choose a video to preview the export";

  return (
    <div className="web-app" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
      <header className="web-header">
        <Logo />
        <nav className="web-header-nav" aria-label="Page navigation">
          <a href="#features">Features</a>
          <a href="#workflow">How it works</a>
          <a href="#desktop-app">Desktop app</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="web-header-actions">
          <span className={`web-runtime-status${wasmReady ? " ready" : ""}`}>
            <span className="web-status-dot" aria-hidden="true" />
            {wasmLoading ? "Loading encoder" : wasmReady ? "WASM ready" : "Local processing"}
          </span>
          <button
            className={`web-icon-button${presetsOpen ? " active" : ""}`}
            type="button"
            aria-label="Open preset settings"
            aria-expanded={presetsOpen}
            onClick={() => setPresetsOpen((open) => !open)}
          >
            <Icon name="sliders" size={19} />
          </button>
          <select
            className="web-preset-select"
            aria-label="Settings preset"
            value={selectedPresetId}
            onChange={(event) => selectPreset(event.target.value)}
          >
            <option value="autosave">
              Autosave{currentPreset && !presetIsCurrent ? " · changed" : ""}
            </option>
            {presets.map((preset) => (
              <option value={preset.id} key={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {presetsOpen && (
        <section className="web-preset-panel" aria-label="Preset settings">
          <div>
            <strong>Saved browser presets</strong>
            <span>Settings stay in this browser only.</span>
          </div>
          <div className="web-preset-actions">
            <button type="button" className="web-secondary-button" onClick={savePreset}>
              Save current
            </button>
            <button
              type="button"
              className="web-secondary-button"
              onClick={deletePreset}
              disabled={!currentPreset}
            >
              Delete
            </button>
          </div>
        </section>
      )}

      <main className="web-main">
        <section className="web-hero" aria-labelledby="web-hero-title">
          <div className="web-hero-copy">
            <h1 id="web-hero-title">Compress video for Discord, right in your browser.</h1>
            <p className="web-hero-lede">
              Drop in a clip, choose a target, and export a smaller video without sending it to a
              server.
            </p>
            <div className="web-hero-actions">
              <a className="web-marketing-button primary" href="#web-editor">
                Start with a video
              </a>
              <a className="web-marketing-text-link" href="#desktop-app">
                Need more power? See the desktop app
              </a>
            </div>
            <ul className="web-hero-points">
              <li>
                <Icon name="check" size={16} />
                <span>
                  <strong>No uploads.</strong> FFmpeg WebAssembly runs on this device.
                </span>
              </li>
              <li>
                <Icon name="check" size={16} />
                <span>
                  <strong>Discord-ready targets.</strong> Choose 20, 50, 100, or 500 MB.
                </span>
              </li>
              <li>
                <Icon name="check" size={16} />
                <span>
                  <strong>Nothing to install.</strong> Finished files download through your browser.
                </span>
              </li>
            </ul>
          </div>

          <div className="web-editor-column" id="web-editor">
            <div className="web-editor-heading">
              <div>
                <span className="web-editor-kicker">Local browser encoder</span>
                <strong>Choose a video to get started</strong>
              </div>
              <span className="web-editor-secure">
                <span className="web-status-dot" aria-hidden="true" />
                Files stay local
              </span>
            </div>
            <section
              className={`web-import-bar${dragging ? " dragging" : ""}${activeFile ? " has-file" : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) setDragging(false);
              }}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                className="web-hidden-input"
                type="file"
                accept="video/*,.mkv,.avi,.mov,.webm,.flv,.wmv"
                multiple
                disabled={isExporting}
                onChange={handleFileInput}
              />
              {activeFile ? (
                <div className="web-file-row">
                  <span className="web-file-icon">
                    <Icon name="video" size={23} />
                  </span>
                  <div className="web-file-copy">
                    <strong title={activeFile.name}>
                      {batchMode ? `${files.length} videos selected` : activeFile.name}
                    </strong>
                    <span>
                      {batchMode
                        ? "Each file will use the same export profile"
                        : metadata
                          ? formatMetadata(metadata)
                          : metadataLoading
                            ? "Reading video details…"
                            : "Video details unavailable"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="web-link-button"
                    disabled={isExporting}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Change…
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="web-drop-button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span className="web-drop-icon">
                    <Icon name="upload" size={25} />
                  </span>
                  <span>
                    <strong>Choose a video</strong>
                    <small>or drag and drop files here</small>
                  </span>
                </button>
              )}
            </section>

            <div className="web-workspace">
              <div className="web-left-column">
                <section className="web-preview-panel">
                  <div className="web-panel-topline">
                    <span>Preview</span>
                    {activeFile && (
                      <span>
                        {metadata ? `${metadata.width} × ${metadata.height}` : "Loading…"}
                      </span>
                    )}
                  </div>
                  <div className="web-preview-frame">
                    {previewUrl ? (
                      <>
                        <video
                          ref={videoRef}
                          src={previewUrl}
                          controls
                          playsInline
                          preload="metadata"
                          onTimeUpdate={handleVideoTimeUpdate}
                          onLoadedMetadata={(event) => {
                            if (!metadata && Number.isFinite(event.currentTarget.duration)) {
                              setEndTime(event.currentTarget.duration);
                            }
                          }}
                        />
                        <button
                          className="web-snapshot-button"
                          type="button"
                          aria-label="Download a PNG snapshot of the current frame"
                          title="Download frame snapshot"
                          onClick={() => void handleSnapshot()}
                        >
                          <Icon name="snapshot" size={18} />
                        </button>
                      </>
                    ) : (
                      <div className="web-preview-empty">
                        <span className="web-empty-icon">
                          <Icon name="video" size={28} />
                        </span>
                        <strong>Your video preview appears here</strong>
                        <span>Everything is processed locally in this browser.</span>
                      </div>
                    )}
                  </div>
                  {activeFile && (
                    <div className="web-preview-footer">
                      <span>
                        {formatClock(currentTime)} / {formatClock(duration)}
                      </span>
                      <span className="web-preview-caption">
                        Preview uses your browser’s media decoder
                      </span>
                    </div>
                  )}
                </section>

                {batchMode && (
                  <section className="web-queue-panel" aria-labelledby="web-queue-title">
                    <div className="web-section-heading">
                      <div>
                        <span className="web-section-label">Batch queue</span>
                        <strong id="web-queue-title">{files.length} videos</strong>
                      </div>
                      <span className="web-queue-note">Same profile · full duration</span>
                    </div>
                    <ol className="web-queue-list">
                      {files.map((file, index) => (
                        <li
                          key={`${file.name}-${file.lastModified}-${index}`}
                          className={index === activeFileIndex ? "active" : ""}
                        >
                          <button type="button" onClick={() => setActiveFileIndex(index)}>
                            <span className="web-queue-index">{index + 1}</span>
                            <span className="web-queue-name" title={file.name}>
                              {file.name}
                            </span>
                            <span className="web-queue-size">{formatFileSize(file.size)}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}
              </div>

              <section className="web-controls-panel" aria-label="Export controls">
                <div className="web-mode-tabs" role="tablist" aria-label="Export mode">
                  {(["compress", "advanced", "lossless", "gif"] as BrowserMode[]).map((mode) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeMode === mode}
                      className={activeMode === mode ? "active" : ""}
                      disabled={batchMode || isExporting}
                      key={mode}
                      onClick={() => selectMode(mode)}
                    >
                      {browserModeLabel(mode)}
                    </button>
                  ))}
                  {batchMode && (
                    <button
                      type="button"
                      role="tab"
                      className="active batch-tab"
                      aria-selected="true"
                    >
                      Batch
                    </button>
                  )}
                </div>

                {(activeMode === "compress" || activeMode === "batch") && (
                  <div className="web-settings-grid">
                    <label className="web-field web-field-wide">
                      <span>Discord target</span>
                      <select
                        value={settings.qualityIndex}
                        disabled={isExporting}
                        onChange={(event) =>
                          patchSettings({ qualityIndex: Number(event.target.value) })
                        }
                      >
                        {QUALITY_PRESETS.map((preset, index) => (
                          <option value={index} key={preset.label}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="web-field">
                      <span>Crop</span>
                      <select
                        value={settings.crop}
                        disabled={isExporting}
                        onChange={(event) => patchSettings({ crop: event.target.value })}
                      >
                        {cropOptions.map((option) => (
                          <option value={option.value} key={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="web-field">
                      <span>FPS</span>
                      <select
                        value={standardFps}
                        disabled={isExporting}
                        onChange={(event) => patchSettings({ fps: event.target.value })}
                      >
                        {standardFpsOptions.map((option) => (
                          <option value={option.value} key={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="web-toggle">
                      <input
                        type="checkbox"
                        checked={settings.removeAudio}
                        disabled={isExporting}
                        onChange={(event) =>
                          patchSettings({
                            removeAudio: event.target.checked,
                            audioNormalize: event.target.checked ? false : settings.audioNormalize,
                          })
                        }
                      />
                      <span>Remove audio</span>
                    </label>
                    <label className="web-toggle">
                      <input
                        type="checkbox"
                        checked={settings.audioNormalize}
                        disabled={isExporting || settings.removeAudio}
                        onChange={(event) =>
                          patchSettings({ audioNormalize: event.target.checked })
                        }
                      />
                      <span>Normalize audio</span>
                    </label>
                  </div>
                )}

                {activeMode === "advanced" && (
                  <div className="web-settings-grid web-advanced-grid">
                    <label className="web-field">
                      <span>
                        Target size <small>(optional)</small>
                      </span>
                      <input
                        inputMode="decimal"
                        value={settings.advancedTargetSize}
                        placeholder="No limit"
                        disabled={isExporting}
                        onChange={(event) =>
                          patchSettings({ advancedTargetSize: event.target.value })
                        }
                      />
                    </label>
                    <label className="web-field">
                      <span>Resolution</span>
                      <select
                        value={settings.resolution}
                        disabled={isExporting}
                        onChange={(event) => patchSettings({ resolution: event.target.value })}
                      >
                        {RESOLUTION_OPTIONS.map((option) => (
                          <option value={option} key={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="web-field">
                      <span>
                        FPS <small>(optional)</small>
                      </span>
                      <input
                        type="number"
                        min="1"
                        max="240"
                        step="0.01"
                        inputMode="decimal"
                        value={settings.fps === "off" ? "" : settings.fps}
                        placeholder="Source"
                        disabled={isExporting}
                        onChange={(event) => patchSettings({ fps: event.target.value })}
                        onBlur={() =>
                          patchSettings({ fps: normalizeBrowserFps(settingsRef.current.fps) })
                        }
                        aria-describedby="web-advanced-fps-note"
                      />
                      <small id="web-advanced-fps-note" className="web-field-hint">
                        Leave blank to keep the source rate.
                      </small>
                    </label>
                    <label className="web-toggle">
                      <input
                        type="checkbox"
                        checked={settings.removeAudio}
                        disabled={isExporting}
                        onChange={(event) =>
                          patchSettings({
                            removeAudio: event.target.checked,
                            audioNormalize: event.target.checked ? false : settings.audioNormalize,
                          })
                        }
                      />
                      <span>Remove audio</span>
                    </label>
                    <label className="web-toggle">
                      <input
                        type="checkbox"
                        checked={settings.audioNormalize}
                        disabled={isExporting || settings.removeAudio}
                        onChange={(event) =>
                          patchSettings({ audioNormalize: event.target.checked })
                        }
                      />
                      <span>Normalize audio</span>
                    </label>
                    <label className="web-field web-field-wide">
                      <span>Crop</span>
                      <select
                        value={settings.crop}
                        disabled={isExporting}
                        onChange={(event) => patchSettings({ crop: event.target.value })}
                      >
                        {cropOptions.map((option) => (
                          <option value={option.value} key={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                {activeMode === "gif" && (
                  <div className="web-settings-grid">
                    <label className="web-field">
                      <span>Target size</span>
                      <select
                        value={settings.gifQualityIndex}
                        disabled={isExporting}
                        onChange={(event) =>
                          patchSettings({ gifQualityIndex: Number(event.target.value) })
                        }
                      >
                        {GIF_PRESETS.map((preset, index) => (
                          <option value={index} key={preset.label}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="web-field">
                      <span>FPS</span>
                      <select
                        value={settings.gifFps}
                        disabled={isExporting}
                        onChange={(event) => patchSettings({ gifFps: Number(event.target.value) })}
                      >
                        {[15, 30, 50].map((fps) => (
                          <option value={fps} key={fps}>
                            {fps}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="web-field web-field-wide">
                      <span>Crop</span>
                      <select
                        value={settings.crop}
                        disabled={isExporting}
                        onChange={(event) => patchSettings({ crop: event.target.value })}
                      >
                        {cropOptions.map((option) => (
                          <option value={option.value} key={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                {activeMode === "lossless" && (
                  <div className="web-lossless-note">
                    <span className="web-note-icon">
                      <Icon name="spark" size={18} />
                    </span>
                    <div>
                      <strong>Stream copy</strong>
                      <span>
                        Trims without re-encoding. The cut snaps to the nearest playable source
                        boundary where the browser FFmpeg build allows it.
                      </span>
                    </div>
                    <label className="web-toggle">
                      <input
                        type="checkbox"
                        checked={settings.removeAudio}
                        disabled={isExporting}
                        onChange={(event) => patchSettings({ removeAudio: event.target.checked })}
                      />
                      <span>Remove audio</span>
                    </label>
                  </div>
                )}

                {batchMode ? (
                  <div className="web-batch-note">
                    <strong>Batch export</strong>
                    <span>
                      Each selected file uses the same target, crop, frame-rate, and audio settings.
                      Trimming is disabled for batch exports.
                    </span>
                  </div>
                ) : (
                  <WebTrimTimeline
                    duration={duration}
                    startTime={startTime}
                    endTime={endTime || duration}
                    currentTime={currentTime}
                    disabled={!metadata || isExporting}
                    onStartChange={(value) => {
                      const nextPlayhead = playheadForTrimHandleChange(
                        currentTime,
                        startTime,
                        value,
                        "start"
                      );
                      setStartTime(value);
                      if (nextPlayhead !== null) seekTo(nextPlayhead);
                    }}
                    onEndChange={(value) => {
                      const nextPlayhead = playheadForTrimHandleChange(
                        currentTime,
                        endTime || duration,
                        value,
                        "end"
                      );
                      setEndTime(value);
                      if (nextPlayhead !== null) seekTo(nextPlayhead);
                    }}
                    onSeek={seekTo}
                  />
                )}

                <div className="web-export-summary" aria-live="polite">
                  {outputSummary}
                </div>

                <button
                  className={`web-export-button${isExporting ? " cancel" : ""}`}
                  type="button"
                  disabled={(!batchMode && !metadata) || metadataLoading || wasmLoading}
                  onClick={isExporting ? cancelExport : () => void startExport()}
                >
                  {isExporting ? (
                    "Cancel export"
                  ) : (
                    <>
                      <Icon name="download" size={19} />
                      {actionLabel}
                    </>
                  )}
                </button>

                {(isExporting || progress > 0 || lastExport) && (
                  <div className="web-progress-panel" aria-live="polite">
                    <div className="web-progress-line">
                      <span>{exportStatus}</span>
                      <strong>{Math.round(progress)}%</strong>
                    </div>
                    <div className="web-progress-track">
                      <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
                    </div>
                    {lastExport && !isExporting && (
                      <span className="web-last-export">
                        <Icon name="check" size={15} />
                        {lastExport.name} · {formatFileSize(lastExport.bytes)}
                      </span>
                    )}
                  </div>
                )}
              </section>
            </div>
          </div>
        </section>

        <DesktopUpgrade />
      </main>

      <footer className="web-footer">
        <span>vidcord · browser-first video compression</span>
        <span>Local-only processing · FFmpeg WebAssembly</span>
        <a href="#desktop-app">Desktop app</a>
        <a href="/legacy/">Original site</a>
        <a href="https://github.com/cyroz1/vidcord" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </footer>

      {notice && (
        <div
          className={`web-notice ${notice.type}`}
          role={notice.type === "error" ? "alert" : "status"}
        >
          {notice.message}
        </div>
      )}
    </div>
  );
}

export default WebApp;
