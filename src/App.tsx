import { useEffect, useCallback, useState, useMemo, useRef, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";
import Toast from "./components/Toast";
import ProgressSection from "./components/ProgressSection";
import PreviewPane, { type PreviewHandle } from "./components/PreviewPane";
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

const SLIDER_MAX = 10000;
const MIN_TRIM_GAP = 1;
const UNDO_LIMIT = 200;
const FRAME_STEP_SECONDS = 1 / 30;

type SnapMode = "off" | "0.1" | "0.5" | "1.0";

type FfmpegInstallResult = {
  status:
    | "installed"
    | "already_available"
    | "failed"
    | "unsupported"
    | "requires_privileged"
    | "needs_manual_download";
  message: string;
  hint_command?: string | null;
  guide_url?: string | null;
};

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
    advEncoder,
    setAdvEncoder,
    removeAudio,
    setRemoveAudio,
    saveSettings,
  } = useSettings();
  const { encoders, encoderIdx, setEncoderIdx, ffmpegMissing, refreshEncoders } = useEncoders({
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

  const previewRef = useRef<PreviewHandle>(null);
  const trimWrapRef = useRef<HTMLDivElement>(null);
  const activeHandleRef = useRef<"start" | "end">("start");
  const startValRef = useRef(0);
  const endValRef = useRef(SLIDER_MAX);
  const pointerHistoryStartRef = useRef<{ start: number; end: number } | null>(null);
  const undoStackRef = useRef<Array<{ start: number; end: number }>>([]);
  const redoStackRef = useRef<Array<{ start: number; end: number }>>([]);
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
  const [updateInfo, setUpdateInfo] = useState<{ version: string; url: string } | null>(null);
  const [encodersDialogText, setEncodersDialogText] = useState<string | null>(null);
  const [listedEncoderNames, setListedEncoderNames] = useState<string[]>([]);
  const [installingFfmpeg, setInstallingFfmpeg] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [encoderInputFocused, setEncoderInputFocused] = useState(false);
  const [activeEncoderOption, setActiveEncoderOption] = useState(0);

  const duration = probeData?.duration ?? 0;

  const pushUndoSnapshot = useCallback((snapshot: { start: number; end: number }) => {
    undoStackRef.current.push(snapshot);
    if (undoStackRef.current.length > UNDO_LIMIT) {
      undoStackRef.current.shift();
    }
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

  const applyTrim = useCallback(
    (rawStart: number, rawEnd: number, opts?: { record?: boolean; anchor?: "start" | "end" }) => {
      const anchor = opts?.anchor ?? "start";
      const record = opts?.record ?? true;
      const prev = { start: startValRef.current, end: endValRef.current };
      const next = normalizeTrim(rawStart, rawEnd, anchor);
      if (next.start === prev.start && next.end === prev.end) return;
      if (record) {
        pushUndoSnapshot(prev);
        redoStackRef.current = [];
      }
      // Update refs synchronously so any same-frame read (commitPointerTrimChange,
      // rapid undo/redo) sees the new values rather than waiting for useEffect.
      startValRef.current = next.start;
      endValRef.current = next.end;
      setStartVal(next.start);
      setEndVal(next.end);
    },
    [normalizeTrim, pushUndoSnapshot]
  );

  const undoTrim = useCallback(() => {
    const target = undoStackRef.current.pop();
    if (!target) return;
    redoStackRef.current.push({ start: startValRef.current, end: endValRef.current });
    startValRef.current = target.start;
    endValRef.current = target.end;
    setStartVal(target.start);
    setEndVal(target.end);
  }, []);

  const redoTrim = useCallback(() => {
    const target = redoStackRef.current.pop();
    if (!target) return;
    pushUndoSnapshot({ start: startValRef.current, end: endValRef.current });
    startValRef.current = target.start;
    endValRef.current = target.end;
    setStartVal(target.start);
    setEndVal(target.end);
  }, [pushUndoSnapshot]);

  const playheadTimeRef = useRef<number | null>(null);
  useEffect(() => {
    playheadTimeRef.current = playheadTime;
  }, [playheadTime]);

  const setInPoint = useCallback(() => {
    const pt = playheadTimeRef.current;
    if (pt === null || duration <= 0) return;
    const val = Math.round((pt / duration) * SLIDER_MAX);
    applyTrim(val, endValRef.current, { anchor: "start" });
  }, [duration, applyTrim]);

  const setOutPoint = useCallback(() => {
    const pt = playheadTimeRef.current;
    if (pt === null || duration <= 0) return;
    const val = Math.round((pt / duration) * SLIDER_MAX);
    applyTrim(startValRef.current, val, { anchor: "end" });
  }, [duration, applyTrim]);

  // --- File loading ---
  const loadVideo = useCallback(
    async (path: string) => {
      if (!/\.(mp4|avi|mov|mkv|flv|wmv|webm)$/i.test(path)) {
        setFileName("Unsupported file format.");
        return;
      }
      setFilePath(path);
      setFileName(path.split(/[\\/]/).pop() ?? path);
      setStartVal(0);
      setEndVal(SLIDER_MAX);
      setTimelineCenterVal(SLIDER_MAX / 2);
      setTimelineZoom(1);
      undoStackRef.current = [];
      redoStackRef.current = [];
      resetProgress();
      try {
        const data = await invoke<ProbeData>("probe", { path });
        setProbeData(data);
      } catch (e) {
        setFileName(`Error loading video: ${e}`);
        setProbeData(null);
      }
    },
    [resetProgress]
  );

  useEffect(() => {
    startValRef.current = startVal;
    endValRef.current = endVal;
  }, [startVal, endVal]);

  const browseFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "avi", "mov", "mkv", "flv", "wmv", "webm"] }],
    });
    if (selected && typeof selected === "string") await loadVideo(selected);
  }, [loadVideo]);

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
    const unsub = listen<string>("open-file", (e) => loadVideoRef.current(e.payload));
    return () => {
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
      event.preventDefault();
    };
    window.addEventListener("contextmenu", suppressContextMenu);
    return () => {
      window.removeEventListener("contextmenu", suppressContextMenu);
    };
  }, []);

  // Keyboard shortcuts (only when a file is loaded and focus is not in a text input)
  useEffect(() => {
    if (!filePath) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) {
          redoTrim();
        } else {
          undoTrim();
        }
        return;
      }

      if (e.key === " ") {
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
        previewRef.current?.stepBy(-FRAME_STEP_SECONDS);
      } else if (e.key === ".") {
        e.preventDefault();
        previewRef.current?.stepBy(FRAME_STEP_SECONDS);
      } else if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        previewRef.current?.seekTo((startVal / SLIDER_MAX) * duration);
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        previewRef.current?.seekTo((endVal / SLIDER_MAX) * duration);
      } else if (e.key === "[") {
        e.preventDefault();
        applyTrim(startValRef.current - coarseStep, endValRef.current, { anchor: "start" });
      } else if (e.key === "]") {
        e.preventDefault();
        applyTrim(startValRef.current, endValRef.current + coarseStep, { anchor: "end" });
      } else if (e.key === "r" || e.key === "R" || e.key === "u" || e.key === "U") {
        e.preventDefault();
        applyTrim(0, SLIDER_MAX, { anchor: "end" });
      } else if (e.key === "i" || e.key === "I") {
        e.preventDefault();
        const pt = playheadTimeRef.current;
        if (pt === null) return;
        const currentVal = Math.max(0, Math.min(SLIDER_MAX, Math.round((pt / dur) * SLIDER_MAX)));
        applyTrim(currentVal, endValRef.current, { anchor: "start" });
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        const pt = playheadTimeRef.current;
        if (pt === null) return;
        const currentVal = Math.max(0, Math.min(SLIDER_MAX, Math.round((pt / dur) * SLIDER_MAX)));
        applyTrim(startValRef.current, currentVal, { anchor: "end" });
      } else if (e.shiftKey && e.key === "ArrowLeft") {
        e.preventDefault();
        if (activeHandleRef.current === "start") {
          applyTrim(startValRef.current - fineStep, endValRef.current, { anchor: "start" });
        } else {
          applyTrim(startValRef.current, endValRef.current - fineStep, { anchor: "end" });
        }
      } else if (e.shiftKey && e.key === "ArrowRight") {
        e.preventDefault();
        if (activeHandleRef.current === "start") {
          applyTrim(startValRef.current + fineStep, endValRef.current, { anchor: "start" });
        } else {
          applyTrim(startValRef.current, endValRef.current + fineStep, { anchor: "end" });
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filePath, probeData, redoTrim, undoTrim, startVal, endVal, duration, applyTrim]);

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
        if (r.update_available && r.latest_version && r.release_url) {
          const dismissed = settingsRef.current.update_dismissed_version as string | undefined;
          if (dismissed !== r.latest_version) {
            setUpdateInfo({ version: r.latest_version, url: r.release_url });
          }
        }
      })
      // Advance the throttle timestamp on both success and failure so a
      // transient network error doesn't cause every subsequent app launch to
      // re-fire the request immediately.
      .finally(() => {
        saveSettings({ update_last_check: Date.now() / 1000 });
      });
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

    // resolve_output_path and get_vaapi_device are independent — run them in
    // parallel so we save one round-trip latency before the encode starts.
    const isVaapi = encoderName.endsWith("_vaapi");
    const [resolvedOutput, vaapiDevice] = await Promise.all([
      invoke<string>("resolve_output_path", { inputPath: filePath }).catch(() => null),
      isVaapi ? invoke<string | null>("get_vaapi_device").catch(() => null) : Promise.resolve(null),
    ]);
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
        target_size_mb: targetSize,
        start_time: startTime,
        end_time: endTime,
        remove_audio: removeAudio,
        scale_filter: buildScaleFilter(
          probeData.width,
          probeData.height,
          targetH,
          targetShort,
          encoderName
        ),
        vaapi_device: vaapiDevice,
      },
    }).catch((e) => {
      addToast("error", "Error", String(e));
      return null;
    });

    if (outputPath) {
      addToast("success", "Success", "Compression complete!");
      invoke("show_in_file_explorer", { path: outputPath }).catch(() => {});
    }
  }, [
    filePath,
    probeData,
    startVal,
    endVal,
    advancedMode,
    advSize,
    advResolution,
    advEncoder,
    qualityIdx,
    encoderIdx,
    encoders,
    removeAudio,
    addToast,
    setCompressing,
  ]);

  const loadListedEncoders = useCallback(async () => {
    const text = await invoke<string>("list_ffmpeg_video_encoders").catch((e) => `Error: ${e}`);
    setListedEncoderNames(parseListedEncoderNames(text));
    return text;
  }, []);

  const showEncoders = useCallback(async () => {
    const text = await loadListedEncoders();
    setEncodersDialogText(text);
  }, [loadListedEncoders]);

  useEffect(() => {
    if (!settingsLoaded || !advancedMode || listedEncoderNames.length > 0) return;
    loadListedEncoders().catch(() => {});
  }, [advancedMode, listedEncoderNames.length, loadListedEncoders, settingsLoaded]);

  const retryFfmpegDetection = useCallback(async () => {
    await refreshEncoders().catch(() => {});
    const available = await invoke<boolean>("check_ffmpeg_available").catch(() => false);
    if (available) {
      addToast("success", "FFmpeg Ready", "FFmpeg is now available.");
    } else {
      addToast("warning", "Still Missing", "FFmpeg is still not detected on PATH.");
    }
  }, [addToast, refreshEncoders]);

  const installFfmpeg = useCallback(async () => {
    setInstallingFfmpeg(true);
    const os = await invoke<string>("get_os").catch(() => "unknown");

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
        openUrl(result.guide_url).catch(() => {});
      }
    };

    let result = await invoke<FfmpegInstallResult>("install_ffmpeg_dependency", {
      opts: { allow_privileged: false },
    }).catch((e) => ({
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
        result = await invoke<FfmpegInstallResult>("install_ffmpeg_dependency", {
          opts: { allow_privileged: true },
        }).catch((e) => ({
          status: "failed" as const,
          message: String(e),
          hint_command: null,
          guide_url: null,
        }));
      }
    }

    await refreshEncoders().catch(() => {});
    showInstallResult(result);

    setInstallingFfmpeg(false);
  }, [addToast, refreshEncoders]);

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

  const viewSpan = useMemo(
    () => Math.max(MIN_TRIM_GAP, SLIDER_MAX / Math.max(1, timelineZoom)),
    [timelineZoom]
  );

  const viewStartVal = useMemo(() => {
    const half = viewSpan / 2;
    return Math.max(0, Math.min(timelineCenterVal - half, SLIDER_MAX - viewSpan));
  }, [timelineCenterVal, viewSpan]);

  const viewEndVal = useMemo(() => viewStartVal + viewSpan, [viewStartVal, viewSpan]);

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
    return toViewPct(val);
  }, [playheadTime, duration, toViewPct]);

  useEffect(() => {
    if (timelineZoom <= 1) return;
    const center = (startVal + endVal) / 2;
    if (center < viewStartVal || center > viewEndVal) {
      setTimelineCenterVal(center);
    }
  }, [timelineZoom, startVal, endVal, viewStartVal, viewEndVal]);

  const beginPointerTrimChange = useCallback(() => {
    pointerHistoryStartRef.current = {
      start: startValRef.current,
      end: endValRef.current,
    };
  }, []);

  const commitPointerTrimChange = useCallback(() => {
    const started = pointerHistoryStartRef.current;
    pointerHistoryStartRef.current = null;
    if (!started) return;
    const now = { start: startValRef.current, end: endValRef.current };
    if (started.start === now.start && started.end === now.end) return;
    pushUndoSnapshot(started);
    redoStackRef.current = [];
  }, [pushUndoSnapshot]);

  const handleRangeDragStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const wrap = trimWrapRef.current;
      if (!wrap) return;
      e.preventDefault();

      const rect = wrap.getBoundingClientRect();
      if (rect.width <= 0) return;

      beginPointerTrimChange();
      const originX = e.clientX;
      const originStart = startValRef.current;
      const originEnd = endValRef.current;
      const span = originEnd - originStart;

      const onMove = (moveEvent: MouseEvent) => {
        const deltaPx = moveEvent.clientX - originX;
        const deltaVal = (deltaPx / rect.width) * (viewEndVal - viewStartVal);
        let nextStart = originStart + deltaVal;
        nextStart = Math.max(0, Math.min(nextStart, SLIDER_MAX - span));
        applyTrim(nextStart, nextStart + span, { record: false, anchor: "start" });
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        commitPointerTrimChange();
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [applyTrim, beginPointerTrimChange, commitPointerTrimChange, viewStartVal, viewEndVal]
  );

  const handleTrimWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const zoomDelta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        setTimelineZoom((prev) => Math.max(1, Math.min(20, prev * zoomDelta)));
        return;
      }

      const panStep = (viewEndVal - viewStartVal) * 0.08;
      setTimelineCenterVal((prev) => {
        const next = prev + (e.deltaY > 0 ? panStep : -panStep);
        return Math.max(0, Math.min(SLIDER_MAX, next));
      });
    },
    [viewStartVal, viewEndVal]
  );

  const seekToTimelineClick = useCallback(
    (clientX: number) => {
      const wrap = trimWrapRef.current;
      if (!wrap || !probeData || duration <= 0) return;
      const rect = wrap.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const viewVal = viewStartVal + fraction * (viewEndVal - viewStartVal);
      const time = Math.max(0, Math.min((viewVal / SLIDER_MAX) * duration, duration));
      previewRef.current?.seekTo(time);
      playheadTimeRef.current = time;
      setPlayheadTime(time);
    },
    [probeData, duration, viewStartVal, viewEndVal]
  );

  const handleTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      seekToTimelineClick(e.clientX);
    },
    [seekToTimelineClick]
  );

  const handlePlayheadDragStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (!probeData || duration <= 0) return;
      seekToTimelineClick(e.clientX);
      const onMove = (mv: MouseEvent) => seekToTimelineClick(mv.clientX);
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [probeData, duration, seekToTimelineClick]
  );

  return (
    <div className="app">
      {/* Update banner */}
      {updateInfo && (
        <div className="update-banner">
          <span>Version {updateInfo.version} available.</span>
          <a
            href={updateInfo.url}
            onClick={(e) => {
              e.preventDefault();
              openUrl(updateInfo.url);
            }}
          >
            Download
          </a>
          <button
            className="update-dismiss"
            onClick={() => {
              saveSettings({ update_dismissed_version: updateInfo.version });
              setUpdateInfo(null);
            }}
          >
            ✕
          </button>
        </div>
      )}

      {ffmpegMissing && (
        <div className="ffmpeg-banner">
          <span>FFmpeg is missing. Install it to enable compression.</span>
          <button
            className="ffmpeg-install-btn"
            onClick={installFfmpeg}
            disabled={installingFfmpeg}
          >
            {installingFfmpeg ? "Installing..." : "Install FFmpeg"}
          </button>
          <button className="ffmpeg-link-btn" onClick={retryFfmpegDetection}>
            Retry
          </button>
          <button
            className="ffmpeg-link-btn"
            onClick={() => openUrl("https://github.com/cyroz1/vidcord/blob/main/FFMPEG_SETUP.md")}
          >
            Setup Guide
          </button>
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
          <button
            className="browse-btn"
            onClick={(e) => {
              e.stopPropagation();
              browseFile();
            }}
          >
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
            <label>
              Encoder
              <div className="encoder-row">
                <select
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
              {isH265Encoder(encoders[encoderIdx]?.name ?? "") && (
                <div className="encoder-warning">
                  ⚠ H.265 compresses more efficiently (better quality at the same target size), but
                  isn't supported on all devices, browsers, or older Discord clients — recipients
                  may see a black screen or audio-only playback.
                </div>
              )}
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
            <label className="encoder-label">
              Encoder
              <div className="encoder-row">
                <div className="encoder-autocomplete">
                  {showPrediction && (
                    <div className="encoder-ghost" aria-hidden="true">
                      {predictedEncoder}
                    </div>
                  )}
                  <input
                    type="text"
                    autoComplete="off"
                    placeholder="e.g. libx264"
                    value={advEncoder}
                    aria-autocomplete="list"
                    aria-expanded={showEncoderOptions}
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
                      if ((e.key === "Tab" || e.key === "ArrowRight") && showPrediction) {
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
                    <div className="encoder-options" role="listbox">
                      {filteredEncoderOptions.map((option, index) => (
                        <button
                          type="button"
                          className={`encoder-option${
                            index === activeEncoderOption ? " active" : ""
                          }`}
                          key={option}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            acceptEncoderOption(option);
                          }}
                        >
                          {option}
                        </button>
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
                <button className="icon-btn" title="Show FFmpeg encoders" onClick={showEncoders}>
                  ℹ
                </button>
              </div>
            </label>
          </div>
        )}

        {/* Trim slider */}
        <div className="trim-section">
          <div className="trim-header">
            <span className="section-title">Trim Video</span>
            <span className="trim-selection-meta">
              {selectedDuration.toFixed(2)}s selected ({selectedDurationPct.toFixed(1)}%)
            </span>
            <button
              type="button"
              className="trim-mini-btn"
              onClick={setInPoint}
              disabled={playheadTime === null}
              title="Set in point to playhead (I)"
            >
              In
            </button>
            <button
              type="button"
              className="trim-mini-btn"
              onClick={setOutPoint}
              disabled={playheadTime === null}
              title="Set out point to playhead (O)"
            >
              Out
            </button>
            <label className="trim-inline-control">
              Snap
              <select value={snapMode} onChange={(e) => setSnapMode(e.target.value as SnapMode)}>
                <option value="off">Off</option>
                <option value="0.1">0.1s</option>
                <option value="0.5">0.5s</option>
                <option value="1.0">1.0s</option>
              </select>
            </label>
            <div className="trim-zoom-controls">
              <button
                type="button"
                className="trim-mini-btn"
                onClick={() => setTimelineZoom((prev) => Math.max(1, prev / 1.25))}
              >
                -
              </button>
              <button
                type="button"
                className="trim-mini-btn"
                onClick={() => {
                  setTimelineZoom(1);
                  setTimelineCenterVal((startValRef.current + endValRef.current) / 2);
                }}
                title="Reset zoom"
              >
                {timelineZoom.toFixed(1)}x
              </button>
              <button
                type="button"
                className="trim-mini-btn"
                onClick={() => setTimelineZoom((prev) => Math.min(20, prev * 1.25))}
              >
                +
              </button>
            </div>
            <button
              type="button"
              className="trim-mini-btn"
              onClick={undoTrim}
              title="Undo trim (Cmd/Ctrl+Z)"
            >
              Undo
            </button>
            <button
              type="button"
              className="trim-mini-btn"
              onClick={redoTrim}
              title="Redo trim (Cmd/Ctrl+Shift+Z)"
            >
              Redo
            </button>
            <label className="trim-loop-toggle">
              <input
                type="checkbox"
                checked={loopPlayback}
                onChange={(e) => setLoopPlayback(e.target.checked)}
              />
              Loop
            </label>
            <button
              type="button"
              className={`trim-mini-btn trim-shortcuts-btn${showShortcuts ? " active" : ""}`}
              onClick={() => setShowShortcuts((v) => !v)}
              title="Keyboard shortcuts"
            >
              ?
            </button>
          </div>
          {showShortcuts && (
            <div className="trim-shortcuts-panel">
              <div className="trim-shortcuts-grid">
                <span className="sc-key">Space</span>
                <span>Play / Pause</span>
                <span className="sc-key">, / .</span>
                <span>Step frame back / forward</span>
                <span className="sc-key">I</span>
                <span>Set in point to playhead</span>
                <span className="sc-key">O</span>
                <span>Set out point to playhead</span>
                <span className="sc-key">J</span>
                <span>Seek to in point</span>
                <span className="sc-key">K</span>
                <span>Seek to out point</span>
                <span className="sc-key">[ / ]</span>
                <span>Expand in / out point</span>
                <span className="sc-key">R / U</span>
                <span>Reset trim to full clip</span>
                <span className="sc-key">⇧ ← / →</span>
                <span>Nudge active handle</span>
                <span className="sc-key">⌘Z / ⇧⌘Z</span>
                <span>Undo / Redo trim</span>
              </div>
            </div>
          )}
          <div className="slider-row trim-dual-row">
            <span className="time-label time-label-left">{startTime.toFixed(1)}s</span>
            <div
              ref={trimWrapRef}
              className="trim-dual-wrap"
              onWheel={handleTrimWheel}
              onClick={handleTimelineClick}
              title="Click to seek · Wheel to pan · Ctrl+Wheel to zoom"
              style={{ cursor: filePath ? "crosshair" : undefined }}
            >
              <div className="trim-dual-track" />
              <div
                className="trim-dual-range"
                style={{
                  left: `${startPct}%`,
                  width: `${Math.max(endPct - startPct, 0)}%`,
                }}
                onMouseDown={handleRangeDragStart}
              />
              {trimPlayheadLeftPct !== null && (
                <div
                  className="trim-playhead"
                  style={{ left: `${trimPlayheadLeftPct}%` }}
                  onMouseDown={handlePlayheadDragStart}
                />
              )}
              <input
                className="trim-handle trim-start-handle"
                type="range"
                min={Math.round(viewStartVal)}
                max={Math.round(viewEndVal)}
                value={startVal}
                onPointerDown={() => {
                  activeHandleRef.current = "start";
                  beginPointerTrimChange();
                }}
                onPointerUp={commitPointerTrimChange}
                onChange={(e) => {
                  const next = +e.target.value;
                  applyTrim(next, endValRef.current, { record: false, anchor: "start" });
                }}
                aria-label="Trim start"
              />
              <input
                className="trim-handle trim-end-handle"
                type="range"
                min={Math.round(viewStartVal)}
                max={Math.round(viewEndVal)}
                value={endVal}
                onPointerDown={() => {
                  activeHandleRef.current = "end";
                  beginPointerTrimChange();
                }}
                onPointerUp={commitPointerTrimChange}
                onChange={(e) => {
                  const next = +e.target.value;
                  applyTrim(startValRef.current, next, { record: false, anchor: "end" });
                }}
                aria-label="Trim end"
              />
            </div>
            <span className="time-label time-label-right">{endTime.toFixed(1)}s</span>
          </div>
        </div>

        {/* Preview */}
        <PreviewPane
          ref={previewRef}
          filePath={filePath}
          startTime={startTime}
          endTime={endTime}
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
            onClick={(e) => {
              e.preventDefault();
              openUrl("https://github.com/cyroz1/vidcord");
            }}
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

      {/* Encoders dialog — lazy-loaded, only rendered after user opens it */}
      {encodersDialogText !== null && (
        <Suspense fallback={null}>
          <EncodersDialog text={encodersDialogText} onClose={() => setEncodersDialogText(null)} />
        </Suspense>
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
