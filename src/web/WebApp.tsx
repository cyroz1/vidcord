import PreviewCrop from "../components/PreviewCrop";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type SyntheticEvent,
  type MutableRefObject,
} from "react";
import {
  getAvailableCropOptions,
  formatAverageBitrate,
  formatFrameRate,
  formatVideoDuration,
} from "../videoMetadata";
import { normalizeLosslessKeyframes, snapLosslessTrimRange } from "../losslessTrim";
import { moveQueueItem, reorderQueueItem } from "../queueReordering";
import WebTrimTimeline from "./WebTrimTimeline";
import {
  GIF_PRESETS,
  getAvailableFpsOptions,
  QUALITY_PRESETS,
  RESOLUTION_OPTIONS,
  createExportPlan,
  type ExportPlan,
} from "./exportPlan";
import type { BrowserFfmpegEngine } from "./ffmpegEngine";
import { buildKeyframeProbeArgs, parseKeyframeTimes } from "./keyframes";
import DesktopUpgrade from "./DesktopUpgrade";
import { formatBrowserEta } from "./browserProgress";
import { effectiveBrowserExportMode, shouldCopyBrowserExport } from "./webExportState";
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
  isBrowserFileSizeSupported,
  isVideoFile,
  MAX_BROWSER_INPUT_LABEL,
  readVideoMetadata,
  tryCopyBlobToClipboard,
  VIDEO_FILE_ACCEPT,
  type BrowserVideoMetadata,
} from "./webMedia";
import {
  browserBatchStatusLabel,
  isBrowserBatchItemRetryable,
  type BrowserBatchItemStatus,
  type BrowserBatchQueueItem,
} from "./webBatchQueue";
import "./WebApp.css";

type Notice = { type: "success" | "error" | "warning" | "info"; message: string };

const MAX_BROWSER_BATCH_FILES = 12;
const KEYFRAME_PROBE_TIMEOUT_MS = 60_000;
const MAX_BROWSER_KEYFRAMES = 100_000;
const MARKETING_ASSET_BASE = import.meta.env.DEV ? "/site/marketing-assets" : "/marketing-assets";

type BrowserExportModule = typeof import("./browserExport");
function loadBrowserExportModule(): Promise<BrowserExportModule> {
  return import("./browserExport");
}

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
  audioAvailable?: boolean;
  disabled?: boolean;
  onRemoveAudioChange: (value: boolean) => void;
  onAudioNormalizeChange: (value: boolean) => void;
};

function WebAudioActions({
  removeAudio,
  audioNormalize,
  audioAvailable = true,
  disabled = false,
  onRemoveAudioChange,
  onAudioNormalizeChange,
}: WebAudioActionsProps) {
  const audioMuted = audioAvailable && removeAudio;
  const audioNormalized = audioAvailable && audioNormalize && !removeAudio;

  return (
    <div className="web-audio-actions" role="group" aria-label="Audio controls">
      <button
        type="button"
        className={`web-audio-button web-mute-button${audioMuted ? " active" : ""}`}
        title={
          audioAvailable ? (removeAudio ? "Unmute audio" : "Mute audio") : "No audio track detected"
        }
        aria-label={
          audioAvailable ? (removeAudio ? "Unmute audio" : "Mute audio") : "No audio track detected"
        }
        aria-pressed={audioMuted}
        disabled={disabled || !audioAvailable}
        onClick={() => onRemoveAudioChange(!removeAudio)}
      >
        <AudioIcon type="mute" active={audioMuted} />
      </button>
      <button
        type="button"
        className={`web-audio-button web-normalize-button${audioNormalized ? " active" : ""}`}
        title={
          !audioAvailable
            ? "No audio track detected"
            : removeAudio
              ? "Audio is muted"
              : "Peak-normalize audio so its highest sample peak reaches 0 dB"
        }
        aria-label={audioAvailable ? "Peak-normalize audio to 0 dB" : "No audio track detected"}
        aria-pressed={audioNormalized}
        disabled={disabled || removeAudio || !audioAvailable}
        onClick={() => onAudioNormalizeChange(!audioNormalize)}
      >
        <AudioIcon type="normalize" active={audioNormalized} />
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
          srcSet={`${MARKETING_ASSET_BASE}/icon-64.webp 64w, ${MARKETING_ASSET_BASE}/icon-128.webp 128w`}
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

type PageDropHandler = ((event: DragEvent<HTMLElement>) => void) | null;

function WebEditor({ dropHandlerRef }: { dropHandlerRef: MutableRefObject<PageDropHandler> }) {
  const [settings, setSettings] = useState<BrowserSettings>(() => loadBrowserSettings());
  const settingsRef = useRef(settings);
  const [queueItems, setQueueItems] = useState<BrowserBatchQueueItem[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [queueStatuses, setQueueStatuses] = useState<Record<number, BrowserBatchItemStatus>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
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
  const keyframeCacheRef = useRef(new WeakMap<File, number[]>());
  const metadataCacheRef = useRef(new WeakMap<File, BrowserVideoMetadata>());
  const exportCancelledRef = useRef(false);
  const exportControllerRef = useRef<AbortController | null>(null);
  const exportProgressRef = useRef(0);
  const exportUiUpdatedAtRef = useRef(0);
  const exportUiStatusRef = useRef("");
  const exportStartedAtRef = useRef<number | null>(null);
  const engineRef = useRef<BrowserFfmpegEngine | null>(null);
  const [draggedQueueItemId, setDraggedQueueItemId] = useState<number | null>(null);
  const [dragOverQueueItemId, setDragOverQueueItemId] = useState<number | null>(null);

  const files = useMemo(() => queueItems.map((item) => item.file), [queueItems]);
  const activeFile = files[activeFileIndex] ?? null;
  const batchMode = files.length > 1;
  const activeMode: BrowserMode | "batch" = batchMode ? "batch" : settings.mode;
  const exportMode = effectiveBrowserExportMode(activeMode);
  const duration = metadata?.duration ?? 0;
  const cropOptions = useMemo(
    () =>
      getAvailableCropOptions(
        batchMode ? undefined : (metadata?.displayWidth ?? metadata?.width),
        batchMode ? undefined : (metadata?.displayHeight ?? metadata?.height)
      ),
    [batchMode, metadata?.displayHeight, metadata?.displayWidth, metadata?.height, metadata?.width]
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

  const resetExportFeedback = useCallback((clearQueue = true) => {
    setLastExport(null);
    if (clearQueue) setQueueStatuses({});
    exportProgressRef.current = 0;
    exportUiUpdatedAtRef.current = 0;
    exportUiStatusRef.current = "Ready";
    exportStartedAtRef.current = null;
    setProgress(0);
    setExportStatus("Ready");
    setEta("Ready");
  }, []);

  const readCachedMetadata = useCallback(
    async (file: File, signal?: AbortSignal): Promise<BrowserVideoMetadata> => {
      signal?.throwIfAborted();
      const cached = metadataCacheRef.current.get(file);
      if (cached) return cached;

      const nextMetadata = await readVideoMetadata(file, signal);
      signal?.throwIfAborted();
      metadataCacheRef.current.set(file, nextMetadata);
      return nextMetadata;
    },
    []
  );

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
    return () => {
      exportCancelledRef.current = true;
      exportControllerRef.current?.abort();
      engineRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const file = activeFile;
    const generation = ++loadGenerationRef.current;
    if (!file) {
      setPreviewUrl(null);
      setPreviewError(null);
      setMetadata(null);
      setMetadataLoading(false);
      setStartTime(0);
      setEndTime(0);
      setCurrentTime(0);
      setPreviewPlaying(false);
      return;
    }

    const url = getPreviewUrl(file);
    const controller = new AbortController();
    setPreviewUrl(url);
    setPreviewError(null);
    setMetadata(null);
    setMetadataLoading(true);
    setCurrentTime(0);
    setPreviewPlaying(false);
    void readCachedMetadata(file, controller.signal)
      .then((nextMetadata) => {
        if (generation !== loadGenerationRef.current) return;
        setMetadata(nextMetadata);
        setStartTime(0);
        setEndTime(nextMetadata.duration);
      })
      .catch((error: unknown) => {
        if (generation === loadGenerationRef.current) {
          const message = String(error);
          setPreviewError(message);
          showNotice("error", message);
          setEndTime(0);
        }
      })
      .finally(() => {
        if (generation === loadGenerationRef.current) setMetadataLoading(false);
      });

    return () => {
      loadGenerationRef.current += 1;
      controller.abort();
      URL.revokeObjectURL(url);
    };
  }, [activeFile, readCachedMetadata, showNotice]);

  const patchSettings = useCallback(
    (patch: Partial<BrowserSettings>) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettings(next);
      resetExportFeedback();
    },
    [resetExportFeedback]
  );

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
    if (!batchMode && settings.mode === "lossless") return;
    if (settings.crop !== "off" && !cropOptions.some((option) => option.value === settings.crop)) {
      patchSettings({ crop: "off" });
    }
  }, [batchMode, cropOptions, patchSettings, settings.crop, settings.mode]);

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

    const cached = keyframeCacheRef.current.get(activeFile);
    if (cached) {
      setLosslessKeyframes(cached);
      setLosslessKeyframesLoading(false);
      setLosslessKeyframeError(null);
      setWasmLoading(false);
      return;
    }

    const file = activeFile;
    const discoveredKeyframes: number[] = [];
    let engine: BrowserFfmpegEngine | null = null;
    let probeRunning = true;
    let probeLimitError: string | null = null;
    setLosslessKeyframes([]);
    setLosslessKeyframesLoading(true);
    setLosslessKeyframeError(null);
    setWasmLoading(true);

    void loadBrowserExportModule()
      .then(({ BrowserFfmpegEngine }) => {
        if (generation !== keyframeProbeGenerationRef.current) return null;
        const nextEngine = engineRef.current ?? new BrowserFfmpegEngine();
        engine = nextEngine;
        engineRef.current = nextEngine;
        return nextEngine.run(
          file,
          buildKeyframeProbeArgs,
          undefined,
          (message) => {
            discoveredKeyframes.push(...parseKeyframeTimes(message, duration));
            if (discoveredKeyframes.length > MAX_BROWSER_KEYFRAMES) {
              probeLimitError =
                "This video has too many keyframes for browser Lossless Trim. Use the desktop app.";
              nextEngine.cancel();
            }
          },
          KEYFRAME_PROBE_TIMEOUT_MS
        );
      })
      .then((result) => {
        if (result === null) return;
        if (generation !== keyframeProbeGenerationRef.current) return;
        const keyframes = normalizeLosslessKeyframes(discoveredKeyframes, duration);
        if (keyframes.length === 0) {
          throw new Error("The browser could not find any source keyframes.");
        }
        keyframeCacheRef.current.set(file, keyframes);
        setLosslessKeyframes(keyframes);
        setLosslessKeyframesLoading(false);
        setLosslessKeyframeError(null);
      })
      .catch((error: unknown) => {
        if (generation !== keyframeProbeGenerationRef.current) return;
        const message = probeLimitError ?? String(error);
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
        if (probeRunning) engine?.cancel();
      }
    };
  }, [activeFile, batchMode, duration, settings.mode, showNotice]);

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
      const videoCandidates = candidateFiles.filter(isVideoFile);
      const supportedVideoCandidates = videoCandidates.filter(isBrowserFileSizeSupported);
      const nextFiles = supportedVideoCandidates.slice(0, MAX_BROWSER_BATCH_FILES);
      if (nextFiles.length === 0) {
        showNotice(
          "warning",
          videoCandidates.some((file) => !isBrowserFileSizeSupported(file))
            ? `Browser exports support video files up to ${MAX_BROWSER_INPUT_LABEL}.`
            : "Choose a video file that the browser can read."
        );
        return;
      }
      const skippedReasons: string[] = [];
      if (videoCandidates.some((file) => !isBrowserFileSizeSupported(file))) {
        skippedReasons.push(
          `some files exceed the ${MAX_BROWSER_INPUT_LABEL} browser export limit`
        );
      }
      if (candidateFiles.some((file) => !isVideoFile(file))) {
        skippedReasons.push("some selections are not video files");
      }
      if (supportedVideoCandidates.length > nextFiles.length) {
        skippedReasons.push(`only the first ${MAX_BROWSER_BATCH_FILES} videos can be queued`);
      }
      if (skippedReasons.length > 0) {
        showNotice("warning", `Some selections were skipped because ${skippedReasons.join("; ")}.`);
      }
      setQueueItems(nextFiles.map((file, id) => ({ id, file })));
      setActiveFileIndex(0);
      resetExportFeedback();
    },
    [resetExportFeedback, showNotice]
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
      event.stopPropagation();
      setDragging(false);
      if (isExporting) return;
      acceptFiles(Array.from(event.dataTransfer.files));
    },
    [acceptFiles, isExporting]
  );

  useEffect(() => {
    dropHandlerRef.current = handleDrop;
    return () => {
      dropHandlerRef.current = null;
    };
  }, [dropHandlerRef, handleDrop]);

  const removeQueuedFile = useCallback(
    (fileIndex: number) => {
      if (isExporting || fileIndex < 0 || fileIndex >= queueItems.length) return;
      const nextItems = queueItems.filter((_, index) => index !== fileIndex);
      setQueueItems(nextItems);
      setActiveFileIndex((currentIndex) => {
        if (nextItems.length === 0) return 0;
        if (fileIndex < currentIndex) return currentIndex - 1;
        if (fileIndex === currentIndex) return Math.min(currentIndex, nextItems.length - 1);
        return currentIndex;
      });
      resetExportFeedback(false);
    },
    [isExporting, queueItems, resetExportFeedback]
  );

  const updateQueueOrder = useCallback(
    (nextItems: BrowserBatchQueueItem[]) => {
      const activeItem = queueItems[activeFileIndex];
      setQueueItems(nextItems);
      if (activeItem) {
        const nextActiveIndex = nextItems.findIndex((item) => item.id === activeItem.id);
        if (nextActiveIndex >= 0) setActiveFileIndex(nextActiveIndex);
      }
    },
    [activeFileIndex, queueItems]
  );

  const moveQueuedFile = useCallback(
    (itemId: number, direction: "up" | "down") => {
      if (isExporting) return;
      const nextItems = moveQueueItem(queueItems, itemId, direction);
      if (nextItems.every((item, index) => item.id === queueItems[index]?.id)) return;
      updateQueueOrder(nextItems);
    },
    [isExporting, queueItems, updateQueueOrder]
  );

  const reorderQueuedFile = useCallback(
    (draggedItemId: number, targetItemId: number) => {
      if (isExporting) return;
      const nextItems = reorderQueueItem(queueItems, draggedItemId, targetItemId);
      if (nextItems.every((item, index) => item.id === queueItems[index]?.id)) return;
      updateQueueOrder(nextItems);
    },
    [isExporting, queueItems, updateQueueOrder]
  );

  const clearQueueDragState = useCallback(() => {
    setDraggedQueueItemId(null);
    setDragOverQueueItemId(null);
  }, []);

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
      resetExportFeedback();
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
    [duration, resetExportFeedback, seekTo, snapTrimRange]
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

  const startExport = useCallback(async (retryItemIds?: readonly number[]) => {
    if (files.length === 0 || exportControllerRef.current) return;
    const retryIds = retryItemIds ? new Set(retryItemIds) : null;
    const selectedItems = retryIds
      ? queueItems.filter(
          (item) => retryIds.has(item.id) && isBrowserBatchItemRetryable(queueStatuses[item.id])
        )
      : queueItems;
    if (selectedItems.length === 0) {
      showNotice("info", "There are no failed or cancelled browser batch items to retry.");
      return;
    }
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

    exportCancelledRef.current = false;
    const controller = new AbortController();
    exportControllerRef.current = controller;
    videoRef.current?.pause();
    setIsExporting(true);
    setWasmLoading(true);
    exportProgressRef.current = 0;
    exportUiUpdatedAtRef.current = 0;
    exportUiStatusRef.current = "";
    exportStartedAtRef.current = Date.now();
    setProgress(0);
    setExportStatus("Loading the local browser encoder…");
    setEta("ETA: estimating…");
    setLastExport(null);
    const exportSettings =
      batchMode && !standardFpsOptions.some((option) => option.value === settings.fps)
        ? { ...settings, fps: "off" }
        : settings;
    setQueueStatuses((current) => {
      if (!retryIds) return {};
      const next = { ...current };
      for (const item of selectedItems) next[item.id] = "queued";
      return next;
    });
    let downloadedCount = 0;

    try {
      const { BrowserFfmpegEngine, exportBrowserFile } = await loadBrowserExportModule();
      if (exportCancelledRef.current) throw new Error("Export cancelled.");
      const engine = engineRef.current ?? new BrowserFfmpegEngine();
      engineRef.current = engine;
      await engine.load();
      controller.signal.throwIfAborted();
      setWasmLoading(false);
      exportStartedAtRef.current = Date.now();
      let completed = 0;
      let failed = 0;
      let oversized = false;
      let normalizationSkipped = false;
      let audioRemovedForCompatibility = false;
      const totalFiles = selectedItems.length;
      for (let index = 0; index < totalFiles; index += 1) {
        if (exportCancelledRef.current) throw new Error("Export cancelled.");
        const item = selectedItems[index];
        const file = item.file;
        setQueueStatuses((current) => ({ ...current, [item.id]: "encoding" }));
        try {
          const fileMetadata =
            activeFile === file && metadata
              ? metadata
              : await readCachedMetadata(file, controller.signal);
          controller.signal.throwIfAborted();
          const fileStart = batchMode ? 0 : startTime;
          const fileEnd = batchMode ? fileMetadata.duration : endTime;
          setExportStatus(
            totalFiles > 1
              ? `Encoding ${index + 1} of ${totalFiles} · ${file.name}`
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
                ((index + fileProgress) / totalFiles) * 100
              );
              exportProgressRef.current = nextProgress;
              const nextStatus =
                totalFiles > 1 ? `${status} · ${index + 1}/${totalFiles}` : status;
              const now = Date.now();
              if (
                nextStatus !== exportUiStatusRef.current ||
                now - exportUiUpdatedAtRef.current >= 100 ||
                fileProgress >= 1
              ) {
                exportUiUpdatedAtRef.current = now;
                exportUiStatusRef.current = nextStatus;
                setProgress(nextProgress);
                setExportStatus(nextStatus);
              }
            },
          });
          if (exportCancelledRef.current) throw new Error("Export cancelled.");
          downloadBlob(result.blob, result.fileName);
          downloadedCount += 1;
          if (shouldCopyBrowserExport(exportMode, batchMode)) {
            const copied = await tryCopyBlobToClipboard(result.blob);
            if (copied) setExportStatus("Downloaded and copied to clipboard");
          }
          if (exportCancelledRef.current) throw new Error("Export cancelled.");
          setLastExport({ name: result.fileName, bytes: result.bytes });
          oversized = oversized || result.wasOversized;
          normalizationSkipped = normalizationSkipped || result.normalizationSkipped;
          audioRemovedForCompatibility =
            audioRemovedForCompatibility || result.audioRemovedForCompatibility;
          completed += 1;
          setQueueStatuses((current) => ({
            ...current,
            [item.id]: result.wasOversized ? "above-target" : "downloaded",
          }));
        } catch (error: unknown) {
          if (controller.signal.aborted || !batchMode) throw error;
          failed += 1;
          setQueueStatuses((current) => ({ ...current, [item.id]: "failed" }));
        }
        exportProgressRef.current = Math.max(
          exportProgressRef.current,
          ((index + 1) / totalFiles) * 100
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
        failed > 0
          ? `${completed} downloaded · ${failed} failed`
          : oversized
            ? "Downloaded · target could not be reached"
            : audioRemovedForCompatibility
              ? "Downloaded · audio removed for compatibility"
              : normalizationSkipped
                ? "Downloaded · audio normalization skipped"
                : "Downloaded successfully"
      );
      const warnings = [
        failed > 0 &&
          `${failed} could not be exported. Retry the failed items or try them in the desktop app.`,
        oversized && "Some outputs are still above the selected size target.",
        audioRemovedForCompatibility &&
          "Audio was removed from exports whose source audio could not be encoded in the browser.",
        normalizationSkipped &&
          "Audio normalization was skipped where the source audio filter was unavailable.",
      ]
        .filter(Boolean)
        .join(" ");
      showNotice(
        completed === 0 ? "error" : warnings ? "warning" : "success",
        `${completed} ${completed === 1 ? "file" : "files"} downloaded. ${warnings || "Processing stayed on this device."}`
      );
    } catch (error: unknown) {
      if (exportCancelledRef.current) {
        setExportStatus("Cancelled");
        setQueueStatuses((current) => {
          const next = { ...current };
          for (const item of selectedItems) {
            const status = next[item.id];
            if (!status || status === "queued" || status === "encoding") {
              next[item.id] = "cancelled";
            }
          }
          return next;
        });
        setEta("Cancelled");
        showNotice(
          "info",
          downloadedCount > 0
            ? `Export cancelled. ${downloadedCount} ${downloadedCount === 1 ? "file was" : "files were"} downloaded before cancellation.`
            : "Export cancelled. No files were downloaded."
        );
      } else {
        setExportStatus("Export failed");
        setEta("Unavailable");
        showNotice("error", String(error));
      }
    } finally {
      exportControllerRef.current = null;
      setIsExporting(false);
      setWasmLoading(false);
    }
  }, [
    activeFile,
    batchMode,
    endTime,
    exportMode,
    files,
    losslessKeyframeError,
    losslessKeyframes,
    losslessKeyframesLoading,
    metadata,
    queueItems,
    queueStatuses,
    readCachedMetadata,
    settings,
    showNotice,
    standardFpsOptions,
    startTime,
  ]);

  const retryBrowserBatchItem = useCallback(
    (itemId: number) => {
      if (isExporting) return;
      const item = queueItems.find((candidate) => candidate.id === itemId);
      if (!item || !isBrowserBatchItemRetryable(queueStatuses[item.id])) return;
      void startExport([itemId]);
    },
    [isExporting, queueItems, queueStatuses, startExport]
  );

  const retryFailedBrowserBatchItems = useCallback(() => {
    if (isExporting) return;
    const retryableIds = queueItems
      .filter((item) => isBrowserBatchItemRetryable(queueStatuses[item.id]))
      .map((item) => item.id);
    if (retryableIds.length > 0) void startExport(retryableIds);
  }, [isExporting, queueItems, queueStatuses, startExport]);

  const cancelExport = useCallback(() => {
    if (!isExporting) return;
    exportCancelledRef.current = true;
    exportControllerRef.current?.abort(new Error("Export cancelled."));
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
  const retryableBatchCount = batchMode
    ? queueItems.filter((item) => isBrowserBatchItemRetryable(queueStatuses[item.id])).length
    : 0;
  const actionLabel = batchMode
    ? `Export ${files.length} videos`
    : activeMode === "gif"
      ? "Create GIF"
      : activeMode === "lossless"
        ? "Trim without re-encoding"
        : plan?.targetSizeMb
          ? `Compress to ${plan.targetSizeMb} MB`
          : "Export video";
  const outputSummary = batchMode
    ? `${files.length} videos · ${selectedQuality.label}`
    : plan
      ? plan.summary
      : "Choose a video to preview the export";

  return (
    <>
      <section className="web-hero web-demo-section" aria-labelledby="web-demo-title">
        <div className="web-hero-copy">
          <h2 id="web-demo-title">Compress a file quickly in your browser.</h2>
          <p className="web-hero-lede">
            Try the no-install demo when you only need a quick export. Your file stays on this
            device while FFmpeg WebAssembly creates a browser download.
          </p>
          <div className="web-hero-actions">
            <a className="web-marketing-text-link" href="#desktop-app">
              See the full desktop workflow
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
              accept={VIDEO_FILE_ACCEPT}
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
                      ? "Batch mode · one profile for every full-duration video"
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
                    audioAvailable={batchMode ? undefined : metadata?.hasAudio}
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
                    audioAvailable={batchMode ? undefined : metadata?.hasAudio}
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
                      value={settings.gifTargetMb}
                      disabled={isExporting}
                      onChange={(event) =>
                        patchSettings({
                          gifTargetMb: Number(event.target.value) as BrowserSettings["gifTargetMb"],
                        })
                      }
                    >
                      {GIF_PRESETS.map((preset) => (
                        <option value={preset.sizeMb} key={preset.label}>
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
                    Copies the original video at keyframes; audio removal does not re-encode.
                  </span>
                  <button
                    type="button"
                    className={`web-lossless-audio-toggle${settings.removeAudio && metadata?.hasAudio !== false ? " active" : ""}`}
                    title={
                      metadata?.hasAudio === false
                        ? "No audio track detected"
                        : settings.removeAudio
                          ? "Keep audio"
                          : "Remove audio tracks"
                    }
                    aria-label={
                      metadata?.hasAudio === false
                        ? "No audio track detected"
                        : settings.removeAudio
                          ? "Keep audio"
                          : "Remove audio tracks"
                    }
                    aria-pressed={settings.removeAudio && metadata?.hasAudio !== false}
                    disabled={isExporting || metadata?.hasAudio === false}
                    onClick={() => setBrowserRemoveAudio(!settings.removeAudio)}
                  >
                    <AudioIcon
                      type="mute"
                      active={settings.removeAudio && metadata?.hasAudio !== false}
                    />
                    <span>
                      {metadata?.hasAudio === false
                        ? "No audio track"
                        : settings.removeAudio
                          ? "Audio removed"
                          : "Keep audio"}
                    </span>
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
                    <div className="web-queue-heading-actions">
                      <span className="web-queue-note">Same profile · full duration</span>
                      {retryableBatchCount > 0 && (
                        <button
                          type="button"
                          className="web-queue-retry-all"
                          onClick={retryFailedBrowserBatchItems}
                          disabled={isExporting}
                          aria-label={`Retry ${retryableBatchCount} unsuccessful browser batch item${retryableBatchCount === 1 ? "" : "s"}`}
                        >
                          Retry {retryableBatchCount === 1 ? "item" : `${retryableBatchCount} items`}
                        </button>
                      )}
                    </div>
                  </div>
                  <ol className="web-queue-list" aria-label="Browser batch queue">
                    {queueItems.map((item, index) => {
                      const file = item.file;
                      const status = queueStatuses[item.id];
                      const retryable = isBrowserBatchItemRetryable(status);
                      return (
                        <li
                          key={item.id}
                          className={`${index === activeFileIndex ? "active" : ""}${
                            draggedQueueItemId === item.id ? " dragging" : ""
                          }${dragOverQueueItemId === item.id ? " drag-over" : ""}`}
                          draggable={!isExporting}
                          onDragStart={(event) => {
                            if (isExporting) return;
                            setDraggedQueueItemId(item.id);
                            if (event.dataTransfer) {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", String(item.id));
                            }
                          }}
                          onDragOver={(event) => {
                            if (isExporting) return;
                            event.preventDefault();
                            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                            if (draggedQueueItemId !== item.id) setDragOverQueueItemId(item.id);
                          }}
                          onDrop={(event) => {
                            if (isExporting) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const transferValue = event.dataTransfer?.getData("text/plain") ?? "";
                            const dataTransferId = Number(transferValue);
                            const sourceId =
                              draggedQueueItemId ??
                              (Number.isInteger(dataTransferId) ? dataTransferId : null);
                            if (sourceId !== null && sourceId !== item.id) {
                              reorderQueuedFile(sourceId, item.id);
                            }
                            clearQueueDragState();
                          }}
                          onDragEnd={clearQueueDragState}
                        >
                          <button
                            type="button"
                            className="web-queue-item"
                            disabled={isExporting}
                            onClick={() => {
                              setActiveFileIndex(index);
                            }}
                          >
                            <span className="web-queue-index">{index + 1}</span>
                            <span
                              className="web-queue-drag-handle"
                              aria-hidden="true"
                              title="Drag to reorder"
                            >
                              ⋮⋮
                            </span>
                            <span className="web-queue-name" title={file.name}>
                              {file.name}
                            </span>
                            <span className="web-queue-size">
                              {status ? browserBatchStatusLabel(status) : formatFileSize(file.size)}
                            </span>
                          </button>
                          <span className="web-queue-controls">
                            <button
                              type="button"
                              className="web-queue-move"
                              onClick={() => moveQueuedFile(item.id, "up")}
                              disabled={isExporting || index === 0}
                              aria-label={`Move ${file.name} up in queue`}
                              title="Move up"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="web-queue-move"
                              onClick={() => moveQueuedFile(item.id, "down")}
                              disabled={isExporting || index === queueItems.length - 1}
                              aria-label={`Move ${file.name} down in queue`}
                              title="Move down"
                            >
                              ↓
                            </button>
                            {retryable && (
                              <button
                                type="button"
                                className="web-queue-retry"
                                onClick={() => retryBrowserBatchItem(item.id)}
                                disabled={isExporting}
                                aria-label={`Retry ${file.name}`}
                                title="Retry this item"
                              >
                                Retry
                              </button>
                            )}
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
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ) : (
                <section className="web-preview-panel" aria-label="Video preview">
                  <div className="web-preview-frame">
                    {previewUrl && !previewError ? (
                      <>
                        <PreviewCrop crop={settings.mode === "lossless" ? "off" : settings.crop}>
                          <video
                            ref={videoRef}
                            src={previewUrl}
                            playsInline
                            preload="metadata"
                            onTimeUpdate={handleVideoTimeUpdate}
                            onPlay={() => setPreviewPlaying(true)}
                            onPause={() => setPreviewPlaying(false)}
                            onEnded={handleVideoEnded}
                            onError={() =>
                              setPreviewError("The browser could not play this video.")
                            }
                            onLoadedMetadata={(event) => {
                              if (!metadata && Number.isFinite(event.currentTarget.duration)) {
                                setEndTime(event.currentTarget.duration);
                              }
                            }}
                          />
                        </PreviewCrop>
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
                              : previewError
                                ? "Preview unavailable"
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
                  historyKey={`${loadGenerationRef.current}\0${activeMode}`}
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
                  !isExporting &&
                  ((!batchMode && !metadata) ||
                    metadataLoading ||
                    wasmLoading ||
                    (activeMode === "lossless" &&
                      (losslessKeyframesLoading ||
                        losslessKeyframes.length === 0 ||
                        Boolean(losslessKeyframeError))))
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
      {notice && (
        <div
          className={`web-notice ${notice.type}`}
          role={notice.type === "error" ? "alert" : "status"}
        >
          {notice.message}
        </div>
      )}
    </>
  );
}

function WebApp() {
  const dropHandlerRef = useRef<PageDropHandler>(null);
  return (
    <div
      className="web-app"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => dropHandlerRef.current?.(event)}
    >
      <header className="web-header">
        <Logo />
        <nav className="web-header-nav" aria-label="Main navigation">
          <a href="#desktop-app">Desktop App</a>
          <a href="#web-editor">Web Demo</a>
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
        <DesktopUpgrade>
          <WebEditor dropHandlerRef={dropHandlerRef} />
        </DesktopUpgrade>
      </main>

      <footer className="site-footer">
        <div>
          <a className="footer-brand" href="#desktop-app">
            <picture>
              <source
                type="image/webp"
                srcSet={`${MARKETING_ASSET_BASE}/icon-64.webp 64w, ${MARKETING_ASSET_BASE}/icon-128.webp 128w`}
                sizes="34px"
              />
              <img src={`${MARKETING_ASSET_BASE}/icon.png`} width="128" height="128" alt="" />
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
    </div>
  );
}

export default WebApp;
