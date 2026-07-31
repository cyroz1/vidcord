import {
  useEffect,
  useCallback,
  useState,
  useMemo,
  useRef,
  lazy,
  memo,
  Suspense,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import "./App.css";
import Toast from "./components/Toast";
import ProgressSection from "./components/ProgressSection";
import PreviewPane, { type PreviewHandle } from "./components/PreviewPane";
import TrimTimeline, { type SnapMode } from "./components/TrimTimeline";
import { useToasts } from "./hooks/useToasts";
import { useSettings, type CompletionAction, type OutputDestination } from "./hooks/useSettings";
import { useEncoders, type Encoder } from "./hooks/useEncoders";
import {
  FFMPEG_MISSING_LOAD_MESSAGE,
  FFMPEG_MISSING_TOAST_MESSAGE,
  isFfmpegMissingError,
} from "./ffmpegErrors";
import {
  useCompression,
  resolveVideoBitrate,
  resolutionToShortSide,
  computeTargetDimensions,
  type ProbeData,
} from "./hooks/useCompression";
import {
  captureSnapshot,
  checkForUpdates,
  compressVideo,
  copyFileToClipboard,
  discardStagedOutput,
  downloadAndOpenUpdateInstaller,
  frontendReady,
  getLosslessTrimInfo,
  getOs,
  getVaapiDevice,
  installFfmpegDependency,
  listFfmpegVideoEncoders,
  probe as probeVideo,
  publishStagedOutput,
  resolveOutputPath,
  resolveStagingOutputPath,
  showInFileExplorer,
  type OutputExtension,
  type FfmpegInstallResult,
} from "./ipc";
import {
  getSelectionCenter,
  getTimelineViewBounds,
  timeToTimelineValue,
  TIMELINE_ZOOM_MAX,
} from "./timelineZoom";
import {
  losslessTrimFitsTarget,
  normalizeLosslessKeyframes,
  snapLosslessTrimRange,
  type LosslessTrimInfo,
} from "./losslessTrim";
import {
  formatAverageBitrate,
  formatCodec,
  formatFrameRate,
  formatVideoDuration,
  getAvailableCropOptions,
  getCroppedDimensions,
} from "./videoMetadata";
import { MAX_SETTINGS_PRESETS, type SettingsPreset } from "./settingsPresets";
import pkg from "../package.json";

// EncodersDialog is only shown after an explicit user click from Advanced
// Mode; lazy-loading it keeps the initial JS bundle smaller and is rendered
// under a <Suspense> boundary below.
const EncodersDialog = lazy(() => import("./components/EncodersDialog"));
const SettingsPresets = lazy(() => import("./components/SettingsPresets"));

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

const GIF_PRESETS = [
  { label: "10MB", size_mb: 10, target_h: 480 },
  { label: "50MB", size_mb: 50, target_h: 720 },
] as const;
const GIF_FPS_OPTIONS = [15, 30, 50] as const;

const RESOLUTION_OPTIONS = ["Native", "4K", "1440p", "1080p", "720p", "480p"];
const FPS_OPTIONS = [
  { label: "Source", value: "off", fps: null },
  { label: "24", value: "24", fps: 24 },
  { label: "30", value: "30", fps: 30 },
  { label: "60", value: "60", fps: 60 },
] as const;

const H265_WARNING_MESSAGE =
  "H.265 compresses more efficiently (better quality at the same target size), but isn't supported on all devices, browsers, or older Discord clients - recipients may see a black screen or audio-only playback.";

const SLIDER_MAX = 10000;
const MIN_TRIM_GAP = 1;
const UNDO_LIMIT = 200;
const FRAME_STEP_SECONDS = 1 / 30;
const UPDATE_CHECK_DELAY_MS = 8000;
const SUPPORTED_VIDEO_EXTENSION = /\.(mp4|avi|mov|mkv|flv|wmv|webm)$/i;
const EDITABLE_TARGET_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const NATIVE_CONTEXT_MENU_SELECTOR = `${EDITABLE_TARGET_SELECTOR}, pre, code`;
const INTERACTIVE_TARGET_SELECTOR = [
  EDITABLE_TARGET_SELECTOR,
  "button",
  "a[href]",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='menuitem']",
  "[role='option']",
  "[role='slider']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function targetMatches(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return targetMatches(target, EDITABLE_TARGET_SELECTOR);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return targetMatches(target, INTERACTIVE_TARGET_SELECTOR);
}

function preservesNativeContextMenu(target: EventTarget | null): boolean {
  return targetMatches(target, NATIVE_CONTEXT_MENU_SELECTOR);
}

function outputExtensionForPath(path: string, fallback: OutputExtension): OutputExtension {
  const extension = path
    .split(/[./\\]/)
    .pop()
    ?.toLowerCase();
  if (
    extension === "mp4" ||
    extension === "mov" ||
    extension === "mkv" ||
    extension === "webm" ||
    extension === "avi" ||
    extension === "flv" ||
    extension === "wmv" ||
    extension === "gif" ||
    extension === "png"
  ) {
    return extension;
  }
  return fallback;
}

async function openExternalUrl(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

function isH265Encoder(name: string): boolean {
  return name === "libx265" || name.startsWith("hevc_");
}

function parseListedEncoderNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim().split(/\s+/)[0] ?? "";
    if (/^[A-Za-z0-9_]+$/.test(name)) names.add(name);
  }
  return Array.from(names);
}

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

type MemoizedSubtreeProps = {
  dependencies: readonly unknown[];
  render: () => ReactNode;
};

type WorkflowMode = "compress" | "advanced" | "lossless" | "gif";

type WorkflowModeSelectorProps = {
  mode: WorkflowMode;
  onModeChange: (mode: WorkflowMode) => void;
};

const VIDEO_FILE_ICON = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.6" />
    <path d="m10 9 5 3-5 3V9Z" fill="currentColor" />
  </svg>
);

const WorkflowModeSelector = memo(function WorkflowModeSelector({
  mode,
  onModeChange,
}: WorkflowModeSelectorProps) {
  return (
    <div className="workflow-mode-selector" role="group" aria-label="Export mode">
      <button
        type="button"
        className={mode === "compress" ? "active" : ""}
        aria-pressed={mode === "compress"}
        onClick={() => onModeChange("compress")}
      >
        Compress
      </button>
      <button
        type="button"
        className={mode === "advanced" ? "active" : ""}
        aria-pressed={mode === "advanced"}
        onClick={() => onModeChange("advanced")}
      >
        Advanced
      </button>
      <button
        type="button"
        className={mode === "lossless" ? "active" : ""}
        aria-pressed={mode === "lossless"}
        onClick={() => onModeChange("lossless")}
      >
        Lossless Trim
      </button>
      <button
        type="button"
        className={mode === "gif" ? "active" : ""}
        aria-pressed={mode === "gif"}
        onClick={() => onModeChange("gif")}
      >
        GIF
      </button>
    </div>
  );
});

const MemoizedSubtree = memo(
  function MemoizedSubtree({ render }: MemoizedSubtreeProps) {
    return render();
  },
  (previous, next) =>
    previous.dependencies.length === next.dependencies.length &&
    previous.dependencies.every((value, index) => Object.is(value, next.dependencies[index]))
);

export default function App() {
  // --- Hooks ---
  const { toasts, addToast, removeToast } = useToasts();
  const {
    settingsRef,
    settingsLoaded,
    qualityIdx,
    setQualityIdx,
    gifMode,
    setGifMode,
    gifQualityIdx,
    setGifQualityIdx,
    gifFps,
    setGifFps,
    advancedMode,
    setAdvancedMode,
    losslessMode,
    setLosslessMode,
    advSize,
    setAdvSize,
    advResolution,
    setAdvResolution,
    fpsOption,
    setFpsOption,
    advFps,
    setAdvFps,
    advEncoder,
    setAdvEncoder,
    removeAudio,
    setRemoveAudio,
    audioNormalize,
    setAudioNormalize,
    cropAspectRatio,
    setCropAspectRatio,
    outputDestination,
    setOutputDestination,
    customOutputDirectory,
    setCustomOutputDirectory,
    completionAction,
    setCompletionAction,
    presets,
    getSettingsSnapshot,
    restoreSettings,
    savePreset,
    deletePreset,
    saveSettings,
  } = useSettings();
  const persistDetectedEncoders = useCallback(
    (detected: Encoder[]) => {
      saveSettings({ encoder_capabilities: detected });
    },
    [saveSettings]
  );

  // File state is declared before encoder discovery so the startup refresh can
  // yield to a cold Open With / drag-drop probe instead of competing for FFmpeg.
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileLoadGeneration, setFileLoadGeneration] = useState(0);
  const [fileName, setFileName] = useState("Drag a video here or click Browse");
  const [probeData, setProbeData] = useState<ProbeData | null>(null);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [losslessInfo, setLosslessInfo] = useState<LosslessTrimInfo | null>(null);
  const [losslessInfoLoading, setLosslessInfoLoading] = useState(false);
  const [losslessInfoError, setLosslessInfoError] = useState<string | null>(null);
  const [losslessOfferMode, setLosslessOfferMode] = useState(false);
  const [losslessOfferTargetSize, setLosslessOfferTargetSize] = useState<number | null>(null);
  const skipLosslessOfferRef = useRef(false);
  const startCompressRef = useRef<() => Promise<void>>(async () => {});
  const [startVal, setStartVal] = useState(0);
  const [endVal, setEndVal] = useState(SLIDER_MAX);

  const { encoders, encoderIdx, setEncoderIdx, ffmpegMissing, refreshEncoders, markFfmpegMissing } =
    useEncoders({
      settingsLoaded,
      startupBusy: loadingVideo,
      savedEncoderLabel: settingsRef.current.encoder_label as string | undefined,
      savedEncoderIndex: (settingsRef.current.encoder_index as number) ?? 0,
      cachedEncoders: settingsRef.current.encoder_capabilities,
      onEncodersDetected: persistDetectedEncoders,
      onFfmpegMissing: () => addToast("error", "FFmpeg Not Found", FFMPEG_MISSING_TOAST_MESSAGE),
    });
  const { compressing, setCompressing, cancelling, progress, eta, cancelCompress, resetProgress } =
    useCompression({ onToast: addToast });

  const previewRef = useRef<PreviewHandle>(null);
  const trimWrapRef = useRef<HTMLDivElement>(null);
  const trimPlayheadElementRef = useRef<HTMLDivElement>(null);
  const playheadTimeRef = useRef<number | null>(null);
  const activeHandleRef = useRef<"start" | "end">("start");
  const startValRef = useRef(0);
  const endValRef = useRef(SLIDER_MAX);
  const trimStateRafRef = useRef<number | null>(null);
  const pendingTrimStateRef = useRef<{ start: number; end: number } | null>(null);
  const scrubPreviewRafRef = useRef<number | null>(null);
  const pendingScrubPreviewRef = useRef<{ time: number | null; active: boolean } | null>(null);
  const previewFocusTimeRef = useRef<number | null>(null);
  const playheadSeekRafRef = useRef<number | null>(null);
  const pendingPlayheadClientXRef = useRef<number | null>(null);
  const suppressNextTimelineClickRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const selectedFilePathRef = useRef<string | null>(null);
  const probeDataRef = useRef<ProbeData | null>(null);
  const losslessInfoRef = useRef<LosslessTrimInfo | null>(null);
  const losslessInfoRequestRef = useRef(0);
  const appContentRef = useRef<HTMLDivElement>(null);
  const updateModalRef = useRef<HTMLDivElement>(null);
  const updatePrimaryActionRef = useRef<HTMLButtonElement>(null);
  const updatePreviousFocusRef = useRef<HTMLElement | null>(null);
  const installingUpdateRef = useRef(false);
  const pointerHistoryStartRef = useRef<{ start: number; end: number } | null>(null);
  const pointerGestureCleanupRef = useRef<(() => void) | null>(null);
  const undoStackRef = useRef<Array<{ start: number; end: number }>>([]);
  const redoStackRef = useRef<Array<{ start: number; end: number }>>([]);
  const [trimHistorySize, setTrimHistorySize] = useState({ undo: 0, redo: 0 });
  const [previewFocusTime, setPreviewFocusTime] = useState<number | null>(null);
  const [previewScrubbing, setPreviewScrubbing] = useState(false);
  const [canSetInPoint, setCanSetInPoint] = useState(false);
  const [canSetOutPoint, setCanSetOutPoint] = useState(false);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [snapMode, setSnapMode] = useState<SnapMode>("off");
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [timelineCenterVal, setTimelineCenterVal] = useState(SLIDER_MAX / 2);

  // --- UI state ---
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    url: string;
    installerAvailable: boolean;
    installerName?: string;
  } | null>(null);
  const [encodersDialogText, setEncodersDialogText] = useState<string | null>(null);
  const [listedEncoderNames, setListedEncoderNames] = useState<string[]>([]);
  const [installingFfmpeg, setInstallingFfmpeg] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [finalizingOutput, setFinalizingOutput] = useState(false);
  const [encoderInputFocused, setEncoderInputFocused] = useState(false);
  const [activeEncoderOption, setActiveEncoderOption] = useState(0);
  const showUpdateModal = updateInfo !== null && encodersDialogText === null;
  const modalOpen = updateInfo !== null || encodersDialogText !== null;

  const duration = probeData?.duration ?? 0;
  const sourceFrameRate =
    typeof probeData?.frame_rate === "number" &&
    Number.isFinite(probeData.frame_rate) &&
    probeData.frame_rate > 0
      ? probeData.frame_rate
      : null;
  const standardFpsOptions = useMemo(
    () =>
      FPS_OPTIONS.filter(
        (option) => option.fps === null || sourceFrameRate === null || option.fps <= sourceFrameRate
      ),
    [sourceFrameRate]
  );
  const standardFpsValue = standardFpsOptions.some((option) => option.value === fpsOption)
    ? fpsOption
    : "off";
  const clearLosslessOfferMode = useCallback(() => {
    setLosslessOfferMode(false);
    setLosslessOfferTargetSize(null);
  }, []);
  const losslessTrim = !gifMode && (losslessMode || losslessOfferMode);
  const workflowMode: WorkflowMode = gifMode
    ? "gif"
    : losslessTrim
      ? "lossless"
      : advancedMode
        ? "advanced"
        : "compress";
  const selectWorkflowMode = useCallback(
    (mode: WorkflowMode) => {
      clearLosslessOfferMode();
      if (mode === "gif") {
        setGifMode(true);
        setLosslessMode(false);
        setAdvancedMode(false);
        saveSettings({
          gif_mode: true,
          lossless_mode: false,
          advanced_mode: false,
        });
        return;
      }
      if (mode === "lossless") {
        setGifMode(false);
        setLosslessMode(true);
        setAdvancedMode(false);
        saveSettings({
          gif_mode: false,
          lossless_mode: true,
          advanced_mode: false,
        });
        return;
      }
      if (mode === "advanced") {
        setGifMode(false);
        setLosslessMode(false);
        setAdvancedMode(true);
        saveSettings({
          gif_mode: false,
          lossless_mode: false,
          advanced_mode: true,
        });
        return;
      }
      setGifMode(false);
      setLosslessMode(false);
      setAdvancedMode(false);
      saveSettings({
        gif_mode: false,
        lossless_mode: false,
        advanced_mode: false,
      });
    },
    [clearLosslessOfferMode, saveSettings, setAdvancedMode, setGifMode, setLosslessMode]
  );
  const importDetails = useMemo(() => {
    if (!probeData) return null;
    const resolution = `${probeData.width}×${probeData.height}`;
    const frameRate = formatFrameRate(probeData.frame_rate);
    const codec = formatCodec(probeData.codec);
    const bitrate = formatAverageBitrate(probeData.bitrate);
    const length = formatVideoDuration(probeData.duration);
    return {
      text: `${resolution} · ${frameRate} · ${codec} · ${bitrate} · ${length}`,
      label: `Resolution ${resolution}, frame rate ${frameRate}, codec ${codec}, average bitrate ${bitrate}, length ${length}`,
    };
  }, [probeData]);

  const displayW = probeData ? probeData.display_width || probeData.width : undefined;
  const displayH = probeData ? probeData.display_height || probeData.height : undefined;

  const cropOptions = useMemo(
    () => getAvailableCropOptions(displayW, displayH),
    [displayW, displayH]
  );
  const selectedQualityPreset = QUALITY_PRESETS[qualityIdx] ?? QUALITY_PRESETS[0];
  const selectedGifPreset = GIF_PRESETS[gifQualityIdx] ?? GIF_PRESETS[0];
  const advancedTargetSize = Number(advSize.trim());
  const hasAdvancedTargetSize = Number.isFinite(advancedTargetSize) && advancedTargetSize > 0;
  const exportSummary = gifMode
    ? `GIF · up to ${selectedGifPreset.size_mb} MB · ${gifFps} fps`
    : losslessTrim
      ? "Original quality · keyframe-aligned trim"
      : advancedMode
        ? `${hasAdvancedTargetSize ? `Up to ${advancedTargetSize} MB` : "Source bitrate"} · ${advResolution} · ${
            advFps.trim() ? `${advFps.trim()} fps` : "Keep source FPS"
          }`
        : `Up to ${selectedQualityPreset.size_mb} MB · ${
            selectedQualityPreset.target_h
              ? `${selectedQualityPreset.target_h}p`
              : "Native resolution"
          } · ${standardFpsValue === "off" ? "Keep source FPS" : `${standardFpsValue} fps`}`;
  const readyActionLabel = gifMode
    ? `Create ${selectedGifPreset.size_mb} MB GIF`
    : losslessTrim
      ? "Trim Without Re-encoding"
      : advancedMode && hasAdvancedTargetSize
        ? `Compress to ${advancedTargetSize} MB`
        : !advancedMode
          ? `Compress to ${selectedQualityPreset.size_mb} MB`
          : "Compress Video";
  const showProgress = compressing || cancelling || finalizingOutput || eta !== "Ready";

  useEffect(() => {
    if (cropAspectRatio !== "off" && !cropOptions.some((o) => o.value === cropAspectRatio)) {
      setCropAspectRatio("off");
      saveSettings({ crop_aspect_ratio: "off" });
    }
  }, [cropAspectRatio, cropOptions, setCropAspectRatio, saveSettings]);

  const clampPreviewFocusTime = useCallback(
    (time: number | null) => {
      if (time === null || !Number.isFinite(time)) return null;
      return duration > 0 ? Math.max(0, Math.min(time, duration)) : Math.max(0, time);
    },
    [duration]
  );

  const sliderValueToTime = useCallback(
    (value: number) => {
      if (duration <= 0) return 0;
      return (Math.max(0, Math.min(value, SLIDER_MAX)) / SLIDER_MAX) * duration;
    },
    [duration]
  );

  const flushScrubPreviewState = useCallback(() => {
    scrubPreviewRafRef.current = null;
    const pending = pendingScrubPreviewRef.current;
    pendingScrubPreviewRef.current = null;
    if (!pending) return;
    previewFocusTimeRef.current = pending.time;
    if (pending.time !== null) {
      previewRef.current?.seekTo(pending.time);
    }
    setPreviewFocusTime(pending.time);
    setPreviewScrubbing(pending.active);
  }, []);

  const schedulePreviewFocus = useCallback(
    (time: number | null, active: boolean) => {
      pendingScrubPreviewRef.current = {
        time: clampPreviewFocusTime(time),
        active,
      };
      if (scrubPreviewRafRef.current !== null) return;
      scrubPreviewRafRef.current = window.requestAnimationFrame(flushScrubPreviewState);
    },
    [clampPreviewFocusTime, flushScrubPreviewState]
  );

  const setPreviewFocusNow = useCallback(
    (time: number | null, active: boolean) => {
      if (scrubPreviewRafRef.current !== null) {
        window.cancelAnimationFrame(scrubPreviewRafRef.current);
        scrubPreviewRafRef.current = null;
      }
      pendingScrubPreviewRef.current = null;
      const nextTime = clampPreviewFocusTime(time);
      previewFocusTimeRef.current = nextTime;
      if (nextTime !== null) {
        previewRef.current?.seekTo(nextTime);
      }
      setPreviewFocusTime(nextTime);
      setPreviewScrubbing(active);
    },
    [clampPreviewFocusTime]
  );

  const finishPreviewScrub = useCallback(
    (time?: number | null) => {
      setPreviewFocusNow(time === undefined ? previewFocusTimeRef.current : time, false);
    },
    [setPreviewFocusNow]
  );

  const pushUndoSnapshot = useCallback((snapshot: { start: number; end: number }) => {
    undoStackRef.current.push(snapshot);
    if (undoStackRef.current.length > UNDO_LIMIT) {
      undoStackRef.current.shift();
    }
  }, []);

  const syncTrimHistorySize = useCallback(() => {
    const undo = undoStackRef.current.length;
    const redo = redoStackRef.current.length;
    setTrimHistorySize((current) =>
      current.undo === undo && current.redo === redo ? current : { undo, redo }
    );
  }, []);

  const snapSliderValue = useCallback(
    (value: number) => {
      if (snapMode === "off" || duration <= 0) return Math.round(value);
      const snapSeconds = Number(snapMode);
      if (!Number.isFinite(snapSeconds) || snapSeconds <= 0) return Math.round(value);
      const snapSliderStep = Math.max(1, (snapSeconds / duration) * SLIDER_MAX);
      return Math.round(value / snapSliderStep) * snapSliderStep;
    },
    [snapMode, duration]
  );

  const normalizeTrim = useCallback(
    (rawStart: number, rawEnd: number, anchor: "start" | "end" = "start") => {
      let nextStart = Math.max(0, Math.min(rawStart, SLIDER_MAX));
      let nextEnd = Math.max(0, Math.min(rawEnd, SLIDER_MAX));
      if (!losslessTrim) {
        nextStart = snapSliderValue(nextStart);
        nextEnd = snapSliderValue(nextEnd);
      }

      const keyframeTimes = losslessInfoRef.current?.keyframe_times ?? [];
      if (losslessTrim && duration > 0 && keyframeTimes.length > 0) {
        const snapped = snapLosslessTrimRange(
          (nextStart / SLIDER_MAX) * duration,
          (nextEnd / SLIDER_MAX) * duration,
          duration,
          keyframeTimes
        );
        if (snapped) {
          nextStart = (snapped.start / duration) * SLIDER_MAX;
          nextEnd = (snapped.end / duration) * SLIDER_MAX;
        }
      }

      if (nextEnd - nextStart < MIN_TRIM_GAP) {
        if (anchor === "start") {
          nextEnd = Math.min(SLIDER_MAX, nextStart + MIN_TRIM_GAP);
          if (nextEnd - nextStart < MIN_TRIM_GAP) nextStart = nextEnd - MIN_TRIM_GAP;
        } else {
          nextStart = Math.max(0, nextEnd - MIN_TRIM_GAP);
          if (nextEnd - nextStart < MIN_TRIM_GAP) nextEnd = nextStart + MIN_TRIM_GAP;
        }
      }

      nextStart = Math.max(0, Math.min(nextStart, SLIDER_MAX - MIN_TRIM_GAP));
      nextEnd = Math.max(MIN_TRIM_GAP, Math.min(nextEnd, SLIDER_MAX));
      return {
        start: Math.round(nextStart),
        end: Math.round(nextEnd),
      };
    },
    [duration, losslessTrim, snapSliderValue]
  );

  const flushTrimState = useCallback(() => {
    trimStateRafRef.current = null;
    const pending = pendingTrimStateRef.current;
    pendingTrimStateRef.current = null;
    if (!pending) return;
    setStartVal(pending.start);
    setEndVal(pending.end);
  }, []);

  const scheduleTrimState = useCallback(
    (next: { start: number; end: number }) => {
      pendingTrimStateRef.current = next;
      if (trimStateRafRef.current !== null) return;
      trimStateRafRef.current = window.requestAnimationFrame(flushTrimState);
    },
    [flushTrimState]
  );

  const flushPendingTrimStateNow = useCallback(() => {
    if (trimStateRafRef.current !== null) {
      window.cancelAnimationFrame(trimStateRafRef.current);
      trimStateRafRef.current = null;
    }
    flushTrimState();
  }, [flushTrimState]);

  const applyTrim = useCallback(
    (rawStart: number, rawEnd: number, opts?: { record?: boolean; anchor?: "start" | "end" }) => {
      const anchor = opts?.anchor ?? "start";
      const record = opts?.record ?? true;
      const prev = { start: startValRef.current, end: endValRef.current };
      const next = normalizeTrim(rawStart, rawEnd, anchor);
      if (next.start === prev.start && next.end === prev.end) return null;
      if (record) {
        pushUndoSnapshot(prev);
        redoStackRef.current = [];
        syncTrimHistorySize();
      }
      // Update refs synchronously so any same-frame read (commitPointerTrimChange,
      // rapid undo/redo) sees the new values rather than waiting for useEffect.
      startValRef.current = next.start;
      endValRef.current = next.end;
      scheduleTrimState(next);
      return next;
    },
    [normalizeTrim, pushUndoSnapshot, scheduleTrimState, syncTrimHistorySize]
  );

  const undoTrim = useCallback(() => {
    const target = undoStackRef.current.pop();
    if (!target) return;
    redoStackRef.current.push({ start: startValRef.current, end: endValRef.current });
    startValRef.current = target.start;
    endValRef.current = target.end;
    pendingTrimStateRef.current = null;
    if (trimStateRafRef.current !== null) {
      window.cancelAnimationFrame(trimStateRafRef.current);
      trimStateRafRef.current = null;
    }
    setStartVal(target.start);
    setEndVal(target.end);
    syncTrimHistorySize();
    setPreviewFocusNow(sliderValueToTime(target.start), false);
  }, [setPreviewFocusNow, sliderValueToTime, syncTrimHistorySize]);

  const handleSnapshot = useCallback(
    async (timeSec: number) => {
      if (!filePath) return;
      try {
        let targetPath: string | null = null;
        if (outputDestination === "ask") {
          const stem = fileName.replace(/\.[^.]+$/, "") || "snapshot";
          const selected = await saveDialog({
            title: "Save Frame Snapshot",
            defaultPath: `${stem}-snapshot.png`,
            filters: [{ name: "PNG Image", extensions: ["png"] }],
          });
          if (!selected) return;
          targetPath = /\.png$/i.test(selected) ? selected : `${selected}.png`;
        } else {
          targetPath = await resolveOutputPath(
            filePath,
            outputDestination === "custom" ? customOutputDirectory : undefined,
            outputDestination === "source",
            "png"
          );
        }

        if (!targetPath) return;

        const savedPath = await captureSnapshot(filePath, timeSec, targetPath);
        const displayFileName = savedPath.split(/[/\\]/).pop() ?? "snapshot.png";

        if (completionAction === "copy") {
          try {
            await copyFileToClipboard(savedPath);
            addToast(
              "info",
              "Snapshot Saved & Copied",
              `Saved ${displayFileName} and copied to clipboard.`
            );
          } catch {
            await showInFileExplorer(savedPath).catch(() => {});
            addToast("info", "Snapshot Saved", `Saved ${displayFileName}.`);
          }
        } else {
          await showInFileExplorer(savedPath).catch(() => {});
          addToast("info", "Snapshot Saved", `Saved ${displayFileName}.`);
        }
      } catch (err: unknown) {
        addToast("error", "Snapshot Failed", String(err));
      }
    },
    [filePath, fileName, outputDestination, customOutputDirectory, completionAction, addToast]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "S" || e.key === "s")) {
        if (filePath) {
          e.preventDefault();
          const curTime = previewRef.current?.getCurrentTime() ?? 0;
          handleSnapshot(curTime);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filePath, handleSnapshot]);

  const redoTrim = useCallback(() => {
    const target = redoStackRef.current.pop();
    if (!target) return;
    pushUndoSnapshot({ start: startValRef.current, end: endValRef.current });
    startValRef.current = target.start;
    endValRef.current = target.end;
    pendingTrimStateRef.current = null;
    if (trimStateRafRef.current !== null) {
      window.cancelAnimationFrame(trimStateRafRef.current);
      trimStateRafRef.current = null;
    }
    setStartVal(target.start);
    setEndVal(target.end);
    syncTrimHistorySize();
    setPreviewFocusNow(sliderValueToTime(target.start), false);
  }, [pushUndoSnapshot, setPreviewFocusNow, sliderValueToTime, syncTrimHistorySize]);

  const setInPoint = useCallback(() => {
    const pt = playheadTimeRef.current;
    if (pt === null || duration <= 0) return;
    const val = Math.round((pt / duration) * SLIDER_MAX);
    const next = applyTrim(val, endValRef.current, { anchor: "start" });
    setPreviewFocusNow(sliderValueToTime(next?.start ?? startValRef.current), false);
  }, [duration, applyTrim, setPreviewFocusNow, sliderValueToTime]);

  const setOutPoint = useCallback(() => {
    const pt = playheadTimeRef.current;
    if (pt === null || duration <= 0) return;
    const val = Math.round((pt / duration) * SLIDER_MAX);
    const next = applyTrim(startValRef.current, val, { anchor: "end" });
    setPreviewFocusNow(sliderValueToTime(next?.end ?? endValRef.current), false);
  }, [duration, applyTrim, setPreviewFocusNow, sliderValueToTime]);

  useEffect(() => {
    const requestId = losslessInfoRequestRef.current + 1;
    losslessInfoRequestRef.current = requestId;

    if (!losslessTrim || !filePath || !probeData || duration <= 0) {
      losslessInfoRef.current = null;
      setLosslessInfo(null);
      setLosslessInfoLoading(false);
      setLosslessInfoError(null);
      return;
    }

    setLosslessInfoLoading(true);
    setLosslessInfoError(null);
    getLosslessTrimInfo(filePath)
      .then((info) => {
        if (
          losslessInfoRequestRef.current !== requestId ||
          selectedFilePathRef.current !== filePath
        ) {
          return;
        }
        const keyframeTimes = normalizeLosslessKeyframes(info.keyframe_times, duration);
        if (keyframeTimes.length === 0) throw new Error("No usable keyframes were found.");
        const nextInfo = { ...info, keyframe_times: keyframeTimes };
        losslessInfoRef.current = nextInfo;
        setLosslessInfo(nextInfo);
        setLosslessInfoLoading(false);

        const snapped = snapLosslessTrimRange(
          sliderValueToTime(startValRef.current),
          sliderValueToTime(endValRef.current),
          duration,
          keyframeTimes
        );
        if (snapped) {
          const next = applyTrim(
            timeToTimelineValue(snapped.start, duration, SLIDER_MAX),
            timeToTimelineValue(snapped.end, duration, SLIDER_MAX),
            { anchor: "end" }
          );
          if (next) setPreviewFocusNow(sliderValueToTime(next.start), false);
        }
      })
      .catch((error: unknown) => {
        if (
          losslessInfoRequestRef.current !== requestId ||
          selectedFilePathRef.current !== filePath
        ) {
          return;
        }
        if (isFfmpegMissingError(error)) markFfmpegMissing();
        losslessInfoRef.current = null;
        setLosslessInfo(null);
        setLosslessInfoLoading(false);
        setLosslessInfoError(String(error));
      });

    return () => {
      if (losslessInfoRequestRef.current === requestId) {
        losslessInfoRequestRef.current += 1;
      }
    };
  }, [
    applyTrim,
    duration,
    filePath,
    losslessTrim,
    markFfmpegMissing,
    probeData,
    setPreviewFocusNow,
    sliderValueToTime,
  ]);

  // --- File loading ---
  const loadVideo = useCallback(
    async (path: string) => {
      if (!SUPPORTED_VIDEO_EXTENSION.test(path)) {
        addToast(
          "warning",
          "Unsupported Video",
          "Choose an MP4, AVI, MOV, MKV, FLV, WMV, or WebM file."
        );
        return;
      }
      const loadGeneration = loadGenerationRef.current + 1;
      loadGenerationRef.current = loadGeneration;
      selectedFilePathRef.current = path;
      setFileLoadGeneration(loadGeneration);
      setFilePath(path);
      setFileName(path.split(/[\\/]/).pop() ?? path);
      probeDataRef.current = null;
      setProbeData(null);
      losslessInfoRef.current = null;
      setLosslessInfo(null);
      setLosslessInfoLoading(false);
      setLosslessInfoError(null);
      setLosslessOfferMode(false);
      setLosslessOfferTargetSize(null);
      setLoadingVideo(true);
      pointerGestureCleanupRef.current?.();
      pointerGestureCleanupRef.current = null;
      pointerHistoryStartRef.current = null;
      pendingTrimStateRef.current = null;
      if (trimStateRafRef.current !== null) {
        window.cancelAnimationFrame(trimStateRafRef.current);
        trimStateRafRef.current = null;
      }
      if (scrubPreviewRafRef.current !== null) {
        window.cancelAnimationFrame(scrubPreviewRafRef.current);
        scrubPreviewRafRef.current = null;
      }
      pendingScrubPreviewRef.current = null;
      previewFocusTimeRef.current = null;
      startValRef.current = 0;
      endValRef.current = SLIDER_MAX;
      playheadTimeRef.current = null;
      if (trimPlayheadElementRef.current) {
        trimPlayheadElementRef.current.hidden = true;
      }
      setCanSetInPoint(false);
      setCanSetOutPoint(false);
      setStartVal(0);
      setEndVal(SLIDER_MAX);
      setPreviewFocusTime(null);
      setPreviewScrubbing(false);
      setTimelineCenterVal(SLIDER_MAX / 2);
      setTimelineZoom(1);
      undoStackRef.current = [];
      redoStackRef.current = [];
      syncTrimHistorySize();
      resetProgress();
      try {
        const data = await probeVideo(path);
        if (loadGenerationRef.current !== loadGeneration) return;
        probeDataRef.current = data;
        setProbeData(data);
      } catch (e) {
        if (loadGenerationRef.current !== loadGeneration) return;
        if (isFfmpegMissingError(e)) {
          markFfmpegMissing();
          setFileName(FFMPEG_MISSING_LOAD_MESSAGE);
        } else {
          // The path is retained separately for diagnostics, but the preview
          // must not enter its selected-media state when probing failed.
          setFilePath(null);
          setFileName(`Error loading video: ${e}`);
        }
        probeDataRef.current = null;
        setProbeData(null);
      } finally {
        if (loadGenerationRef.current === loadGeneration) {
          setLoadingVideo(false);
        }
      }
    },
    [addToast, markFfmpegMissing, resetProgress, syncTrimHistorySize]
  );

  useEffect(() => {
    if (pendingTrimStateRef.current) return;
    startValRef.current = startVal;
    endValRef.current = endVal;
  }, [startVal, endVal]);

  useEffect(
    () => () => {
      if (trimStateRafRef.current !== null) {
        window.cancelAnimationFrame(trimStateRafRef.current);
      }
      if (scrubPreviewRafRef.current !== null) {
        window.cancelAnimationFrame(scrubPreviewRafRef.current);
      }
      if (playheadSeekRafRef.current !== null) {
        window.cancelAnimationFrame(playheadSeekRafRef.current);
      }
      pointerGestureCleanupRef.current?.();
      pointerGestureCleanupRef.current = null;
    },
    []
  );

  const browseFile = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [
          { name: "Video", extensions: ["mp4", "avi", "mov", "mkv", "flv", "wmv", "webm"] },
        ],
      });
      if (selected && typeof selected === "string") await loadVideo(selected);
    } catch (error) {
      addToast("error", "Could Not Open File Picker", String(error));
    }
  }, [addToast, loadVideo]);

  const chooseCustomOutputDirectory = useCallback(async (): Promise<string | null> => {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        setCustomOutputDirectory(selected);
        saveSettings({ custom_output_directory: selected });
        return selected;
      }
    } catch (error) {
      addToast("error", "Could Not Choose Folder", String(error));
    }
    return null;
  }, [addToast, saveSettings, setCustomOutputDirectory]);

  const changeOutputDestination = useCallback(
    async (destination: OutputDestination) => {
      if (destination === "custom" && !customOutputDirectory) {
        const selected = await chooseCustomOutputDirectory();
        if (!selected) return;
      }
      setOutputDestination(destination);
      saveSettings({ output_destination: destination });
    },
    [chooseCustomOutputDirectory, customOutputDirectory, saveSettings, setOutputDestination]
  );

  const restoreSettingsPreset = useCallback(
    (preset: SettingsPreset) => {
      clearLosslessOfferMode();
      const restored = restoreSettings(preset.settings);
      const matchingEncoderIndex = restored.encoder_label
        ? encoders.findIndex((encoder) => encoder.label === restored.encoder_label)
        : -1;
      const nextEncoderIndex =
        matchingEncoderIndex >= 0
          ? matchingEncoderIndex
          : Math.max(0, Math.min(restored.encoder_index, Math.max(encoders.length - 1, 0)));
      setEncoderIdx(nextEncoderIndex);
      saveSettings(restored);
      addToast("success", "Preset Restored", `Loaded “${preset.name}”.`);
    },
    [addToast, clearLosslessOfferMode, encoders, restoreSettings, saveSettings, setEncoderIdx]
  );

  const saveSettingsPreset = useCallback(
    (name: string) => {
      const currentEncoderLabel =
        encoders[encoderIdx]?.label ??
        (settingsRef.current.encoder_label as string | undefined) ??
        "";
      const preset = savePreset(name, getSettingsSnapshot(encoderIdx, currentEncoderLabel));
      if (preset) {
        addToast("success", "Preset Saved", `Saved “${preset.name}”.`);
      } else {
        addToast(
          "error",
          "Could Not Save Preset",
          `You can save up to ${MAX_SETTINGS_PRESETS} presets.`
        );
      }
      return preset;
    },
    [addToast, encoders, encoderIdx, getSettingsSnapshot, savePreset, settingsRef]
  );

  const deleteSettingsPreset = useCallback(
    (preset: SettingsPreset) => {
      const deleted = deletePreset(preset.id);
      if (deleted) {
        addToast("success", "Preset Deleted", `Removed “${deleted.name}”.`);
      }
    },
    [addToast, deletePreset]
  );

  const completeOutput = useCallback(
    async (outputPath: string) => {
      if (completionAction === "copy") {
        try {
          await copyFileToClipboard(outputPath);
          addToast(
            "success",
            "Compression Complete",
            "The output file was copied to the clipboard."
          );
          return;
        } catch (clipboardError) {
          try {
            await showInFileExplorer(outputPath);
            addToast(
              "warning",
              "Clipboard Unavailable",
              "The output file was saved and revealed instead."
            );
            return;
          } catch (revealError) {
            addToast("success", "Compression Complete", "The output file was saved.");
            addToast(
              "error",
              "Complete Action Failed",
              `${String(clipboardError)} Reveal also failed: ${String(revealError)}`
            );
            return;
          }
        }
      }

      try {
        await showInFileExplorer(outputPath);
        addToast("success", "Compression Complete", "The output file was revealed.");
      } catch (error) {
        addToast("success", "Compression Complete", "The output file was saved.");
        addToast("error", "Complete Action Failed", String(error));
      }
    },
    [addToast, completionAction]
  );

  // --- OS file-open integrations ---
  // Route listener callbacks through a ref so we subscribe exactly once per
  // mount while always invoking the latest loadVideo. Previously the empty
  // dep array + eslint-disable meant a stale loadVideo closure would be
  // retained if its identity ever changed.
  const loadVideoRef = useRef(loadVideo);
  useEffect(() => {
    loadVideoRef.current = loadVideo;
  }, [loadVideo]);

  useEffect(() => {
    let disposed = false;
    const unsub = listen<string>("open-file", (e) => loadVideoRef.current(e.payload));
    unsub
      .then(() => {
        if (!disposed) frontendReady().catch(() => {});
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsub.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
      if (e.payload.paths.length > 0) loadVideoRef.current(e.payload.paths[0]);
    });
    return () => {
      unlisten.then((fn: () => void) => fn());
    };
  }, []);

  useEffect(() => {
    const suppressContextMenu = (event: MouseEvent) => {
      if (preservesNativeContextMenu(event.target)) return;
      event.preventDefault();
    };
    window.addEventListener("contextmenu", suppressContextMenu);
    return () => {
      window.removeEventListener("contextmenu", suppressContextMenu);
    };
  }, []);

  // Keyboard shortcuts (only when a file is loaded and focus is outside native controls)
  useEffect(() => {
    if (!filePath || modalOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const undoShortcut = (e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z");
      const trimRangeFocused = targetMatches(e.target, "input[type='range']");
      if (undoShortcut && (!isEditableTarget(e.target) || trimRangeFocused)) {
        e.preventDefault();
        if (e.shiftKey) {
          redoTrim();
        } else {
          undoTrim();
        }
        return;
      }

      if (isEditableTarget(e.target)) return;

      if (e.key === " ") {
        if (isInteractiveTarget(e.target)) return;
        e.preventDefault();
        if (previewRef.current?.isPlaying()) {
          previewRef.current.stopPlayback();
        } else {
          previewRef.current?.startPlayback();
        }
        return;
      }

      const dur = probeData?.duration ?? 0;
      if (!dur) return;
      const coarseStep = Math.max(1, Math.round((SLIDER_MAX * 0.1) / dur));
      const fineStep = Math.max(1, Math.round((SLIDER_MAX * 0.02) / dur));

      if (e.key === ",") {
        e.preventDefault();
        const nextTime = Math.max(
          0,
          (previewRef.current?.getCurrentTime() ?? playheadTimeRef.current ?? 0) -
            FRAME_STEP_SECONDS
        );
        previewRef.current?.stepBy(-FRAME_STEP_SECONDS);
        setPreviewFocusNow(nextTime, false);
      } else if (e.key === ".") {
        e.preventDefault();
        const nextTime = Math.min(
          duration,
          (previewRef.current?.getCurrentTime() ?? playheadTimeRef.current ?? 0) +
            FRAME_STEP_SECONDS
        );
        previewRef.current?.stepBy(FRAME_STEP_SECONDS);
        setPreviewFocusNow(nextTime, false);
      } else if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        const nextTime = (startValRef.current / SLIDER_MAX) * duration;
        previewRef.current?.seekTo(nextTime);
        setPreviewFocusNow(nextTime, false);
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        const nextTime = (endValRef.current / SLIDER_MAX) * duration;
        previewRef.current?.seekTo(nextTime);
        setPreviewFocusNow(nextTime, false);
      } else if (e.key === "[") {
        e.preventDefault();
        const next = applyTrim(startValRef.current - coarseStep, endValRef.current, {
          anchor: "start",
        });
        setPreviewFocusNow(sliderValueToTime(next?.start ?? startValRef.current), false);
      } else if (e.key === "]") {
        e.preventDefault();
        const next = applyTrim(startValRef.current, endValRef.current + coarseStep, {
          anchor: "end",
        });
        setPreviewFocusNow(sliderValueToTime(next?.end ?? endValRef.current), false);
      } else if (e.key === "r" || e.key === "R" || e.key === "u" || e.key === "U") {
        e.preventDefault();
        const next = applyTrim(0, SLIDER_MAX, { anchor: "end" });
        setPreviewFocusNow(sliderValueToTime(next?.start ?? startValRef.current), false);
      } else if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        const pt = playheadTimeRef.current;
        if (pt === null) return;
        const currentVal = Math.max(0, Math.min(SLIDER_MAX, Math.round((pt / dur) * SLIDER_MAX)));
        const next = applyTrim(currentVal, endValRef.current, { anchor: "start" });
        setPreviewFocusNow(sliderValueToTime(next?.start ?? startValRef.current), false);
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        const pt = playheadTimeRef.current;
        if (pt === null) return;
        const currentVal = Math.max(0, Math.min(SLIDER_MAX, Math.round((pt / dur) * SLIDER_MAX)));
        const next = applyTrim(startValRef.current, currentVal, { anchor: "end" });
        setPreviewFocusNow(sliderValueToTime(next?.end ?? endValRef.current), false);
      } else if (e.shiftKey && e.key === "ArrowLeft") {
        e.preventDefault();
        if (activeHandleRef.current === "start") {
          const next = applyTrim(startValRef.current - fineStep, endValRef.current, {
            anchor: "start",
          });
          setPreviewFocusNow(sliderValueToTime(next?.start ?? startValRef.current), false);
        } else {
          const next = applyTrim(startValRef.current, endValRef.current - fineStep, {
            anchor: "end",
          });
          setPreviewFocusNow(sliderValueToTime(next?.end ?? endValRef.current), false);
        }
      } else if (e.shiftKey && e.key === "ArrowRight") {
        e.preventDefault();
        if (activeHandleRef.current === "start") {
          const next = applyTrim(startValRef.current + fineStep, endValRef.current, {
            anchor: "start",
          });
          setPreviewFocusNow(sliderValueToTime(next?.start ?? startValRef.current), false);
        } else {
          const next = applyTrim(startValRef.current, endValRef.current + fineStep, {
            anchor: "end",
          });
          setPreviewFocusNow(sliderValueToTime(next?.end ?? endValRef.current), false);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    filePath,
    probeData,
    redoTrim,
    undoTrim,
    duration,
    applyTrim,
    setPreviewFocusNow,
    sliderValueToTime,
    modalOpen,
  ]);

  // --- Update check ---
  useEffect(() => {
    if (!settingsLoaded) return;
    const lastCheck = (settingsRef.current.update_last_check as number) ?? 0;
    if (Date.now() / 1000 - lastCheck < 6 * 3600) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      checkForUpdates(CURRENT_VERSION)
        .then((r) => {
          if (cancelled) return;
          if (r.update_available && r.latest_version && r.release_url) {
            const dismissed = settingsRef.current.update_dismissed_version as string | undefined;
            if (dismissed !== r.latest_version) {
              setUpdateInfo({
                version: r.latest_version,
                url: r.release_url,
                installerAvailable: r.installer_available === true,
                installerName: r.installer_name,
              });
            }
          }
        })
        .catch(() => {})
        // Advance the throttle timestamp on both success and failure so a
        // transient network error doesn't cause every subsequent app launch to
        // re-fire the request immediately.
        .finally(() => {
          if (!cancelled) saveSettings({ update_last_check: Date.now() / 1000 });
        });
    }, UPDATE_CHECK_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [saveSettings, settingsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Compression ---
  const startCompress = useCallback(async () => {
    if (ffmpegMissing) {
      addToast("warning", "FFmpeg Not Found", FFMPEG_MISSING_TOAST_MESSAGE);
      setCompressing(false);
      return;
    }

    if (!filePath || !probeData) {
      addToast("warning", "Warning", "No file selected!");
      setCompressing(false);
      return;
    }
    const duration = probeData.duration;
    if (losslessTrim) {
      if (losslessInfoLoading) {
        addToast("info", "Preparing Lossless Trim", "Finding keyframes for this video.");
        setCompressing(false);
        return;
      }
      if (!losslessInfo) {
        addToast(
          "error",
          "Lossless Trim Unavailable",
          losslessInfoError ?? "Keyframe discovery failed. Choose another quality option."
        );
        setCompressing(false);
        return;
      }
    }
    let startTime = (startValRef.current / SLIDER_MAX) * duration;
    let endTime = (endValRef.current / SLIDER_MAX) * duration;
    let clipDuration = endTime - startTime;
    if (clipDuration <= 0) {
      addToast("warning", "Warning", "Invalid trim range.");
      setCompressing(false);
      return;
    }

    let targetSize: number | null;
    let targetH: number | null = null;
    let targetShort: number | null = null;
    let encoderName: string;
    let outputFps: number | null = null;

    if (gifMode) {
      const preset = GIF_PRESETS[gifQualityIdx] ?? GIF_PRESETS[0];
      targetSize = preset.size_mb;
      targetH = preset.target_h;
      encoderName = "gif";
      outputFps = gifFps;
    } else if (losslessTrim) {
      targetSize = null;
      encoderName = encoders[encoderIdx]?.name ?? "libx264";
    } else if (advancedMode) {
      const sizeText = advSize.trim();
      const sz = Number(sizeText);
      if (sizeText && (!Number.isFinite(sz) || sz <= 0)) {
        addToast("warning", "Warning", "Enter a valid target size in MB.");
        setCompressing(false);
        return;
      }
      targetSize = sizeText ? sz : null;
      targetShort = resolutionToShortSide(advResolution);
      const fpsText = advFps.trim();
      if (fpsText) {
        const fps = Number(fpsText);
        if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) {
          addToast("warning", "Warning", "Enter a valid FPS value.");
          setCompressing(false);
          return;
        }
        outputFps = fps;
      }
      const customEnc = advEncoder.trim();
      if (customEnc) {
        const mapped = encoders.find((e) => e.label === customEnc || e.name === customEnc);
        encoderName = mapped?.name ?? customEnc;
      } else {
        encoderName = encoders[encoderIdx]?.name ?? "libx264";
      }
    } else {
      const preset = QUALITY_PRESETS[qualityIdx] ?? QUALITY_PRESETS[0];
      targetSize = preset.size_mb;
      targetH = preset.target_h;
      encoderName = encoders[encoderIdx]?.name ?? "libx264";
      const selectedFps = FPS_OPTIONS.find((option) => option.value === fpsOption)?.fps ?? null;
      if (selectedFps !== null && (sourceFrameRate === null || selectedFps <= sourceFrameRate)) {
        outputFps = selectedFps;
      }
    }

    const offerTargetSize = targetSize;
    const skipLosslessOffer = skipLosslessOfferRef.current;
    skipLosslessOfferRef.current = false;
    if (
      !losslessTrim &&
      !gifMode &&
      !skipLosslessOffer &&
      offerTargetSize !== null &&
      losslessTrimFitsTarget(offerTargetSize, clipDuration, probeData.bitrate)
    ) {
      setCompressing(false);
      addToast(
        "info",
        "This clip may not need compression",
        `It should already fit under ${offerTargetSize} MB. You can keep the original picture and sound quality, but the cut points may move slightly.`,
        {
          durationMs: null,
          notifySystem: false,
          actions: [
            {
              label: "Keep original quality",
              onClick: () => {
                setLosslessOfferMode(true);
                setLosslessOfferTargetSize(offerTargetSize);
                setAdvancedMode(false);
                saveSettings({ advanced_mode: false });
                addToast(
                  "info",
                  "Original quality mode is on",
                  "Choose your start and end points again. The saved clip may start or end a little earlier than selected."
                );
              },
            },
            {
              label: "Compress anyway",
              onClick: () => {
                skipLosslessOfferRef.current = true;
                setCompressing(true);
                void startCompressRef.current();
              },
            },
          ],
        }
      );
      return;
    }

    const effectiveRemoveAudio = gifMode || removeAudio;
    const videoBitrate = resolveVideoBitrate(
      targetSize,
      clipDuration,
      effectiveRemoveAudio,
      gifMode ? 0 : probeData.bitrate
    );
    if (videoBitrate === null) {
      if (!losslessTrim) {
        addToast(
          "warning",
          "Source Bitrate Unavailable",
          "Enter a target size in MB because the source bitrate could not be determined."
        );
        setCompressing(false);
        return;
      }
    }
    const requestedVideoBitrate = videoBitrate ?? 100;

    // Output-path resolution and VAAPI discovery are independent, so keep
    // their IPC work parallel. Ask mode stages privately until encoding ends.
    const outputExtension: OutputExtension = gifMode ? "gif" : "mp4";
    const fallbackExtension = losslessTrim ? losslessInfo?.source_container_extension : null;
    const isVaapi = !gifMode && !losslessTrim && encoderName.endsWith("_vaapi");
    const outputPromise =
      outputDestination === "ask"
        ? resolveStagingOutputPath(filePath, outputExtension)
        : resolveOutputPath(
            filePath,
            outputDestination === "custom" ? customOutputDirectory : undefined,
            outputDestination === "source",
            outputExtension
          );
    const fallbackOutputPromise =
      losslessTrim && fallbackExtension && fallbackExtension !== outputExtension
        ? (outputDestination === "ask"
            ? resolveStagingOutputPath(filePath, fallbackExtension)
            : resolveOutputPath(
                filePath,
                outputDestination === "custom" ? customOutputDirectory : undefined,
                outputDestination === "source",
                fallbackExtension
              )
          ).then(
            (path) => path,
            () => null
          )
        : Promise.resolve<string | null>(null);
    const [outputResult, fallbackOutput, vaapiDevice] = await Promise.all([
      outputPromise.then(
        (path) => ({ path, error: null }),
        (error: unknown) => ({ path: null, error: String(error) })
      ),
      fallbackOutputPromise,
      isVaapi ? getVaapiDevice().catch(() => null) : Promise.resolve(null),
    ]);
    if (!outputResult.path) {
      addToast("error", "Could Not Choose Output", outputResult.error ?? "Unknown error");
      setCompressing(false);
      return;
    }
    const resolvedOutput = outputResult.path;
    const [cw, ch] = getCroppedDimensions(probeData.width, probeData.height, cropAspectRatio);

    const outputPath = await compressVideo({
      input_path: filePath,
      output_path: resolvedOutput,
      encoder: encoderName,
      video_bitrate_k: requestedVideoBitrate,
      target_size_mb: losslessTrim ? null : targetSize,
      start_time: startTime,
      end_time: endTime,
      remove_audio: effectiveRemoveAudio,
      audio_normalize: losslessTrim ? false : audioNormalize,
      crop_aspect_ratio: losslessTrim ? "off" : cropAspectRatio,
      output_fps: losslessTrim ? null : outputFps,
      scale_filter: losslessTrim
        ? null
        : buildScaleFilter(cw, ch, targetH, targetShort, encoderName),
      vaapi_device: vaapiDevice,
      gif_mode: gifMode,
      lossless_trim: losslessTrim,
      fallback_output_path: fallbackOutput,
      fallback_target_size_mb: losslessOfferMode ? losslessOfferTargetSize : null,
    }).catch((e) => {
      if (String(e).includes("Cancelled")) {
        return null;
      } else if (isFfmpegMissingError(e)) {
        markFfmpegMissing();
        addToast("error", "FFmpeg Not Found", FFMPEG_MISSING_TOAST_MESSAGE);
      } else {
        addToast("error", "Error", String(e));
      }
      setCompressing(false);
      return null;
    });

    if (outputPath && outputDestination === "ask") {
      setFinalizingOutput(true);
      try {
        const stem = fileName.replace(/\.[^.]+$/, "") || "video";
        const actualOutputExtension = outputExtensionForPath(outputPath, outputExtension);
        const isGifOutput = actualOutputExtension === "gif";
        let savedOutput: string | null = null;
        while (!savedOutput) {
          const selected = await saveDialog({
            title: isGifOutput ? "Save GIF" : "Save trimmed video",
            defaultPath: `${stem}-vidcord.${actualOutputExtension}`,
            filters: [
              isGifOutput
                ? { name: "GIF Image", extensions: ["gif"] }
                : {
                    name: "Video",
                    extensions: ["mp4", "mov", "mkv", "webm", "avi", "flv", "wmv"],
                  },
            ],
          });
          if (!selected) {
            await discardStagedOutput(outputPath).catch(() => {});
            addToast("warning", "Save Cancelled", "The compressed output was discarded.");
            return;
          }
          const hasExtension = new RegExp(`\\.(${actualOutputExtension})$`, "i").test(selected);
          const destination = hasExtension ? selected : `${selected}.${actualOutputExtension}`;
          savedOutput = await publishStagedOutput(outputPath, destination).catch((error) => {
            addToast("error", "Could Not Save Output", String(error));
            return null;
          });
        }
        await completeOutput(savedOutput);
      } catch (error) {
        await discardStagedOutput(outputPath).catch(() => {});
        addToast("error", "Could Not Save Output", String(error));
      } finally {
        setFinalizingOutput(false);
      }
    } else if (outputPath) {
      await completeOutput(outputPath);
    }
  }, [
    filePath,
    probeData,
    ffmpegMissing,
    gifMode,
    gifQualityIdx,
    gifFps,
    advancedMode,
    losslessTrim,
    losslessOfferMode,
    losslessOfferTargetSize,
    losslessInfo,
    losslessInfoLoading,
    losslessInfoError,
    advSize,
    advResolution,
    advFps,
    advEncoder,
    fpsOption,
    sourceFrameRate,
    qualityIdx,
    encoderIdx,
    encoders,
    removeAudio,
    audioNormalize,
    cropAspectRatio,
    outputDestination,
    customOutputDirectory,
    fileName,
    completeOutput,
    addToast,
    markFfmpegMissing,
    saveSettings,
    setAdvancedMode,
    setCompressing,
  ]);
  startCompressRef.current = startCompress;

  const loadListedEncoders = useCallback(async () => {
    let fallbackNames: string[] | null = null;
    const text = await listFfmpegVideoEncoders().catch((e) => {
      if (isFfmpegMissingError(e)) {
        markFfmpegMissing();
        fallbackNames = [];
        return FFMPEG_MISSING_TOAST_MESSAGE;
      }
      return `Error: ${e}`;
    });
    setListedEncoderNames(fallbackNames ?? parseListedEncoderNames(text));
    return text;
  }, [markFfmpegMissing]);

  const showEncoders = useCallback(async () => {
    const text = await loadListedEncoders();
    setEncodersDialogText(text);
  }, [loadListedEncoders]);

  const closeEncodersDialog = useCallback(() => {
    setEncodersDialogText(null);
  }, []);

  useEffect(() => {
    if (!settingsLoaded || !advancedMode || listedEncoderNames.length > 0) return;
    loadListedEncoders().catch(() => {});
  }, [advancedMode, listedEncoderNames.length, loadListedEncoders, settingsLoaded]);

  const installUpdate = useCallback(async () => {
    setInstallingUpdate(true);
    try {
      const result = await downloadAndOpenUpdateInstaller();
      addToast(
        "success",
        "Installer Opened",
        `${result.installer_name} was downloaded and opened.`
      );
      setUpdateInfo(null);
    } catch (e) {
      addToast("error", "Update Failed", String(e));
    } finally {
      setInstallingUpdate(false);
    }
  }, [addToast]);

  const dismissUpdate = useCallback(() => {
    if (!updateInfo || installingUpdate) return;
    saveSettings({ update_dismissed_version: updateInfo.version });
    setUpdateInfo(null);
  }, [installingUpdate, saveSettings, updateInfo]);

  useEffect(() => {
    installingUpdateRef.current = installingUpdate;
  }, [installingUpdate]);

  useEffect(() => {
    const appContent = appContentRef.current;
    if (!modalOpen || !appContent) return;

    appContent.inert = true;
    return () => {
      appContent.inert = false;
    };
  }, [modalOpen]);

  useEffect(() => {
    if (!showUpdateModal || !updateInfo) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    updatePreviousFocusRef.current = previouslyFocused;

    const focusFrame = window.requestAnimationFrame(() => {
      const primaryAction = updatePrimaryActionRef.current;
      if (primaryAction && !primaryAction.disabled) {
        primaryAction.focus();
        return;
      }
      updateModalRef.current
        ?.querySelector<HTMLElement>(
          "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"
        )
        ?.focus();
    });

    const handleModalKeyDown = (event: KeyboardEvent) => {
      const modal = updateModalRef.current;
      if (!modal) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!installingUpdateRef.current) {
          saveSettings({ update_dismissed_version: updateInfo.version });
          setUpdateInfo(null);
        }
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(
        modal.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), " +
            "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
        )
      ).filter((element) => element.getClientRects().length > 0);

      event.preventDefault();
      event.stopPropagation();
      if (focusable.length === 0) {
        modal.focus();
        return;
      }

      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? activeIndex <= 0
          ? focusable.length - 1
          : activeIndex - 1
        : activeIndex < 0 || activeIndex === focusable.length - 1
          ? 0
          : activeIndex + 1;
      focusable[nextIndex].focus();
    };

    document.addEventListener("keydown", handleModalKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleModalKeyDown, true);

      const focusTarget = updatePreviousFocusRef.current;
      updatePreviousFocusRef.current = null;
      if (focusTarget?.isConnected) {
        window.requestAnimationFrame(() => focusTarget.focus());
      }
    };
  }, [saveSettings, showUpdateModal, updateInfo]);

  const reprobeSelectedVideo = useCallback(async () => {
    const selectedPath = selectedFilePathRef.current;
    if (!selectedPath || probeDataRef.current) return;
    await loadVideoRef.current(selectedPath);
  }, []);

  const retryFfmpegDetection = useCallback(async () => {
    const available = await refreshEncoders().catch(() => false);
    if (available) {
      await reprobeSelectedVideo();
      addToast("success", "FFmpeg Ready", "FFmpeg is now available.");
    } else {
      addToast("warning", "Still Missing", "FFmpeg is still not detected on PATH.");
    }
  }, [addToast, refreshEncoders, reprobeSelectedVideo]);

  const installFfmpeg = useCallback(async () => {
    setInstallingFfmpeg(true);
    const os = await getOs().catch(() => "unknown");

    const showInstallResult = (result: FfmpegInstallResult) => {
      if (result.status === "installed" || result.status === "already_available") {
        addToast("success", "FFmpeg Setup", result.message);
      } else if (result.status === "needs_manual_download") {
        addToast("info", "Manual Download Needed", result.message);
      } else if (result.status === "requires_privileged") {
        addToast("info", "Admin Permission Needed", result.message);
      } else if (result.status === "unsupported") {
        addToast("info", "Manual Step Needed", result.message);
      } else {
        addToast("error", "Install Failed", result.message);
      }
      if (result.hint_command) {
        addToast("info", "Install Command", result.hint_command);
      }
      if (result.guide_url) {
        openExternalUrl(result.guide_url).catch(() => {});
      }
    };

    let result = await installFfmpegDependency(false).catch((e) => ({
      status: "failed" as const,
      message: String(e),
      hint_command: null,
      guide_url: null,
    }));

    if (result.status === "requires_privileged" && os === "linux") {
      const approved = window.confirm(
        "Installing FFmpeg on Linux needs elevated privileges. Run the installer command now?"
      );
      if (approved) {
        result = await installFfmpegDependency(true).catch((e) => ({
          status: "failed" as const,
          message: String(e),
          hint_command: null,
          guide_url: null,
        }));
      }
    }

    const available = await refreshEncoders().catch(() => false);
    if (available) {
      await reprobeSelectedVideo();
    }
    showInstallResult(result);

    setInstallingFfmpeg(false);
  }, [addToast, refreshEncoders, reprobeSelectedVideo]);

  // --- Derived values ---
  // Memoized because these drive the trim slider overlay and time labels
  // on every pointermove during scrub — recomputing on unrelated re-renders
  // wastes cycles.
  const startTime = useMemo(() => (startVal / SLIDER_MAX) * duration, [startVal, duration]);
  const endTime = useMemo(() => (endVal / SLIDER_MAX) * duration, [endVal, duration]);
  const selectedDuration = useMemo(() => Math.max(0, endTime - startTime), [startTime, endTime]);
  const selectedDurationPct = useMemo(() => {
    if (duration <= 0) return 0;
    return Math.max(0, Math.min(100, (selectedDuration / duration) * 100));
  }, [duration, selectedDuration]);

  const { start: viewStartVal, end: viewEndVal } = useMemo(
    () => getTimelineViewBounds(timelineCenterVal, timelineZoom, SLIDER_MAX, MIN_TRIM_GAP),
    [timelineCenterVal, timelineZoom]
  );

  const toViewPct = useCallback(
    (value: number) => {
      if (viewEndVal <= viewStartVal) return 0;
      return Math.max(
        0,
        Math.min(100, ((value - viewStartVal) / (viewEndVal - viewStartVal)) * 100)
      );
    },
    [viewStartVal, viewEndVal]
  );

  const startPct = useMemo(() => toViewPct(startVal), [startVal, toViewPct]);
  const endPct = useMemo(() => toViewPct(endVal), [endVal, toViewPct]);

  const trimReady = Boolean(filePath && probeData && duration > 0);

  // Single memo computes the predicted encoder name. The prior
  // implementation built a parallel array of { ...e, lowerName } on every
  // `encoders` change (new object identity per entry), which defeated
  // referential memoization for downstream consumers.
  const predictedEncoder = useMemo(() => {
    if (!advEncoder) return undefined;
    const lower = advEncoder.toLowerCase();
    for (const enc of encoders) {
      if (enc.name.toLowerCase().startsWith(lower)) return enc.name;
    }
    for (const name of listedEncoderNames) {
      if (name.toLowerCase().startsWith(lower)) return name;
    }
    return undefined;
  }, [advEncoder, encoders, listedEncoderNames]);

  const showPrediction = predictedEncoder !== undefined && predictedEncoder !== advEncoder;

  const encoderAutocompleteOptions = useMemo(
    () => Array.from(new Set([...encoders.map((enc) => enc.name), ...listedEncoderNames])),
    [encoders, listedEncoderNames]
  );

  const filteredEncoderOptions = useMemo(() => {
    const query = advEncoder.trim().toLowerCase();
    if (!query) return encoderAutocompleteOptions.slice(0, 10);
    const starts = encoderAutocompleteOptions.filter((option) =>
      option.toLowerCase().startsWith(query)
    );
    const contains = encoderAutocompleteOptions.filter((option) => {
      const lower = option.toLowerCase();
      return !lower.startsWith(query) && lower.includes(query);
    });
    return [...starts, ...contains].slice(0, 10);
  }, [advEncoder, encoderAutocompleteOptions]);

  useEffect(() => {
    setActiveEncoderOption(0);
  }, [advEncoder, filteredEncoderOptions.length]);

  const showEncoderOptions =
    !losslessTrim && encoderInputFocused && filteredEncoderOptions.length > 0;

  const acceptEncoderOption = useCallback(
    (option: string) => {
      setAdvEncoder(option);
      saveSettings({ advanced_encoder: option });
      setEncoderInputFocused(false);
    },
    [saveSettings, setAdvEncoder]
  );

  // Playback time is transient: update the compositor-owned playhead element
  // directly instead of re-rendering the entire App and trim subtree for every
  // native `timeupdate` event. Only the two derived button-enabled booleans
  // enter React state, and React bails out while they remain unchanged.
  const handlePreviewTimeUpdate = useCallback(
    (next: number | null) => {
      playheadTimeRef.current = next;
      const playhead = trimPlayheadElementRef.current;
      if (next === null || duration <= 0) {
        if (playhead) playhead.hidden = true;
        setCanSetInPoint(false);
        setCanSetOutPoint(false);
        return;
      }

      const value = (next / duration) * SLIDER_MAX;
      if (playhead) {
        const visible = value >= viewStartVal && value <= viewEndVal;
        playhead.hidden = !visible;
        if (visible) {
          playhead.style.transform = `translateX(${toViewPct(value)}%)`;
        }
      }

      if (!trimReady) {
        setCanSetInPoint(false);
        setCanSetOutPoint(false);
        return;
      }
      const normalizedValue = Math.round(value);
      const nextIn = normalizeTrim(normalizedValue, endValRef.current, "start");
      const nextOut = normalizeTrim(startValRef.current, normalizedValue, "end");
      const inEnabled = nextIn.start !== startValRef.current || nextIn.end !== endValRef.current;
      const outEnabled = nextOut.start !== startValRef.current || nextOut.end !== endValRef.current;
      setCanSetInPoint((current) => (current === inEnabled ? current : inEnabled));
      setCanSetOutPoint((current) => (current === outEnabled ? current : outEnabled));
    },
    [duration, normalizeTrim, toViewPct, trimReady, viewEndVal, viewStartVal]
  );

  useEffect(() => {
    handlePreviewTimeUpdate(playheadTimeRef.current);
  }, [handlePreviewTimeUpdate]);

  const commitPointerTrimChange = useCallback(() => {
    pointerGestureCleanupRef.current?.();
    pointerGestureCleanupRef.current = null;
    const started = pointerHistoryStartRef.current;
    pointerHistoryStartRef.current = null;
    const activeValue = activeHandleRef.current === "end" ? endValRef.current : startValRef.current;
    finishPreviewScrub(sliderValueToTime(activeValue));
    if (!started) return;
    const now = { start: startValRef.current, end: endValRef.current };
    if (started.start === now.start && started.end === now.end) return;
    flushPendingTrimStateNow();
    pushUndoSnapshot(started);
    redoStackRef.current = [];
    syncTrimHistorySize();
  }, [
    finishPreviewScrub,
    flushPendingTrimStateNow,
    pushUndoSnapshot,
    sliderValueToTime,
    syncTrimHistorySize,
  ]);

  const beginPointerTrimChange = useCallback(() => {
    if (pointerHistoryStartRef.current) {
      commitPointerTrimChange();
    }
    previewRef.current?.stopPlayback();
    const activeValue = activeHandleRef.current === "end" ? endValRef.current : startValRef.current;
    setPreviewFocusNow(sliderValueToTime(activeValue), true);
    pointerHistoryStartRef.current = {
      start: startValRef.current,
      end: endValRef.current,
    };

    const finishGesture = () => commitPointerTrimChange();
    window.addEventListener("pointerup", finishGesture, { once: true });
    window.addEventListener("pointercancel", finishGesture, { once: true });
    window.addEventListener("blur", finishGesture, { once: true });
    pointerGestureCleanupRef.current = () => {
      window.removeEventListener("pointerup", finishGesture);
      window.removeEventListener("pointercancel", finishGesture);
      window.removeEventListener("blur", finishGesture);
    };
  }, [commitPointerTrimChange, setPreviewFocusNow, sliderValueToTime]);

  const handleRangeDragStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const wrap = trimWrapRef.current;
      if (!wrap) return;
      e.preventDefault();

      const rect = wrap.getBoundingClientRect();
      if (rect.width <= 0) return;

      activeHandleRef.current = "start";
      const originX = e.clientX;
      const originStart = startValRef.current;
      const originEnd = endValRef.current;
      const span = originEnd - originStart;
      let dragging = false;

      const onMove = (moveEvent: MouseEvent) => {
        const deltaPx = moveEvent.clientX - originX;
        if (!dragging) {
          if (Math.abs(deltaPx) < 4) return;
          dragging = true;
          beginPointerTrimChange();
        }
        const deltaVal = (deltaPx / rect.width) * (viewEndVal - viewStartVal);
        let nextStart = originStart + deltaVal;
        nextStart = Math.max(0, Math.min(nextStart, SLIDER_MAX - span));
        const next = applyTrim(nextStart, nextStart + span, { record: false, anchor: "start" });
        schedulePreviewFocus(sliderValueToTime(next?.start ?? startValRef.current), true);
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (dragging) {
          suppressNextTimelineClickRef.current = true;
          commitPointerTrimChange();
        }
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [
      applyTrim,
      beginPointerTrimChange,
      commitPointerTrimChange,
      schedulePreviewFocus,
      sliderValueToTime,
      viewStartVal,
      viewEndVal,
    ]
  );

  const centerTimelineOnSelection = useCallback(() => {
    setTimelineCenterVal(getSelectionCenter(startValRef.current, endValRef.current, SLIDER_MAX));
  }, []);

  const handleTrimWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const zoomDelta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        centerTimelineOnSelection();
        setTimelineZoom((prev) => Math.max(1, Math.min(TIMELINE_ZOOM_MAX, prev * zoomDelta)));
        return;
      }

      const panStep = (viewEndVal - viewStartVal) * 0.08;
      setTimelineCenterVal((prev) => {
        const next = prev + (e.deltaY > 0 ? panStep : -panStep);
        return Math.max(0, Math.min(SLIDER_MAX, next));
      });
    },
    [centerTimelineOnSelection, viewStartVal, viewEndVal]
  );

  const seekToTimelinePosition = useCallback(
    (clientX: number, activePreview = false) => {
      const wrap = trimWrapRef.current;
      if (!wrap || !probeData || duration <= 0) return;
      const rect = wrap.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const viewVal = viewStartVal + fraction * (viewEndVal - viewStartVal);
      const time = Math.max(0, Math.min((viewVal / SLIDER_MAX) * duration, duration));
      previewRef.current?.seekTo(time);
      setPreviewFocusNow(time, activePreview);
    },
    [probeData, duration, setPreviewFocusNow, viewStartVal, viewEndVal]
  );

  const scheduleTimelineSeek = useCallback(
    (clientX: number) => {
      pendingPlayheadClientXRef.current = clientX;
      if (playheadSeekRafRef.current !== null) return;
      playheadSeekRafRef.current = window.requestAnimationFrame(() => {
        playheadSeekRafRef.current = null;
        const pending = pendingPlayheadClientXRef.current;
        pendingPlayheadClientXRef.current = null;
        if (pending !== null) {
          seekToTimelinePosition(pending, true);
        }
      });
    },
    [seekToTimelinePosition]
  );

  const flushPendingTimelineSeek = useCallback(
    (activePreview = false) => {
      if (playheadSeekRafRef.current !== null) {
        window.cancelAnimationFrame(playheadSeekRafRef.current);
        playheadSeekRafRef.current = null;
      }
      const pending = pendingPlayheadClientXRef.current;
      pendingPlayheadClientXRef.current = null;
      if (pending !== null) {
        seekToTimelinePosition(pending, activePreview);
      }
    },
    [seekToTimelinePosition]
  );

  const handleTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (suppressNextTimelineClickRef.current) {
        suppressNextTimelineClickRef.current = false;
        return;
      }
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      seekToTimelinePosition(e.clientX);
    },
    [seekToTimelinePosition]
  );

  const handlePlayheadDragStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (!probeData || duration <= 0) return;
      seekToTimelinePosition(e.clientX, true);
      const onMove = (mv: MouseEvent) => scheduleTimelineSeek(mv.clientX);
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        flushPendingTimelineSeek(true);
        finishPreviewScrub(playheadTimeRef.current);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [
      probeData,
      duration,
      finishPreviewScrub,
      flushPendingTimelineSeek,
      scheduleTimelineSeek,
      seekToTimelinePosition,
    ]
  );

  const setSnapModeFromTimeline = useCallback((mode: SnapMode) => {
    setSnapMode(mode);
  }, []);

  const zoomTimelineOut = useCallback(() => {
    centerTimelineOnSelection();
    setTimelineZoom((prev) => Math.max(1, prev / 1.25));
  }, [centerTimelineOnSelection]);

  const resetTimelineZoom = useCallback(() => {
    setTimelineZoom(1);
    centerTimelineOnSelection();
  }, [centerTimelineOnSelection]);

  const zoomTimelineIn = useCallback(() => {
    centerTimelineOnSelection();
    setTimelineZoom((prev) => Math.min(TIMELINE_ZOOM_MAX, prev * 1.25));
  }, [centerTimelineOnSelection]);

  const setLoopPlaybackFromTimeline = useCallback((enabled: boolean) => {
    setLoopPlayback(enabled);
  }, []);

  const handleStartHandlePointerDown = useCallback(() => {
    activeHandleRef.current = "start";
    beginPointerTrimChange();
  }, [beginPointerTrimChange]);

  const handleEndHandlePointerDown = useCallback(() => {
    activeHandleRef.current = "end";
    beginPointerTrimChange();
  }, [beginPointerTrimChange]);

  const handleStartHandleFocus = useCallback(() => {
    activeHandleRef.current = "start";
  }, []);

  const handleEndHandleFocus = useCallback(() => {
    activeHandleRef.current = "end";
  }, []);

  const handleStartChange = useCallback(
    (next: number) => {
      const pointerGestureActive = pointerHistoryStartRef.current !== null;
      const trim = applyTrim(next, endValRef.current, {
        record: !pointerGestureActive,
        anchor: "start",
      });
      const previewTime = sliderValueToTime(trim?.start ?? startValRef.current);
      if (pointerGestureActive) {
        schedulePreviewFocus(previewTime, true);
      } else {
        setPreviewFocusNow(previewTime, false);
      }
    },
    [applyTrim, schedulePreviewFocus, setPreviewFocusNow, sliderValueToTime]
  );

  const handleEndChange = useCallback(
    (next: number) => {
      const pointerGestureActive = pointerHistoryStartRef.current !== null;
      const trim = applyTrim(startValRef.current, next, {
        record: !pointerGestureActive,
        anchor: "end",
      });
      const previewTime = sliderValueToTime(trim?.end ?? endValRef.current);
      if (pointerGestureActive) {
        schedulePreviewFocus(previewTime, true);
      } else {
        setPreviewFocusNow(previewTime, false);
      }
    },
    [applyTrim, schedulePreviewFocus, setPreviewFocusNow, sliderValueToTime]
  );

  const handleStartTimeCommit = useCallback(
    (time: number) => {
      handleStartChange(timeToTimelineValue(time, duration, SLIDER_MAX));
    },
    [duration, handleStartChange]
  );

  const handleEndTimeCommit = useCallback(
    (time: number) => {
      handleEndChange(timeToTimelineValue(time, duration, SLIDER_MAX));
    },
    [duration, handleEndChange]
  );

  return (
    <div className="app">
      {showUpdateModal && updateInfo && (
        <div
          className="update-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              dismissUpdate();
            }
          }}
        >
          <div
            ref={updateModalRef}
            className="update-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-title"
            aria-describedby="update-description"
            tabIndex={-1}
          >
            <div className="update-modal-header">
              <div>
                <div className="update-modal-kicker">Update available</div>
                <h2 id="update-title">Version {updateInfo.version}</h2>
              </div>
              <button
                className="update-close-btn"
                type="button"
                aria-label="Dismiss update"
                onClick={dismissUpdate}
                disabled={installingUpdate}
              >
                ✕
              </button>
            </div>

            <p id="update-description" className="update-modal-copy">
              A newer vidcord release is available. Install will download the matching
              {updateInfo.installerName ? ` ${updateInfo.installerName}` : " installer"} for this
              computer and open it.
            </p>

            <div className="update-modal-actions">
              <button
                ref={updatePrimaryActionRef}
                className="update-primary-btn"
                type="button"
                onClick={installUpdate}
                disabled={installingUpdate || !updateInfo.installerAvailable}
              >
                {installingUpdate ? "Opening..." : "Install"}
              </button>
              <button
                className="update-secondary-btn"
                type="button"
                onClick={() => void openExternalUrl(updateInfo.url).catch(() => {})}
              >
                Release Page
              </button>
              <button
                className="update-secondary-btn"
                type="button"
                onClick={dismissUpdate}
                disabled={installingUpdate}
              >
                Later
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        ref={appContentRef}
        className={`app-content${ffmpegMissing ? " has-ffmpeg-banner" : ""}`}
        aria-hidden={modalOpen ? true : undefined}
      >
        {ffmpegMissing && (
          <div className="ffmpeg-banner">
            <span className="ffmpeg-banner-copy" role="status">
              FFmpeg required for compression.
            </span>
            <button
              className="ffmpeg-install-btn"
              type="button"
              onClick={installFfmpeg}
              disabled={installingFfmpeg}
            >
              {installingFfmpeg ? "Installing…" : "Install"}
            </button>
            <button className="ffmpeg-link-btn" type="button" onClick={retryFfmpegDetection}>
              Retry
            </button>
            <button
              className="ffmpeg-link-btn"
              type="button"
              onClick={() =>
                void openExternalUrl(
                  "https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md"
                ).catch(() => {})
              }
            >
              Guide
            </button>
          </div>
        )}

        <div className="scroll-area">
          <div className="workflow-card">
            <MemoizedSubtree
              dependencies={[
                filePath,
                fileName,
                importDetails,
                loadingVideo,
                browseFile,
                loadVideo,
                gifMode,
                losslessTrim,
                workflowMode,
                selectWorkflowMode,
                gifQualityIdx,
                setGifQualityIdx,
                gifFps,
                setGifFps,
                advancedMode,
                qualityIdx,
                setQualityIdx,
                standardFpsValue,
                setFpsOption,
                standardFpsOptions,
                encoders,
                encoderIdx,
                setEncoderIdx,
                removeAudio,
                setRemoveAudio,
                audioNormalize,
                setAudioNormalize,
                cropAspectRatio,
                setCropAspectRatio,
                cropOptions,
                advSize,
                setAdvSize,
                advResolution,
                setAdvResolution,
                advFps,
                setAdvFps,
                advEncoder,
                setAdvEncoder,
                showPrediction,
                predictedEncoder,
                showEncoderOptions,
                activeEncoderOption,
                setActiveEncoderOption,
                setEncoderInputFocused,
                listedEncoderNames,
                loadListedEncoders,
                filteredEncoderOptions,
                acceptEncoderOption,
                showEncoders,
                saveSettings,
                clearLosslessOfferMode,
              ]}
              render={() => (
                <>
                  {/* File import */}
                  <div className="file-section">
                    {filePath ? (
                      <button
                        type="button"
                        className="loaded-file-card"
                        onClick={browseFile}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          const file = event.dataTransfer.files[0];
                          if (file) loadVideo((file as File & { path?: string }).path ?? file.name);
                        }}
                        aria-label={`Change selected video, ${fileName}`}
                      >
                        <span className="loaded-file-icon">{VIDEO_FILE_ICON}</span>
                        <span className="loaded-file-copy">
                          <span className="loaded-file-name" title={fileName}>
                            {fileName}
                          </span>
                          <span className="loaded-file-details" aria-label={importDetails?.label}>
                            {importDetails?.text ??
                              (loadingVideo ? "Reading video…" : "Video details unavailable")}
                          </span>
                        </span>
                        <span className="change-file-label" aria-hidden="true">
                          Change…
                        </span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="drop-zone"
                        onClick={browseFile}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          const file = event.dataTransfer.files[0];
                          if (file) loadVideo((file as File & { path?: string }).path ?? file.name);
                        }}
                      >
                        <span className="drop-label">{fileName}</span>
                        <span className="browse-btn" aria-hidden="true">
                          Browse File
                        </span>
                      </button>
                    )}
                  </div>

                  <WorkflowModeSelector mode={workflowMode} onModeChange={selectWorkflowMode} />

                  {/* GIF settings */}
                  {gifMode && (
                    <div className="row settings-row gif-settings-row">
                      <label className="target-label">
                        Target size
                        <select
                          value={gifQualityIdx}
                          onChange={(event) => {
                            const next = Number(event.target.value);
                            setGifQualityIdx(next);
                            saveSettings({ gif_quality_index: next });
                          }}
                        >
                          {GIF_PRESETS.map((preset, index) => (
                            <option key={preset.size_mb} value={index}>
                              {preset.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="gif-fps-label">
                        FPS
                        <select
                          value={gifFps}
                          onChange={(event) => {
                            const next = Number(event.target.value);
                            if (next !== 15 && next !== 30 && next !== 50) return;
                            setGifFps(next);
                            saveSettings({ gif_fps: next });
                          }}
                        >
                          {GIF_FPS_OPTIONS.map((fps) => (
                            <option key={fps} value={fps}>
                              {fps}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}

                  {/* Basic settings */}
                  {!gifMode && !advancedMode && !losslessTrim && (
                    <div className="row settings-row">
                      <label className="target-label">
                        Discord target
                        <select
                          value={qualityIdx}
                          onChange={(e) => {
                            clearLosslessOfferMode();
                            setQualityIdx(+e.target.value);
                            saveSettings({ quality_index: +e.target.value });
                          }}
                        >
                          {QUALITY_PRESETS.map((p, i) => (
                            <option key={p.label} value={i}>
                              {p.label.replace(",", " ·")}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="fps-label">
                        FPS
                        <select
                          value={standardFpsValue}
                          onChange={(e) => {
                            setFpsOption(e.target.value);
                            saveSettings({ fps_option: e.target.value });
                          }}
                        >
                          {standardFpsOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="settings-field encoder-field">
                        <div className="encoder-heading">
                          <label htmlFor="encoder-select">Encoder</label>
                          {isH265Encoder(encoders[encoderIdx]?.name ?? "") && (
                            <span
                              className="encoder-warning"
                              tabIndex={0}
                              aria-label={H265_WARNING_MESSAGE}
                              aria-describedby="h265-warning-tooltip"
                            >
                              <span aria-hidden="true">!</span>
                              <span
                                id="h265-warning-tooltip"
                                className="encoder-warning-tooltip"
                                role="tooltip"
                              >
                                {H265_WARNING_MESSAGE}
                              </span>
                            </span>
                          )}
                        </div>
                        <div className="encoder-row">
                          <select
                            id="encoder-select"
                            value={encoderIdx}
                            onChange={(e) => {
                              setEncoderIdx(+e.target.value);
                              saveSettings({
                                encoder_index: +e.target.value,
                                encoder_label: encoders[+e.target.value]?.label,
                              });
                            }}
                          >
                            <optgroup label="H.264 — universally compatible">
                              {encoders.map(
                                (e, i) =>
                                  !isH265Encoder(e.name) && (
                                    <option key={e.name} value={i}>
                                      {e.label}
                                    </option>
                                  )
                              )}
                            </optgroup>
                            <optgroup label="H.265 — more efficient, may not play for all recipients">
                              {encoders.map(
                                (e, i) =>
                                  isH265Encoder(e.name) && (
                                    <option key={e.name} value={i}>
                                      {e.label}
                                    </option>
                                  )
                              )}
                            </optgroup>
                          </select>
                          <button
                            type="button"
                            className={`mute-btn${removeAudio ? " active" : ""}`}
                            title={removeAudio ? "Unmute audio" : "Mute audio"}
                            aria-label={removeAudio ? "Unmute audio" : "Mute audio"}
                            onClick={() => {
                              const next = !removeAudio;
                              setRemoveAudio(next);
                              saveSettings({ remove_audio: next });
                            }}
                          >
                            {removeAudio ? (
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <line x1="1" y1="1" x2="23" y2="23" />
                                <path d="M9 9L6 12H2v4h4l5 4v-5.58" />
                              </svg>
                            ) : (
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                              </svg>
                            )}
                          </button>
                          <button
                            type="button"
                            className={`norm-btn${audioNormalize && !removeAudio ? " active" : ""}`}
                            disabled={removeAudio}
                            title={
                              removeAudio
                                ? "Audio is muted"
                                : "EBU R128 audio loudness normalization"
                            }
                            aria-label="Normalize audio"
                            onClick={() => {
                              const next = !audioNormalize;
                              setAudioNormalize(next);
                              saveSettings({ audio_normalize: next });
                            }}
                          >
                            {audioNormalize && !removeAudio ? (
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <line x1="3" y1="6" x2="3" y2="18" />
                                <line x1="7.5" y1="3" x2="7.5" y2="21" />
                                <line x1="12" y1="2" x2="12" y2="22" />
                                <line x1="16.5" y1="3" x2="16.5" y2="21" />
                                <line x1="21" y1="6" x2="21" y2="18" />
                              </svg>
                            ) : (
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <line x1="4" y1="10" x2="4" y2="14" />
                                <line x1="9" y1="7" x2="9" y2="17" />
                                <line x1="14" y1="5" x2="14" y2="19" />
                                <line x1="19" y1="9" x2="19" y2="15" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Lossless settings */}
                  {losslessTrim && (
                    <div className="row settings-row lossless-settings-row">
                      <span className="lossless-settings-hint">No video re-encoding</span>
                      <button
                        type="button"
                        className={`mute-btn lossless-audio-toggle${removeAudio ? " active" : ""}`}
                        title={removeAudio ? "Keep audio tracks" : "Remove all audio tracks"}
                        aria-label={removeAudio ? "Keep audio tracks" : "Remove all audio tracks"}
                        aria-pressed={removeAudio}
                        onClick={() => {
                          const next = !removeAudio;
                          setRemoveAudio(next);
                          saveSettings({ remove_audio: next });
                        }}
                      >
                        {removeAudio ? (
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <line x1="1" y1="1" x2="23" y2="23" />
                            <path d="M9 9L6 12H2v4h4l5 4v-5.58" />
                          </svg>
                        ) : (
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          </svg>
                        )}
                        <span>{removeAudio ? "Audio removed" : "Keep audio"}</span>
                      </button>
                    </div>
                  )}

                  {/* Advanced settings */}
                  {!gifMode && advancedMode && !losslessTrim && (
                    <div className="row settings-row advanced">
                      <label>
                        Size (MB)
                        <input
                          type="number"
                          min="0.1"
                          step="0.1"
                          placeholder="Source"
                          title="Leave blank to use the source bitrate"
                          value={advSize}
                          onChange={(e) => {
                            clearLosslessOfferMode();
                            setAdvSize(e.target.value);
                            saveSettings({ advanced_target_size: e.target.value });
                          }}
                        />
                      </label>
                      <label>
                        Resolution
                        <select
                          value={advResolution}
                          onChange={(e) => {
                            setAdvResolution(e.target.value);
                            saveSettings({ advanced_resolution: e.target.value });
                          }}
                        >
                          {RESOLUTION_OPTIONS.map((r) => (
                            <option key={r}>{r}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Crop
                        <select
                          value={cropAspectRatio}
                          onChange={(e) => {
                            setCropAspectRatio(e.target.value);
                            saveSettings({ crop_aspect_ratio: e.target.value });
                          }}
                        >
                          {cropOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="fps-label">
                        FPS
                        <input
                          type="number"
                          min="0.1"
                          step="1"
                          placeholder="Off"
                          value={advFps}
                          onChange={(e) => {
                            setAdvFps(e.target.value);
                            saveSettings({ advanced_fps: e.target.value });
                          }}
                        />
                      </label>
                      <div className="settings-field encoder-label">
                        <span id="advanced-encoder-label">Encoder</span>
                        <div className="encoder-row">
                          <div className="encoder-autocomplete">
                            {showPrediction && (
                              <div className="encoder-ghost" aria-hidden="true">
                                {predictedEncoder}
                              </div>
                            )}
                            <input
                              id="advanced-encoder-input"
                              type="text"
                              role="combobox"
                              autoComplete="off"
                              placeholder="libx264"
                              value={advEncoder}
                              aria-labelledby="advanced-encoder-label"
                              aria-autocomplete="list"
                              aria-expanded={showEncoderOptions}
                              aria-controls={
                                showEncoderOptions ? "advanced-encoder-options" : undefined
                              }
                              aria-activedescendant={
                                showEncoderOptions
                                  ? `advanced-encoder-option-${activeEncoderOption}`
                                  : undefined
                              }
                              onFocus={() => {
                                setEncoderInputFocused(true);
                                if (listedEncoderNames.length === 0)
                                  loadListedEncoders().catch(() => {});
                              }}
                              onBlur={() => {
                                window.setTimeout(() => setEncoderInputFocused(false), 80);
                              }}
                              onChange={(e) => {
                                setAdvEncoder(e.target.value);
                                saveSettings({ advanced_encoder: e.target.value });
                                setEncoderInputFocused(true);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Tab" && showPrediction) {
                                  acceptEncoderOption(predictedEncoder!);
                                  return;
                                }
                                if (
                                  e.key === "ArrowRight" &&
                                  showPrediction &&
                                  e.currentTarget.selectionStart === advEncoder.length &&
                                  e.currentTarget.selectionEnd === advEncoder.length
                                ) {
                                  e.preventDefault();
                                  acceptEncoderOption(predictedEncoder!);
                                  return;
                                }
                                if (e.key === "ArrowDown" && showEncoderOptions) {
                                  e.preventDefault();
                                  setActiveEncoderOption((idx) =>
                                    Math.min(idx + 1, filteredEncoderOptions.length - 1)
                                  );
                                  return;
                                }
                                if (e.key === "ArrowUp" && showEncoderOptions) {
                                  e.preventDefault();
                                  setActiveEncoderOption((idx) => Math.max(idx - 1, 0));
                                  return;
                                }
                                if (e.key === "Enter" && showEncoderOptions) {
                                  e.preventDefault();
                                  acceptEncoderOption(filteredEncoderOptions[activeEncoderOption]);
                                  return;
                                }
                                if (e.key === "Escape") {
                                  setEncoderInputFocused(false);
                                }
                              }}
                            />
                            {showEncoderOptions && (
                              <div
                                id="advanced-encoder-options"
                                className="encoder-options"
                                role="listbox"
                                aria-label="Encoder suggestions"
                              >
                                {filteredEncoderOptions.map((option, index) => (
                                  <div
                                    id={`advanced-encoder-option-${index}`}
                                    role="option"
                                    aria-selected={index === activeEncoderOption}
                                    className={`encoder-option${
                                      index === activeEncoderOption ? " active" : ""
                                    }`}
                                    key={option}
                                    onMouseEnter={() => setActiveEncoderOption(index)}
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      acceptEncoderOption(option);
                                    }}
                                  >
                                    {option}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            className={`mute-btn${removeAudio ? " active" : ""}`}
                            title={removeAudio ? "Unmute audio" : "Mute audio"}
                            aria-label={removeAudio ? "Unmute audio" : "Mute audio"}
                            onClick={() => {
                              const next = !removeAudio;
                              setRemoveAudio(next);
                              saveSettings({ remove_audio: next });
                            }}
                          >
                            {removeAudio ? (
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <line x1="1" y1="1" x2="23" y2="23" />
                                <path d="M9 9L6 12H2v4h4l5 4v-5.58" />
                              </svg>
                            ) : (
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                              </svg>
                            )}
                          </button>
                          <button
                            type="button"
                            className={`norm-btn${audioNormalize && !removeAudio ? " active" : ""}`}
                            disabled={removeAudio}
                            title={
                              removeAudio
                                ? "Audio is muted"
                                : "EBU R128 audio loudness normalization"
                            }
                            aria-label="Normalize audio"
                            onClick={() => {
                              const next = !audioNormalize;
                              setAudioNormalize(next);
                              saveSettings({ audio_normalize: next });
                            }}
                          >
                            {audioNormalize && !removeAudio ? (
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <line x1="3" y1="6" x2="3" y2="18" />
                                <line x1="7.5" y1="3" x2="7.5" y2="21" />
                                <line x1="12" y1="2" x2="12" y2="22" />
                                <line x1="16.5" y1="3" x2="16.5" y2="21" />
                                <line x1="21" y1="6" x2="21" y2="18" />
                              </svg>
                            ) : (
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <line x1="4" y1="10" x2="4" y2="14" />
                                <line x1="9" y1="7" x2="9" y2="17" />
                                <line x1="14" y1="5" x2="14" y2="19" />
                                <line x1="19" y1="9" x2="19" y2="15" />
                              </svg>
                            )}
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            title="Show FFmpeg encoders"
                            aria-label="Show FFmpeg encoders"
                            onClick={showEncoders}
                          >
                            ℹ
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            />
          </div>

          {/* Preview and trim editor */}
          <PreviewPane
            ref={previewRef}
            filePath={filePath}
            sourceGeneration={fileLoadGeneration}
            loadingVideo={loadingVideo}
            startTime={startTime}
            endTime={endTime}
            previewTime={previewFocusTime}
            isScrubbing={previewScrubbing}
            loopPlayback={loopPlayback}
            probeData={probeData}
            removeAudio={gifMode || removeAudio}
            onTimeUpdate={handlePreviewTimeUpdate}
            onSnapshot={handleSnapshot}
          />

          <TrimTimeline
            selectedDuration={selectedDuration}
            selectedDurationPct={selectedDurationPct}
            editableTimes={!gifMode && (advancedMode || losslessTrim)}
            losslessTrim={losslessTrim}
            losslessInfoLoading={losslessInfoLoading}
            losslessInfoError={losslessInfoError}
            trimReady={trimReady}
            canSetInPoint={canSetInPoint}
            canSetOutPoint={canSetOutPoint}
            canUndoTrim={trimHistorySize.undo > 0}
            canRedoTrim={trimHistorySize.redo > 0}
            snapMode={snapMode}
            timelineZoom={timelineZoom}
            trimWrapRef={trimWrapRef}
            startTime={startTime}
            endTime={endTime}
            viewStartVal={viewStartVal}
            viewEndVal={viewEndVal}
            startVal={startVal}
            endVal={endVal}
            startPct={startPct}
            endPct={endPct}
            trimPlayheadRef={trimPlayheadElementRef}
            onSetInPoint={setInPoint}
            onSetOutPoint={setOutPoint}
            onSnapModeChange={setSnapModeFromTimeline}
            onZoomOut={zoomTimelineOut}
            onZoomReset={resetTimelineZoom}
            onZoomIn={zoomTimelineIn}
            onUndoTrim={undoTrim}
            onRedoTrim={redoTrim}
            loopPlayback={loopPlayback}
            onLoopPlaybackChange={setLoopPlaybackFromTimeline}
            onTrimWheel={handleTrimWheel}
            onTimelineClick={handleTimelineClick}
            onRangeDragStart={handleRangeDragStart}
            onPlayheadDragStart={handlePlayheadDragStart}
            onStartHandlePointerDown={handleStartHandlePointerDown}
            onEndHandlePointerDown={handleEndHandlePointerDown}
            onStartHandleFocus={handleStartHandleFocus}
            onEndHandleFocus={handleEndHandleFocus}
            onPointerUp={commitPointerTrimChange}
            onStartChange={handleStartChange}
            onEndChange={handleEndChange}
            onStartTimeCommit={handleStartTimeCommit}
            onEndTimeCommit={handleEndTimeCommit}
          />

          <div className="output-options" aria-label="Output options">
            <div className="output-option">
              <label htmlFor="output-destination-select">Save to</label>
              <div className="output-select-row">
                <select
                  id="output-destination-select"
                  value={outputDestination}
                  onChange={(event) =>
                    void changeOutputDestination(event.target.value as OutputDestination)
                  }
                >
                  <option value="downloads">Downloads</option>
                  <option value="source">Clip folder</option>
                  <option value="ask">Ask when done</option>
                  <option value="custom">Custom folder</option>
                </select>
                {outputDestination === "custom" && (
                  <button
                    type="button"
                    className="custom-folder-btn"
                    title={customOutputDirectory || "Choose a custom output folder"}
                    aria-label="Choose a custom output folder"
                    onClick={() => void chooseCustomOutputDirectory()}
                  >
                    {customOutputDirectory.split(/[\\/]/).filter(Boolean).pop() || "Choose"}
                  </button>
                )}
              </div>
            </div>

            <div className="output-option">
              <label htmlFor="completion-action-select">After export</label>
              <select
                id="completion-action-select"
                value={completionAction}
                onChange={(event) => {
                  const action = event.target.value as CompletionAction;
                  setCompletionAction(action);
                  saveSettings({ completion_action: action });
                }}
              >
                <option value="copy">Copy file</option>
                <option value="reveal">Show in folder</option>
              </select>
            </div>
          </div>

          {!showProgress && (
            <div className="export-summary" aria-label="Export summary">
              {exportSummary}
            </div>
          )}

          {/* Compress button */}
          <button
            className={`compress-btn${compressing ? " cancel" : ""}`}
            onClick={
              compressing
                ? cancelCompress
                : () => {
                    resetProgress();
                    setCompressing(true);
                    startCompress();
                  }
            }
            disabled={
              ffmpegMissing ||
              cancelling ||
              finalizingOutput ||
              (!compressing && losslessTrim && losslessInfoLoading) ||
              (!compressing && (!filePath || !probeData))
            }
          >
            {cancelling
              ? "Cancelling..."
              : finalizingOutput
                ? "Saving Output..."
                : compressing
                  ? "Cancel"
                  : readyActionLabel}
          </button>

          {/* Progress */}
          {showProgress && <ProgressSection progress={progress} eta={eta} />}

          {/* Footer */}
          <div className="footer">
            <div className="footer-meta">
              <span className="version">{DISPLAY_VERSION}</span>
              <a
                href="https://vidcord.app/"
                onClick={(e) => {
                  e.preventDefault();
                  void openExternalUrl("https://vidcord.app/").catch(() => {});
                }}
                className="gh-link"
                aria-label="Website"
                title="Website"
              >
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
                  <path
                    d="M1.75 8h12.5M8 1.5c1.7 1.74 2.55 3.9 2.55 6.5S9.7 12.76 8 14.5C6.3 12.76 5.45 10.6 5.45 8S6.3 3.24 8 1.5Z"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.4"
                  />
                </svg>
              </a>
              <a
                href="https://github.com/cyroz1/vidcord"
                onClick={(e) => {
                  e.preventDefault();
                  void openExternalUrl("https://github.com/cyroz1/vidcord").catch(() => {});
                }}
                className="gh-link"
                aria-label="GitHub"
                title="GitHub"
              >
                <svg
                  viewBox="0 0 16 16"
                  width="16"
                  height="16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
              </a>
            </div>
            <Suspense
              fallback={
                <span className="settings-presets" aria-hidden="true">
                  <span className="preset-select">Autosave</span>
                </span>
              }
            >
              <SettingsPresets
                presets={presets}
                onRestore={restoreSettingsPreset}
                onSave={saveSettingsPreset}
                onDelete={deleteSettingsPreset}
              />
            </Suspense>
          </div>
        </div>

        {/* Toasts */}
        <div className="toast-container">
          {toasts.map((t) => (
            <Toast key={t.id} {...t} onClose={removeToast} />
          ))}
        </div>
      </div>

      {/* Encoders dialog — lazy-loaded, only rendered after user opens it */}
      {encodersDialogText !== null && (
        <Suspense fallback={null}>
          <EncodersDialog text={encodersDialogText} onClose={closeEncodersDialog} />
        </Suspense>
      )}
    </div>
  );
}
