import { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { cancelCompression, isTauriRuntime, type ProbeData } from "../ipc";
import type { BatchDonePayload, BatchProgressPayload } from "../ipc";
import { AUDIO_TRACK_BITRATE_KBPS } from "../audioTracks";

export type { ProbeData };

type Props = {
  onBatchProgress?: (payload: BatchProgressPayload) => void;
};

export type CompressProgressPayload = {
  percent: number;
  eta: string;
  status: string;
  attempt?: number;
  attempt_total?: number;
  encoder?: string;
  video_bitrate_k?: number;
  gif_mode?: boolean;
  lossless_trim?: boolean;
};

export type CompressDonePayload = {
  success: boolean;
  cancelled?: boolean;
  message: string;
  input_size_bytes?: number;
  output_size_bytes?: number;
  target_size_bytes?: number;
  smallest_output_size_bytes?: number;
  lossless_trim?: boolean;
  actual_start_time?: number;
  actual_end_time?: number;
  output_extension?: string;
};

export type { BatchDonePayload, BatchProgressPayload };

function batchProgressEqual(
  left: BatchProgressPayload | null,
  right: BatchProgressPayload
): boolean {
  return (
    left !== null &&
    left.item_id === right.item_id &&
    left.item_percent === right.item_percent &&
    left.percent === right.percent &&
    left.eta === right.eta &&
    left.status === right.status &&
    left.phase === right.phase &&
    left.active_count === right.active_count &&
    left.completed_count === right.completed_count &&
    left.total_count === right.total_count &&
    left.attempt === right.attempt &&
    left.attempt_total === right.attempt_total &&
    left.encoder === right.encoder &&
    left.video_bitrate_k === right.video_bitrate_k
  );
}

// While the window is hidden, requestAnimationFrame is paused by the
// WebView, so a RAF-only schedule would freeze progress for the whole
// hidden period. Race every RAF schedule against this timeout instead:
// whichever fires first flushes and cancels the other.
const HIDDEN_FLUSH_DELAY_MS = 250;

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

export function useCompression({ onBatchProgress }: Props = {}) {
  const [compressing, setCompressing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [eta, setEta] = useState("Ready");
  const cancellingRef = useRef(false);
  const preparationRef = useRef<AbortController | null>(null);
  const onBatchProgressRef = useRef(onBatchProgress);
  // Progress events can arrive far faster than the display can usefully
  // update. Keep only the latest payload per stream and flush it at
  // animation-frame rate, skipping flushes whose displayed values are
  // unchanged so a progress tick does not re-render the whole app.
  const pendingProgressRef = useRef<CompressProgressPayload | null>(null);
  // Batch progress is kept per item, not in a single slot: if item A
  // reaches a terminal phase and item B emits progress in the same frame,
  // a single slot would overwrite A's payload before it is ever flushed,
  // leaving A's row stuck on "encoding" until the batch ends. The map is
  // delete-then-set on each event so iteration order is arrival order.
  const pendingBatchProgressRef = useRef<Map<number, BatchProgressPayload>>(new Map());
  const progressRafRef = useRef<number | null>(null);
  const batchProgressRafRef = useRef<number | null>(null);
  const progressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastProgressRef = useRef<{ percent: number; eta: string } | null>(null);
  const lastBatchProgressRef = useRef<BatchProgressPayload | null>(null);

  useEffect(() => {
    onBatchProgressRef.current = onBatchProgress;
  }, [onBatchProgress]);

  const clearProgressSchedule = useCallback(() => {
    if (progressRafRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(progressRafRef.current);
    }
    progressRafRef.current = null;
    if (progressTimeoutRef.current !== null) {
      clearTimeout(progressTimeoutRef.current);
      progressTimeoutRef.current = null;
    }
  }, []);

  const clearBatchProgressSchedule = useCallback(() => {
    if (batchProgressRafRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(batchProgressRafRef.current);
    }
    batchProgressRafRef.current = null;
    if (batchProgressTimeoutRef.current !== null) {
      clearTimeout(batchProgressTimeoutRef.current);
      batchProgressTimeoutRef.current = null;
    }
  }, []);

  const flushProgress = useCallback(() => {
    clearProgressSchedule();
    const payload = pendingProgressRef.current;
    pendingProgressRef.current = null;
    if (!payload || cancellingRef.current) return;
    const nextEta = formatCompressionProgress(payload);
    const last = lastProgressRef.current;
    if (last?.percent !== payload.percent) setProgress(payload.percent);
    if (last?.eta !== nextEta) setEta(nextEta);
    lastProgressRef.current = { percent: payload.percent, eta: nextEta };
  }, [clearProgressSchedule]);

  const scheduleProgressFlush = useCallback(() => {
    if (progressRafRef.current !== null || progressTimeoutRef.current !== null) return;
    if (documentHidden()) {
      progressTimeoutRef.current = setTimeout(flushProgress, HIDDEN_FLUSH_DELAY_MS);
    } else if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      progressRafRef.current = window.requestAnimationFrame(flushProgress);
      // The window can be hidden after this schedule; the timeout race
      // keeps progress moving in that case and is cancelled by the RAF
      // flush when the window stays visible.
      progressTimeoutRef.current = setTimeout(flushProgress, HIDDEN_FLUSH_DELAY_MS);
    } else {
      flushProgress();
    }
  }, [flushProgress]);

  const cancelProgressFlush = useCallback(() => {
    clearProgressSchedule();
    pendingProgressRef.current = null;
  }, [clearProgressSchedule]);

  const flushBatchProgress = useCallback(() => {
    clearBatchProgressSchedule();
    const payloads = Array.from(pendingBatchProgressRef.current.values());
    pendingBatchProgressRef.current.clear();
    if (payloads.length === 0 || cancellingRef.current) return;
    for (const payload of payloads) {
      if (batchProgressEqual(lastBatchProgressRef.current, payload)) continue;
      lastBatchProgressRef.current = payload;
      const nextEta = formatBatchProgress(payload);
      setProgress(payload.percent);
      setEta(nextEta);
      lastProgressRef.current = { percent: payload.percent, eta: nextEta };
      // Fold the batch-queue item update into this same flush: the callback
      // updates App's queue state synchronously, so React batches it with
      // the progress setters above into a single render instead of a second
      // render from a derived-state effect.
      onBatchProgressRef.current?.(payload);
    }
  }, [clearBatchProgressSchedule]);

  const scheduleBatchProgressFlush = useCallback(() => {
    // A terminal payload (completed / failed / cancelled) must not wait
    // for, or be overwritten during, a coalescing frame: flush every
    // pending per-item payload synchronously as soon as one arrives.
    for (const pending of pendingBatchProgressRef.current.values()) {
      if (pending.phase !== "encoding") {
        flushBatchProgress();
        return;
      }
    }
    if (batchProgressRafRef.current !== null || batchProgressTimeoutRef.current !== null) return;
    if (documentHidden()) {
      batchProgressTimeoutRef.current = setTimeout(flushBatchProgress, HIDDEN_FLUSH_DELAY_MS);
    } else if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      batchProgressRafRef.current = window.requestAnimationFrame(flushBatchProgress);
      batchProgressTimeoutRef.current = setTimeout(flushBatchProgress, HIDDEN_FLUSH_DELAY_MS);
    } else {
      flushBatchProgress();
    }
  }, [flushBatchProgress]);

  const cancelBatchProgressFlush = useCallback(() => {
    clearBatchProgressSchedule();
    pendingBatchProgressRef.current.clear();
    lastBatchProgressRef.current = null;
  }, [clearBatchProgressSchedule]);

  const beginPreparation = useCallback(() => {
    preparationRef.current?.abort();
    const controller = new AbortController();
    preparationRef.current = controller;
    return controller.signal;
  }, []);

  const finishPreparation = useCallback((signal: AbortSignal) => {
    if (preparationRef.current?.signal !== signal) return false;
    preparationRef.current = null;
    return !signal.aborted;
  }, []);

  useEffect(() => () => preparationRef.current?.abort(), []);

  // Subscribe to backend compression events
  useEffect(() => {
    if (!isTauriRuntime()) return;
    const unsub1 = listen<CompressProgressPayload>("compress-progress", (e) => {
      if (cancellingRef.current) return;
      pendingProgressRef.current = e.payload;
      scheduleProgressFlush();
    });
    const unsub2 = listen<CompressDonePayload>("compress-done", (e) => {
      cancelProgressFlush();
      cancellingRef.current = false;
      setCancelling(false);
      setCompressing(false);
      const nextProgress = e.payload.success ? 100 : 0;
      const nextEta = formatCompressionDone(e.payload);
      setProgress(nextProgress);
      setEta(nextEta);
      lastProgressRef.current = { percent: nextProgress, eta: nextEta };
    });
    const unsub3 = listen<BatchProgressPayload>("batch-progress", (e) => {
      if (cancellingRef.current) return;
      // Delete-then-set keeps the map ordered by latest arrival per item.
      pendingBatchProgressRef.current.delete(e.payload.item_id);
      pendingBatchProgressRef.current.set(e.payload.item_id, e.payload);
      scheduleBatchProgressFlush();
    });
    const unsub4 = listen<BatchDonePayload>("batch-done", (e) => {
      cancelProgressFlush();
      cancelBatchProgressFlush();
      cancellingRef.current = false;
      setCancelling(false);
      setCompressing(false);
      const nextProgress = e.payload.success
        ? 100
        : e.payload.cancelled
          ? 0
          : e.payload.results.length > 0
            ? 100
            : 0;
      setProgress(nextProgress);
      setEta(e.payload.message);
      lastProgressRef.current = { percent: nextProgress, eta: e.payload.message };
    });
    return () => {
      cancelProgressFlush();
      cancelBatchProgressFlush();
      unsub1.then((fn) => fn()).catch(() => {});
      unsub2.then((fn) => fn()).catch(() => {});
      unsub3.then((fn) => fn()).catch(() => {});
      unsub4.then((fn) => fn()).catch(() => {});
    };
  }, [
    cancelBatchProgressFlush,
    cancelProgressFlush,
    scheduleBatchProgressFlush,
    scheduleProgressFlush,
  ]);

  const cancelCompress = useCallback(async () => {
    if (preparationRef.current) {
      preparationRef.current.abort();
      preparationRef.current = null;
      cancelProgressFlush();
      cancelBatchProgressFlush();
      lastProgressRef.current = { percent: 0, eta: "Cancelled." };
      setCompressing(false);
      setProgress(0);
      setEta("Cancelled.");
      return;
    }
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    setCancelling(true);
    setEta("Cancelling...");
    try {
      const hadActiveJob = await cancelCompression();
      if (!hadActiveJob) {
        cancellingRef.current = false;
        setCancelling(false);
        setCompressing(false);
        setEta("Ready");
      }
    } catch {
      cancellingRef.current = false;
      setCancelling(false);
      setEta("Could not cancel");
    }
  }, [cancelBatchProgressFlush, cancelProgressFlush]);

  const resetProgress = useCallback(() => {
    cancelProgressFlush();
    cancelBatchProgressFlush();
    lastProgressRef.current = { percent: 0, eta: "Ready" };
    setProgress(0);
    setEta("Ready");
  }, [cancelBatchProgressFlush, cancelProgressFlush]);

  return {
    compressing,
    setCompressing,
    cancelling,
    progress,
    eta,
    cancelCompress,
    beginPreparation,
    finishPreparation,
    resetProgress,
  };
}

// ---------------------------------------------------------------------------
// Pure calculation helpers (exported for reuse and testability)
// ---------------------------------------------------------------------------

export function formatSizeMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (!Number.isFinite(mb) || mb < 0) return "0 MB";
  if (mb >= 100) return `${mb.toFixed(0)} MB`;
  if (mb >= 10) return `${mb.toFixed(1)} MB`;
  return `${mb.toFixed(2)} MB`;
}

export function formatCompressionProgress(payload: CompressProgressPayload): string {
  const details: string[] = [];
  if (
    typeof payload.attempt === "number" &&
    typeof payload.attempt_total === "number" &&
    payload.attempt_total > 1
  ) {
    details.push(`Attempt ${payload.attempt}`);
  }
  if (payload.encoder) details.push(payload.encoder);
  if (!payload.gif_mode && !payload.lossless_trim && typeof payload.video_bitrate_k === "number") {
    details.push(`${payload.video_bitrate_k} kbps`);
  }
  if (details.length > 0) return `${details.join(" · ")} · ETA: ${payload.eta}`;
  return `${payload.status} ETA: ${payload.eta}`;
}

export function formatCompressionDone(payload: CompressDonePayload): string {
  if (payload.success && payload.lossless_trim) return payload.message;
  if (payload.success && typeof payload.output_size_bytes === "number") {
    if (
      typeof payload.input_size_bytes === "number" &&
      Number.isFinite(payload.input_size_bytes) &&
      payload.input_size_bytes > 0
    ) {
      const reduction =
        ((payload.input_size_bytes - payload.output_size_bytes) / payload.input_size_bytes) * 100;
      const comparison =
        reduction >= 0
          ? `${Math.abs(reduction).toFixed(1)}% smaller`
          : `${Math.abs(reduction).toFixed(1)}% larger`;
      return `Compressed to ${formatSizeMb(payload.output_size_bytes)} — ${comparison}.`;
    }
    return `Compressed to ${formatSizeMb(payload.output_size_bytes)}.`;
  }
  if (
    !payload.success &&
    typeof payload.smallest_output_size_bytes === "number" &&
    typeof payload.target_size_bytes === "number"
  ) {
    return `Smallest result was ${formatSizeMb(
      payload.smallest_output_size_bytes
    )}, above target ${formatSizeMb(payload.target_size_bytes)}.`;
  }
  return payload.message;
}

export function formatBatchProgress(payload: BatchProgressPayload): string {
  const active = payload.active_count > 0 ? ` · ${payload.active_count} active` : "";
  return `${payload.status} · ${payload.completed_count}/${payload.total_count} complete${active} · ETA: ${payload.eta}`;
}

export function calculateBitrate(
  sizeMb: number,
  durationSec: number,
  removeAudio: boolean,
  audioTrackCount = 1
): number {
  const totalKbits = sizeMb * 1024 * 8;
  const audioKbits = removeAudio ? 0 : AUDIO_TRACK_BITRATE_KBPS * audioTrackCount * durationSec;
  const videoBitrate = (totalKbits - audioKbits) / durationSec;
  // Send the full budget: the backend owns the single size safety factor
  // (SIZE_TARGET_SAFETY) and applies it to measured encode results.
  return Math.max(100, Math.floor(videoBitrate));
}

export function resolveVideoBitrate(
  sizeMb: number | null,
  durationSec: number,
  removeAudio: boolean,
  sourceBitrateKbps: number,
  audioTrackCount = 1
): number | null {
  if (sizeMb === null) {
    if (!Number.isFinite(sourceBitrateKbps) || sourceBitrateKbps <= 0) return null;
    return Math.max(100, Math.floor(sourceBitrateKbps));
  }

  const targetBitrate = calculateBitrate(sizeMb, durationSec, removeAudio, audioTrackCount);
  if (!Number.isFinite(sourceBitrateKbps) || sourceBitrateKbps <= 0) return targetBitrate;
  return Math.min(targetBitrate, Math.floor(sourceBitrateKbps));
}

export function resolveSourceBitrateCeiling(sourceBitrateKbps: number): number | null {
  if (!Number.isFinite(sourceBitrateKbps) || sourceBitrateKbps <= 0) return null;
  return Math.max(100, Math.floor(sourceBitrateKbps));
}

export function resolutionToShortSide(choice: string): number | null {
  const map: Record<string, number> = {
    "4k": 2160,
    "2160p": 2160,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
  };
  return map[choice.toLowerCase()] ?? null;
}

export function computeTargetDimensions(
  ow: number,
  oh: number,
  targetH: number | null,
  targetShort: number | null
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
    const th = targetH;
    let tw = Math.ceil((ow / oh) * th);
    if (tw % 2 !== 0) tw++;
    return [tw, th];
  }
  return null;
}
