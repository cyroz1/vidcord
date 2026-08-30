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
import { snapLosslessTrimRange } from "../losslessTrim";
import WebTrimTimeline from "./WebTrimTimeline";
import {
  GIF_PRESETS,
  getAvailableFpsOptions,
  QUALITY_PRESETS,
  RESOLUTION_OPTIONS,
  createExportPlan,
  type ExportPlan,
} from "./exportPlan";
import { BrowserFfmpegEngine } from "./ffmpegEngine";
import { buildKeyframeProbeArgs, parseKeyframeTimes } from "./keyframes";
import DesktopUpgrade from "./DesktopUpgrade";
import { formatBrowserEta } from "./browserProgress";
import { exportBrowserFile } from "./webExporter";
import {
  loadBrowserSettings,
  normalizeBrowserFps,
  saveBrowserSettings,
  type BrowserMode,
  type BrowserSettings,
} from "./webSettings";
import {
  blobFromCanvas,
  downloadBlob,
  fileStem,
  formatFileSize,
  getPreviewUrl,
  isVideoFile,
  readVideoMetadata,
  tryCopyBlobToClipboard,
  type BrowserVideoMetadata,
} from "./webMedia";
import "./WebApp.css";

type Notice = { type: "success" | "error" | "warning" | "info"; message: string };

type IconName = "video" | "snapshot" | "check" | "play" | "stop";

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

  if (name === "snapshot") {
    return (
      <svg {...common}>
        <path d="M4 7h3l1.5-2h7L17 7h3v11H4Z" />
        <circle cx="12" cy="12.5" r="3.2" />
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
  if (name === "play") {
    return (
      <svg {...common}>
        <path d="m9 6 7 6-7 6V6Z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (name === "stop") {
    return (
      <svg {...common}>
        <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
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

type AudioIconType = "mute" | "normalize";

function AudioIcon({ type, active }: { type: AudioIconType; active: boolean }) {
  if (type === "mute") {
    return (
      <svg
        className="web-audio-icon"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {active ? (
          <>
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M9 9L6 12H2v4h4l5 4v-5.58" />
          </>
        ) : (
          <>
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          </>
        )}
      </svg>
    );
  }

  return (
    <svg
      className="web-audio-icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? "2.5" : "2"}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {active ? (
        <>
          <line x1="3" y1="6" x2="3" y2="18" />
          <line x1="7.5" y1="3" x2="7.5" y2="21" />
          <line x1="12" y1="2" x2="12" y2="22" />
          <line x1="16.5" y1="3" x2="16.5" y2="21" />
          <line x1="21" y1="6" x2="21" y2="18" />
        </>
      ) : (
        <>
          <line x1="4" y1="10" x2="4" y2="14" />
          <line x1="9" y1="7" x2="9" y2="17" />
          <line x1="14" y1="5" x2="14" y2="19" />
          <line x1="19" y1="9" x2="19" y2="15" />
        </>
      )}
    </svg>
  );
}

type WebAudioActionsProps = {
  removeAudio: boolean;
  audioNormalize: boolean;
  disabled?: boolean;
  onRemoveAudioChange: (value: boolean) => void;
  onAudioNormalizeChange: (value: boolean) => void;
};

function WebAudioActions({
  removeAudio,
  audioNormalize,
  disabled = false,
  onRemoveAudioChange,
  onAudioNormalizeChange,
}: WebAudioActionsProps) {
  return (
    <div className="web-audio-actions" role="group" aria-label="Audio controls">
      <button
        type="button"
        className={`web-audio-button web-mute-button${removeAudio ? " active" : ""}`}
        title={removeAudio ? "Unmute audio" : "Mute audio"}
        aria-label={removeAudio ? "Unmute audio" : "Mute audio"}
        aria-pressed={removeAudio}
        disabled={disabled}
        onClick={() => onRemoveAudioChange(!removeAudio)}
      >
        <AudioIcon type="mute" active={removeAudio} />
      </button>
      <button
        type="button"
        className={`web-audio-button web-normalize-button${audioNormalize && !removeAudio ? " active" : ""}`}
        title={
          removeAudio
            ? "Audio is muted"
            : "Peak-normalize audio so its highest sample peak reaches 0 dB"
        }
        aria-label="Peak-normalize audio to 0 dB"
        aria-pressed={audioNormalize && !removeAudio}
        disabled={disabled || removeAudio}
        onClick={() => onAudioNormalizeChange(!audioNormalize)}
      >
        <AudioIcon type="normalize" active={audioNormalize && !removeAudio} />
      </button>
    </div>
  );
}

function Logo() {
  return (
    <a className="web-logo" href="/" aria-label="vidcord home">
      <picture>
        <source
          type="image/webp"
          srcSet="/legacy/assets/icon-64.webp 64w, /legacy/assets/icon-128.webp 128w"
          sizes="34px"
        />
        <img className="web-logo-mark" src="/icon.png" alt="" width={34} height={34} />
      </picture>
      <span>vidcord</span>
    </a>
  );
}

function formatMetadata(metadata: BrowserVideoMetadata): string {
  const frameRate =
    typeof metadata.frameRate === "number" &&
    Number.isFinite(metadata.frameRate) &&
    metadata.frameRate > 0
      ? formatFrameRate(metadata.frameRate)
      : null;
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
  return [`${metadata.width}×${metadata.height}`, frameRate, codec, bitrate, duration]
    .filter((value): value is string => value !== null)
    .join(" · ");
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
  const [files, setFiles] = useState<File[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<BrowserVideoMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [losslessKeyframes, setLosslessKeyframes] = useState<number[]>([]);
  const [losslessKeyframesLoading, setLosslessKeyframesLoading] = useState(false);
  const [losslessKeyframeError, setLosslessKeyframeError] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState("Ready");
  const [wasmLoading, setWasmLoading] = useState(false);
  const [eta, setEta] = useState("Ready");
  const [lastExport, setLastExport] = useState<{ name: string; bytes: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadGenerationRef = useRef(0);
  const keyframeProbeGenerationRef = useRef(0);
  const keyframeCacheRef = useRef<Map<string, number[]>>(new Map());
  const exportCancelledRef = useRef(false);
  const exportProgressRef = useRef(0);
  const exportStartedAtRef = useRef<number | null>(null);
  const engineRef = useRef<BrowserFfmpegEngine | null>(null);

  const activeFile = files[activeFileIndex] ?? null;
  const batchMode = files.length > 1;
  const activeMode: BrowserMode | "batch" = batchMode ? "batch" : settings.mode;
  const exportMode: BrowserMode = activeMode === "batch" ? "compress" : activeMode;
  const duration = metadata?.duration ?? 0;
  const losslessKeyframeCacheKey = activeFile
    ? `${activeFile.name}\0${activeFile.size}\0${activeFile.lastModified}\0${duration}`
    : "";
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
    if (!isExporting) return;

    const updateEta = () => {
      const startedAt = exportStartedAtRef.current;
      if (startedAt === null) return;
      setEta(formatBrowserEta(exportProgressRef.current, Date.now() - startedAt));
    };

    updateEta();
    const interval = window.setInterval(updateEta, 500);
    return () => window.clearInterval(interval);
  }, [isExporting]);

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
      setPreviewPlaying(false);
      return;
    }

    const url = getPreviewUrl(file);
    setPreviewUrl(url);
    setMetadata(null);
    setMetadataLoading(true);
    setCurrentTime(0);
    setPreviewPlaying(false);
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
  }, []);

  const setBrowserRemoveAudio = useCallback(
    (removeAudio: boolean) => {
      patchSettings({
        removeAudio,
        audioNormalize: removeAudio ? false : settingsRef.current.audioNormalize,
      });
    },
    [patchSettings]
  );

  const setBrowserAudioNormalize = useCallback(
    (audioNormalize: boolean) => {
      patchSettings({ audioNormalize });
    },
    [patchSettings]
  );

  useEffect(() => {
    const generation = ++keyframeProbeGenerationRef.current;
    const canProbe = settings.mode === "lossless" && !batchMode && activeFile && duration > 0;

    if (!canProbe) {
      setLosslessKeyframes([]);
      setLosslessKeyframesLoading(false);
      setLosslessKeyframeError(null);
      setWasmLoading(false);
      return;
    }

    const cached = keyframeCacheRef.current.get(losslessKeyframeCacheKey);
    if (cached) {
      setLosslessKeyframes(cached);
      setLosslessKeyframesLoading(false);
      setLosslessKeyframeError(null);
      setWasmLoading(false);
      return;
    }

    const file = activeFile;
    const engine = engineRef.current ?? new BrowserFfmpegEngine();
    engineRef.current = engine;
    let probeRunning = true;
    setLosslessKeyframes([]);
    setLosslessKeyframesLoading(true);
    setLosslessKeyframeError(null);
    setWasmLoading(true);

    void engine
      .run(file, buildKeyframeProbeArgs)
      .then((log) => {
        if (generation !== keyframeProbeGenerationRef.current) return;
        const keyframes = parseKeyframeTimes(log, duration);
        if (keyframes.length === 0) {
          throw new Error("The browser could not find any source keyframes.");
        }
        keyframeCacheRef.current.set(losslessKeyframeCacheKey, keyframes);
        setLosslessKeyframes(keyframes);
        setLosslessKeyframesLoading(false);
        setLosslessKeyframeError(null);
      })
      .catch((error: unknown) => {
        if (generation !== keyframeProbeGenerationRef.current) return;
        const message = String(error);
        setLosslessKeyframes([]);
        setLosslessKeyframesLoading(false);
        setLosslessKeyframeError(message);
        showNotice("error", `Lossless Trim unavailable: ${message}`);
      })
      .finally(() => {
        probeRunning = false;
        if (generation === keyframeProbeGenerationRef.current) setWasmLoading(false);
      });

    return () => {
      if (generation === keyframeProbeGenerationRef.current) {
        keyframeProbeGenerationRef.current += 1;
        if (probeRunning) engine.cancel();
      }
    };
  }, [activeFile, batchMode, duration, losslessKeyframeCacheKey, settings.mode, showNotice]);

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
      exportProgressRef.current = 0;
      exportStartedAtRef.current = null;
      setProgress(0);
      setExportStatus("Ready");
      setEta("Ready");
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

  const removeQueuedFile = useCallback(
    (fileIndex: number) => {
      if (isExporting || fileIndex < 0 || fileIndex >= files.length) return;
      const nextFiles = files.filter((_, index) => index !== fileIndex);
      setFiles(nextFiles);
      setActiveFileIndex((currentIndex) => {
        if (nextFiles.length === 0) return 0;
        if (fileIndex < currentIndex) return currentIndex - 1;
        if (fileIndex === currentIndex) return Math.min(currentIndex, nextFiles.length - 1);
        return currentIndex;
      });
      setLastExport(null);
      exportProgressRef.current = 0;
      exportStartedAtRef.current = null;
      setProgress(0);
      setExportStatus("Ready");
      setEta("Ready");
    },
    [files, isExporting]
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

  const snapTrimRange = useCallback(
    (requestedStart: number, requestedEnd: number) => {
      if (settings.mode !== "lossless" || losslessKeyframes.length === 0) {
        return { start: requestedStart, end: requestedEnd };
      }
      return (
        snapLosslessTrimRange(requestedStart, requestedEnd, duration, losslessKeyframes) ?? {
          start: requestedStart,
          end: requestedEnd,
        }
      );
    },
    [duration, losslessKeyframes, settings.mode]
  );

  const applyTrimRange = useCallback(
    (requestedStart: number, requestedEnd: number, playheadTime?: number) => {
      const safeDuration = Math.max(duration, 0);
      const safeStart = Math.max(0, Math.min(requestedStart, safeDuration));
      const safeEnd = Math.max(safeStart, Math.min(requestedEnd, safeDuration));
      const nextRange = snapTrimRange(safeStart, safeEnd);
      setStartTime(nextRange.start);
      setEndTime(nextRange.end);

      if (typeof playheadTime === "number") {
        const requestedPlayhead = Math.max(0, Math.min(playheadTime, safeDuration));
        const playheadAtStart = Math.abs(requestedPlayhead - safeStart) <= 0.001;
        const playheadAtEnd = Math.abs(requestedPlayhead - safeEnd) <= 0.001;
        seekTo(
          playheadAtStart ? nextRange.start : playheadAtEnd ? nextRange.end : requestedPlayhead
        );
      }
    },
    [duration, seekTo, snapTrimRange]
  );

  useEffect(() => {
    if (settings.mode !== "lossless" || losslessKeyframes.length === 0 || duration <= 0) return;

    const requestedEnd = endTime || duration;
    const snapped = snapLosslessTrimRange(startTime, requestedEnd, duration, losslessKeyframes);
    if (!snapped) return;
    if (
      Math.abs(snapped.start - startTime) <= 0.0005 &&
      Math.abs(snapped.end - requestedEnd) <= 0.0005
    ) {
      return;
    }
    setStartTime(snapped.start);
    setEndTime(snapped.end);
    seekTo(snapped.start);
  }, [duration, endTime, losslessKeyframes, seekTo, settings.mode, startTime]);

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

  const togglePreviewPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || !metadata) return;

    const selectedEnd = endTime || duration;
    if (selectedEnd <= startTime) return;

    if (!video.paused) {
      video.pause();
      setPreviewPlaying(false);
      return;
    }

    if (video.currentTime < startTime || video.currentTime >= selectedEnd - 0.05) {
      video.currentTime = startTime;
      setCurrentTime(startTime);
    }
    void video
      .play()
      .then(() => setPreviewPlaying(true))
      .catch(() => setPreviewPlaying(false));
  }, [duration, endTime, metadata, startTime]);

  const handleVideoEnded = useCallback(() => {
    const video = videoRef.current;
    if (loopPlayback && video && metadata && endTime > startTime) {
      video.currentTime = startTime;
      setCurrentTime(startTime);
      void video.play().catch(() => setPreviewPlaying(false));
      return;
    }
    setPreviewPlaying(false);
    setCurrentTime(startTime);
  }, [endTime, loopPlayback, metadata, startTime]);

  const startExport = useCallback(async () => {
    if (files.length === 0 || isExporting) return;
    if (!batchMode && !metadata) {
      showNotice("warning", "Wait for the video details to finish loading.");
      return;
    }
    if (exportMode === "lossless") {
      if (losslessKeyframesLoading) {
        showNotice("info", "Preparing Lossless Trim. Finding keyframes for this video.");
        return;
      }
      if (losslessKeyframes.length === 0) {
        showNotice(
          "error",
          losslessKeyframeError ?? "Lossless Trim is unavailable because keyframe discovery failed."
        );
        return;
      }
    }

    const engine = engineRef.current ?? new BrowserFfmpegEngine();
    engineRef.current = engine;
    exportCancelledRef.current = false;
    setIsExporting(true);
    setWasmLoading(true);
    exportProgressRef.current = 0;
    exportStartedAtRef.current = Date.now();
    setProgress(0);
    setExportStatus("Loading the local browser encoder…");
    setEta("ETA: estimating…");
    setLastExport(null);
    const exportSettings =
      batchMode && !standardFpsOptions.some((option) => option.value === settings.fps)
        ? { ...settings, fps: "off" }
        : settings;

    try {
      await engine.load();
      setWasmLoading(false);
      exportStartedAtRef.current = Date.now();
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
            const fileProgress = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
            const nextProgress = Math.max(
              exportProgressRef.current,
              ((completed + fileProgress) / files.length) * 100
            );
            exportProgressRef.current = nextProgress;
            setProgress(nextProgress);
            const startedAt = exportStartedAtRef.current;
            if (startedAt !== null) setEta(formatBrowserEta(nextProgress, Date.now() - startedAt));
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
        exportProgressRef.current = Math.max(
          exportProgressRef.current,
          (completed / files.length) * 100
        );
        setProgress(exportProgressRef.current);
        const startedAt = exportStartedAtRef.current;
        if (startedAt !== null)
          setEta(formatBrowserEta(exportProgressRef.current, Date.now() - startedAt));
      }
      exportProgressRef.current = 100;
      setProgress(100);
      setEta("Complete");
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
        setEta("Cancelled");
        showNotice("info", "Export cancelled. No upload was made.");
      } else {
        setExportStatus("Export failed");
        setEta("Unavailable");
        showNotice("error", String(error));
      }
    } finally {
      setIsExporting(false);
      setWasmLoading(false);
    }
  }, [
    activeFileIndex,
    batchMode,
    endTime,
    exportMode,
    files,
    isExporting,
    losslessKeyframeError,
    losslessKeyframes,
    losslessKeyframesLoading,
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

  const handleVideoTimeUpdate = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>) => {
      const video = event.currentTarget;
      const selectedEnd = endTime || duration;
      if (!video.paused && selectedEnd > startTime && video.currentTime >= selectedEnd - 0.05) {
        video.currentTime = startTime;
        setCurrentTime(startTime);
        if (!loopPlayback) {
          video.pause();
          setPreviewPlaying(false);
        }
        return;
      }
      setCurrentTime(video.currentTime);
    },
    [duration, endTime, loopPlayback, startTime]
  );

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
        <nav className="web-header-nav" aria-label="Main navigation">
          <a href="#web-editor">Web Demo</a>
          <a href="#desktop-app">Desktop App</a>
          <a href="#workflow">How It Works</a>
          <a href="#integrations">Open With</a>
          <a href="#faq">FAQ</a>
          <a href="https://github.com/cyroz1/vidcord" rel="noreferrer" target="_blank">
            GitHub
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M7 17 17 7m0 0H9m8 0v8" />
            </svg>
          </a>
        </nav>
      </header>

      <main className="web-main">
        <section className="web-hero" aria-labelledby="web-hero-title">
          <div className="web-hero-copy">
            <h1 id="web-hero-title">Compress video for Discord, right in your browser.</h1>
            <p className="web-hero-lede">
              Drop in a clip, choose a target, and export a smaller video without sending it to a
              server.
            </p>
            <div className="web-hero-actions">
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
                <button
                  type="button"
                  className="web-file-row"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isExporting}
                  aria-label={`Change selected video, ${activeFile.name}`}
                >
                  <span className="web-file-icon">
                    <Icon name="video" size={20} />
                  </span>
                  <div className="web-file-copy">
                    <strong title={activeFile.name}>
                      {batchMode ? `${files.length} videos selected` : activeFile.name}
                    </strong>
                    <span>
                      {batchMode
                        ? "Batch mode · trims and encodes each video independently"
                        : metadata
                          ? formatMetadata(metadata)
                          : metadataLoading
                            ? "Reading video…"
                            : "Video details unavailable"}
                    </span>
                  </div>
                  <span className="web-link-button" aria-hidden="true">
                    Change…
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  className="web-drop-button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span className="web-drop-label">Drag a video here or click Browse</span>
                  <span className="web-browse-button" aria-hidden="true">
                    Browse File
                  </span>
                </button>
              )}
            </section>

            <div className="web-workspace">
              <section className="web-controls-panel" aria-label="Export controls">
                <div className="web-mode-tabs" role="group" aria-label="Export mode">
                  {(["compress", "advanced", "lossless", "gif"] as BrowserMode[]).map((mode) => (
                    <button
                      type="button"
                      aria-pressed={activeMode === mode}
                      className={activeMode === mode ? "active" : ""}
                      disabled={batchMode || isExporting}
                      key={mode}
                      onClick={() => selectMode(mode)}
                    >
                      {browserModeLabel(mode)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={batchMode ? "active batch-tab" : "batch-tab"}
                    aria-pressed={batchMode}
                    disabled={!batchMode || isExporting}
                  >
                    Batch
                  </button>
                </div>

                {(activeMode === "compress" || activeMode === "batch") && (
                  <div className="web-settings-grid web-standard-grid">
                    <label className="web-field">
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
                    <WebAudioActions
                      removeAudio={settings.removeAudio}
                      audioNormalize={settings.audioNormalize}
                      disabled={isExporting}
                      onRemoveAudioChange={setBrowserRemoveAudio}
                      onAudioNormalizeChange={setBrowserAudioNormalize}
                    />
                  </div>
                )}

                {activeMode === "advanced" && (
                  <div className="web-settings-grid web-advanced-grid">
                    <label className="web-field">
                      <span>Size (MB)</span>
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        inputMode="decimal"
                        value={settings.advancedTargetSize}
                        placeholder="Source"
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
                      <input
                        type="number"
                        min="0.1"
                        max="240"
                        step="1"
                        inputMode="decimal"
                        value={settings.fps === "off" ? "" : settings.fps}
                        placeholder="Off"
                        disabled={isExporting}
                        onChange={(event) => patchSettings({ fps: event.target.value })}
                        onBlur={() =>
                          patchSettings({ fps: normalizeBrowserFps(settingsRef.current.fps) })
                        }
                      />
                    </label>
                    <WebAudioActions
                      removeAudio={settings.removeAudio}
                      audioNormalize={settings.audioNormalize}
                      disabled={isExporting}
                      onRemoveAudioChange={setBrowserRemoveAudio}
                      onAudioNormalizeChange={setBrowserAudioNormalize}
                    />
                  </div>
                )}

                {activeMode === "gif" && (
                  <div className="web-settings-grid web-gif-grid">
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
                  </div>
                )}

                {activeMode === "lossless" && (
                  <div className="web-lossless-note">
                    <span className="web-lossless-settings-hint">
                      Copies the original video at keyframes; no re-encoding.
                    </span>
                    <button
                      type="button"
                      className={`web-lossless-audio-toggle${settings.removeAudio ? " active" : ""}`}
                      title={settings.removeAudio ? "Keep audio" : "Mute audio"}
                      aria-label={settings.removeAudio ? "Keep audio" : "Mute audio"}
                      aria-pressed={settings.removeAudio}
                      disabled={isExporting}
                      onClick={() => setBrowserRemoveAudio(!settings.removeAudio)}
                    >
                      <AudioIcon type="mute" active={settings.removeAudio} />
                      <span>{settings.removeAudio ? "Audio removed" : "Keep audio"}</span>
                    </button>
                  </div>
                )}

                {batchMode ? (
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
                          <button
                            type="button"
                            className="web-queue-item"
                            onClick={() => setActiveFileIndex(index)}
                          >
                            <span className="web-queue-index">{index + 1}</span>
                            <span className="web-queue-name" title={file.name}>
                              {file.name}
                            </span>
                            <span className="web-queue-size">{formatFileSize(file.size)}</span>
                          </button>
                          <button
                            type="button"
                            className="web-queue-remove"
                            onClick={() => removeQueuedFile(index)}
                            disabled={isExporting}
                            aria-label={`Remove ${file.name} from queue`}
                            title="Remove from queue"
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : (
                  <section className="web-preview-panel" aria-label="Video preview">
                    <div className="web-preview-frame">
                      {previewUrl ? (
                        <>
                          <video
                            ref={videoRef}
                            src={previewUrl}
                            playsInline
                            preload="metadata"
                            onTimeUpdate={handleVideoTimeUpdate}
                            onPlay={() => setPreviewPlaying(true)}
                            onPause={() => setPreviewPlaying(false)}
                            onEnded={handleVideoEnded}
                            onLoadedMetadata={(event) => {
                              if (!metadata && Number.isFinite(event.currentTarget.duration)) {
                                setEndTime(event.currentTarget.duration);
                              }
                            }}
                          />
                          {metadata && (
                            <button
                              className="web-preview-play-button"
                              type="button"
                              aria-label={previewPlaying ? "Stop preview" : "Play trim segment"}
                              title={previewPlaying ? "Stop preview" : "Play trim segment"}
                              onClick={togglePreviewPlayback}
                              disabled={isExporting}
                            >
                              <Icon name={previewPlaying ? "stop" : "play"} size={20} />
                            </button>
                          )}
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
                        <span className="web-preview-placeholder" role="status" aria-live="polite">
                          {!activeFile && (
                            <svg
                              className="web-preview-placeholder-icon"
                              width="28"
                              height="28"
                              viewBox="0 0 28 28"
                              fill="none"
                              aria-hidden="true"
                            >
                              <rect
                                x="4.5"
                                y="5.5"
                                width="19"
                                height="17"
                                rx="2.5"
                                stroke="currentColor"
                              />
                              <path
                                d="M8 5.5v17M20 5.5v17M4.5 10h3.5M4.5 18h3.5M20 10h3.5M20 18h3.5"
                                stroke="currentColor"
                                strokeLinecap="round"
                              />
                              <path
                                d="m11.5 10.5 6 3.5-6 3.5v-7Z"
                                stroke="currentColor"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                          <span>
                            {activeFile
                              ? metadataLoading
                                ? "Reading video…"
                                : "Preview"
                              : "No file selected"}
                          </span>
                        </span>
                      )}
                      {activeFile && metadata && (
                        <div className="web-preview-time-overlay">
                          {currentTime.toFixed(1)}s / {duration.toFixed(1)}s
                        </div>
                      )}
                    </div>
                  </section>
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
                    editableTimes={activeMode === "advanced" || activeMode === "lossless"}
                    losslessTrim={activeMode === "lossless"}
                    losslessInfoLoading={losslessKeyframesLoading}
                    losslessInfoError={losslessKeyframeError}
                    historyKey={`${activeFile?.name ?? ""}\0${activeFile?.lastModified ?? 0}\0${activeMode}`}
                    loopPlayback={loopPlayback}
                    onLoopPlaybackChange={setLoopPlayback}
                    onRangeChange={applyTrimRange}
                    onSeek={seekTo}
                  />
                )}

                <div className="web-export-summary" aria-live="polite">
                  {outputSummary}
                </div>

                <button
                  className={`web-export-button${isExporting ? " cancel" : ""}`}
                  type="button"
                  disabled={
                    (!batchMode && !metadata) ||
                    metadataLoading ||
                    wasmLoading ||
                    (activeMode === "lossless" &&
                      (losslessKeyframesLoading ||
                        losslessKeyframes.length === 0 ||
                        Boolean(losslessKeyframeError)))
                  }
                  onClick={isExporting ? cancelExport : () => void startExport()}
                >
                  {isExporting ? "Cancel export" : actionLabel}
                </button>

                {(isExporting || progress > 0 || lastExport) && (
                  <div className="web-progress-panel" aria-live="polite">
                    <div className="web-progress-line">
                      <span>{exportStatus}</span>
                      <strong>{Math.round(progress)}%</strong>
                    </div>
                    <div
                      className="web-progress-track"
                      role="progressbar"
                      aria-label="Export progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(Math.max(0, Math.min(100, progress)))}
                      aria-valuetext={`${Math.round(progress)}% complete, ${eta}`}
                    >
                      <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
                    </div>
                    <span className="web-progress-eta">{eta}</span>
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

      <footer className="site-footer">
        <div>
          <a className="footer-brand" href="#web-editor">
            <picture>
              <source
                type="image/webp"
                srcSet="/legacy/assets/icon-64.webp 64w, /legacy/assets/icon-128.webp 128w"
                sizes="34px"
              />
              <img src="/legacy/assets/icon.png" width="128" height="128" alt="" />
            </picture>
            <span>vidcord</span>
          </a>
          <p>Local video compression for Discord upload limits.</p>
        </div>
        <nav aria-label="Footer navigation">
          <a href="https://github.com/cyroz1/vidcord" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="https://github.com/cyroz1/vidcord/issues" target="_blank" rel="noreferrer">
            Issues
          </a>
          <a
            href="https://github.com/cyroz1/vidcord/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer"
          >
            MIT License
          </a>
          <a href="/sitemap.xml">Sitemap</a>
          <a href="/llms.txt">AI context</a>
        </nav>
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
