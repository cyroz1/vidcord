import { useEffect, useCallback, useState, useMemo, useRef, lazy, Suspense } from "react";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import Toast from "./components/Toast";
import ProgressSection from "./components/ProgressSection";
import PreviewPane, { type PreviewHandle } from "./components/PreviewPane";
import TrimTimeline, { type SnapMode } from "./components/TrimTimeline";
import { useToasts } from "./hooks/useToasts";
import { useSettings } from "./hooks/useSettings";
import { useEncoders } from "./hooks/useEncoders";
import {
  FFMPEG_MISSING_LOAD_MESSAGE,
  FFMPEG_MISSING_TOAST_MESSAGE,
  isFfmpegMissingError,
} from "./ffmpegErrors";
import {
  useCompression,
  calculateBitrate,
  resolutionToShortSide,
  computeTargetDimensions,
  type ProbeData,
} from "./hooks/useCompression";
import {
  checkFfmpegAvailable,
  checkForUpdates,
  compressVideo,
  downloadAndOpenUpdateInstaller,
  frontendReady,
  getOs,
  getVaapiDevice,
  installFfmpegDependency,
  listFfmpegVideoEncoders,
  probe as probeVideo,
  resolveOutputPath,
  showInFileExplorer,
  type FfmpegInstallResult,
} from "./ipc";
import { getSelectionCenter, getTimelineViewBounds } from "./timelineZoom";
import pkg from "../package.json";

// EncodersDialog is only shown after an explicit user click from Advanced
// Mode; lazy-loading it keeps the initial JS bundle smaller and is rendered
// under a <Suspense> boundary below.
const EncodersDialog = lazy(() => import("./components/EncodersDialog"));

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
const FPS_OPTIONS = [
  { label: "Off", value: "off", fps: null },
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
    fpsOption,
    setFpsOption,
    advFps,
    setAdvFps,
    advEncoder,
    setAdvEncoder,
    removeAudio,
    setRemoveAudio,
    saveSettings,
  } = useSettings();
  const { encoders, encoderIdx, setEncoderIdx, ffmpegMissing, refreshEncoders, markFfmpegMissing } =
    useEncoders({
      settingsLoaded,
      savedEncoderLabel: settingsRef.current.encoder_label as string | undefined,
      savedEncoderIndex: (settingsRef.current.encoder_index as number) ?? 0,
      onFfmpegMissing: () => addToast("error", "FFmpeg Not Found", FFMPEG_MISSING_TOAST_MESSAGE),
    });
  const { compressing, setCompressing, cancelling, progress, eta, cancelCompress, resetProgress } =
    useCompression({ onToast: addToast });

  const previewRef = useRef<PreviewHandle>(null);
  const trimWrapRef = useRef<HTMLDivElement>(null);
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
  const autoFfmpegInstallPromptedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const selectedFilePathRef = useRef<string | null>(null);
  const probeDataRef = useRef<ProbeData | null>(null);
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
  const [playheadTime, setPlayheadTime] = useState<number | null>(null);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [snapMode, setSnapMode] = useState<SnapMode>("off");
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [timelineCenterVal, setTimelineCenterVal] = useState(SLIDER_MAX / 2);

  // --- File state ---
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState("Drag a video here or click Browse");
  const [probeData, setProbeData] = useState<ProbeData | null>(null);
  const [startVal, setStartVal] = useState(0);
  const [endVal, setEndVal] = useState(SLIDER_MAX);

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
      nextStart = snapSliderValue(nextStart);
      nextEnd = snapSliderValue(nextEnd);

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
    [snapSliderValue]
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

  const playheadTimeRef = useRef<number | null>(null);
  useEffect(() => {
    playheadTimeRef.current = playheadTime;
  }, [playheadTime]);

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
      setFilePath(path);
      setFileName(path.split(/[\\/]/).pop() ?? path);
      probeDataRef.current = null;
      setProbeData(null);
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
      setStartVal(0);
      setEndVal(SLIDER_MAX);
      setPreviewFocusTime(null);
      setPreviewScrubbing(false);
      setPlayheadTime(null);
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
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
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
    const startTime = (startValRef.current / SLIDER_MAX) * duration;
    const endTime = (endValRef.current / SLIDER_MAX) * duration;
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
    let outputFps: number | null = null;

    if (advancedMode) {
      const sz = parseFloat(advSize);
      if (!advSize || isNaN(sz) || sz <= 0) {
        addToast("warning", "Warning", "Enter a valid target size in MB.");
        setCompressing(false);
        return;
      }
      targetSize = sz;
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
      const preset = QUALITY_PRESETS[qualityIdx];
      targetSize = preset.size_mb;
      targetH = preset.target_h;
      encoderName = encoders[encoderIdx]?.name ?? "libx264";
      const selectedFps = FPS_OPTIONS.find((option) => option.value === fpsOption)?.fps ?? null;
      if (selectedFps !== null && (sourceFrameRate === null || selectedFps <= sourceFrameRate)) {
        outputFps = selectedFps;
      }
    }

    let videoBitrate = calculateBitrate(targetSize, clipDuration, removeAudio);
    if (probeData.bitrate > 0 && videoBitrate > probeData.bitrate) videoBitrate = probeData.bitrate;

    // resolve_output_path and get_vaapi_device are independent — run them in
    // parallel so we save one round-trip latency before the encode starts.
    const isVaapi = encoderName.endsWith("_vaapi");
    const [resolvedOutput, vaapiDevice] = await Promise.all([
      resolveOutputPath(filePath).catch(() => null),
      isVaapi ? getVaapiDevice().catch(() => null) : Promise.resolve(null),
    ]);
    if (!resolvedOutput) {
      addToast("error", "Error", "Could not resolve output path.");
      setCompressing(false);
      return;
    }

    const outputPath = await compressVideo({
      input_path: filePath,
      output_path: resolvedOutput,
      encoder: encoderName,
      video_bitrate_k: videoBitrate,
      target_size_mb: targetSize,
      start_time: startTime,
      end_time: endTime,
      remove_audio: removeAudio,
      output_fps: outputFps,
      scale_filter: buildScaleFilter(
        probeData.width,
        probeData.height,
        targetH,
        targetShort,
        encoderName
      ),
      vaapi_device: vaapiDevice,
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

    if (outputPath) {
      addToast("success", "Success", "Compression complete!");
      showInFileExplorer(outputPath).catch(() => {});
    }
  }, [
    filePath,
    probeData,
    ffmpegMissing,
    advancedMode,
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
    addToast,
    markFfmpegMissing,
    setCompressing,
  ]);

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
    const available = await checkFfmpegAvailable().catch(() => false);
    await refreshEncoders().catch(() => {});
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

    await refreshEncoders().catch(() => {});
    const available = await checkFfmpegAvailable().catch(() => false);
    if (available) {
      await reprobeSelectedVideo();
    }
    showInstallResult(result);

    setInstallingFfmpeg(false);
  }, [addToast, refreshEncoders, reprobeSelectedVideo]);

  useEffect(() => {
    if (!settingsLoaded || !ffmpegMissing || installingFfmpeg) return;
    if (autoFfmpegInstallPromptedRef.current) return;

    autoFfmpegInstallPromptedRef.current = true;
    const timer = window.setTimeout(() => {
      const approved = window.confirm(
        "FFmpeg is required for vidcord compression. Install it now using your platform's package manager?"
      );
      if (approved) {
        installFfmpeg();
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [ffmpegMissing, installFfmpeg, installingFfmpeg, settingsLoaded]);

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

  const canSetInPoint = useMemo(() => {
    if (!trimReady || playheadTime === null) return false;
    const next = normalizeTrim(Math.round((playheadTime / duration) * SLIDER_MAX), endVal, "start");
    return next.start !== startVal || next.end !== endVal;
  }, [duration, endVal, normalizeTrim, playheadTime, startVal, trimReady]);

  const canSetOutPoint = useMemo(() => {
    if (!trimReady || playheadTime === null) return false;
    const next = normalizeTrim(startVal, Math.round((playheadTime / duration) * SLIDER_MAX), "end");
    return next.start !== startVal || next.end !== endVal;
  }, [duration, endVal, normalizeTrim, playheadTime, startVal, trimReady]);

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

  const showEncoderOptions = encoderInputFocused && filteredEncoderOptions.length > 0;

  const acceptEncoderOption = useCallback(
    (option: string) => {
      setAdvEncoder(option);
      saveSettings({ advanced_encoder: option });
      setEncoderInputFocused(false);
    },
    [saveSettings, setAdvEncoder]
  );

  // Playhead time is now pushed from PreviewPane via the onTimeUpdate prop
  // (driven by the media element's `timeupdate` event and explicit seeks)
  // instead of an 80 ms wall-clock poll. The 0.02 s threshold below keeps
  // React re-renders from firing on sub-frame noise from the media pipeline.
  const handlePreviewTimeUpdate = useCallback((next: number | null) => {
    if (next === null) {
      playheadTimeRef.current = null;
      setPlayheadTime(null);
      return;
    }
    playheadTimeRef.current = next;
    setPlayheadTime((prev) => (prev !== null && Math.abs(prev - next) < 0.02 ? prev : next));
  }, []);

  // Playhead tracks absolute position across the full clip, like Premiere Pro.
  // It is independent of the trim handles and can appear outside the selected range.
  const trimPlayheadLeftPct = useMemo(() => {
    if (playheadTime === null || duration <= 0) return null;
    const val = (playheadTime / duration) * SLIDER_MAX;
    if (val < viewStartVal || val > viewEndVal) return null;
    return toViewPct(val);
  }, [playheadTime, duration, toViewPct, viewEndVal, viewStartVal]);

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
        setTimelineZoom((prev) => Math.max(1, Math.min(20, prev * zoomDelta)));
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
      playheadTimeRef.current = time;
      setPlayheadTime(time);
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
    setTimelineZoom((prev) => Math.min(20, prev * 1.25));
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
            {/* Drop zone */}
            <button
              type="button"
              className={`drop-zone${filePath ? " has-file" : ""}`}
              onClick={browseFile}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) loadVideo((f as File & { path?: string }).path ?? f.name);
              }}
            >
              <span className="drop-label" title={filePath ? fileName : undefined}>
                {fileName}
              </span>
              <span className="browse-btn" aria-hidden="true">
                Browse File
              </span>
            </button>

            {/* Basic settings */}
            {!advancedMode && (
              <div className="row settings-row">
                <label className="target-label">
                  Target
                  <select
                    value={qualityIdx}
                    onChange={(e) => {
                      setQualityIdx(+e.target.value);
                      saveSettings({ quality_index: +e.target.value });
                    }}
                  >
                    {QUALITY_PRESETS.map((p, i) => (
                      <option key={p.label} value={i}>
                        {p.label}
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
                      onClick={() => {
                        const next = !removeAudio;
                        setRemoveAudio(next);
                        saveSettings({ remove_audio: next });
                      }}
                    >
                      {removeAudio ? "Unmute" : "Mute"}
                    </button>
                  </div>
                </div>
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
                    onChange={(e) => {
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
                        aria-controls={showEncoderOptions ? "advanced-encoder-options" : undefined}
                        aria-activedescendant={
                          showEncoderOptions
                            ? `advanced-encoder-option-${activeEncoderOption}`
                            : undefined
                        }
                        onFocus={() => {
                          setEncoderInputFocused(true);
                          if (listedEncoderNames.length === 0) loadListedEncoders().catch(() => {});
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
                      onClick={() => {
                        const next = !removeAudio;
                        setRemoveAudio(next);
                        saveSettings({ remove_audio: next });
                      }}
                    >
                      {removeAudio ? "Unmute" : "Mute"}
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

            <TrimTimeline
              selectedDuration={selectedDuration}
              selectedDurationPct={selectedDurationPct}
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
              trimPlayheadLeftPct={trimPlayheadLeftPct}
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
            />
          </div>

          {/* Preview */}
          <PreviewPane
            ref={previewRef}
            filePath={filePath}
            startTime={startTime}
            endTime={endTime}
            previewTime={previewFocusTime}
            isScrubbing={previewScrubbing}
            loopPlayback={loopPlayback}
            probeData={probeData}
            removeAudio={removeAudio}
            onTimeUpdate={handlePreviewTimeUpdate}
          />

          {/* Compress button */}
          <button
            className={`compress-btn${compressing ? " cancel" : ""}`}
            onClick={
              compressing
                ? cancelCompress
                : () => {
                    setCompressing(true);
                    startCompress();
                  }
            }
            disabled={ffmpegMissing || cancelling || (!compressing && (!filePath || !probeData))}
          >
            {cancelling ? "Cancelling..." : compressing ? "Cancel" : "Compress Video"}
          </button>

          {/* Progress */}
          <ProgressSection progress={progress} eta={eta} />

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
            <label className="toggle-label footer-toggle advanced-toggle">
              <span>Advanced Mode</span>
              <span className="toggle-track">
                <input
                  type="checkbox"
                  className="toggle-input"
                  checked={advancedMode}
                  onChange={(e) => {
                    setAdvancedMode(e.target.checked);
                    saveSettings({ advanced_mode: e.target.checked });
                  }}
                />
                <span className="toggle-thumb" />
              </span>
            </label>
          </div>
        </div>

        {/* Toasts */}
        <div className="toast-container">
          {toasts.map((t) => (
            <Toast key={t.id} {...t} onClose={() => removeToast(t.id)} />
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
