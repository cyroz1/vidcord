import type { ProbeData } from "./ipc";
import {
  formatAverageBitrate,
  formatCodec,
  formatFrameRate,
  formatVideoDuration,
} from "./videoMetadata";

export const MIN_BATCH_CLIP_SECONDS = 1;

export type BatchItemStatus =
  | "queued"
  | "probing"
  | "encoding"
  | "completed"
  | "failed"
  | "cancelled";

export type BatchQueueItem = {
  id: number;
  inputPath: string;
  status: BatchItemStatus;
  progress: number;
  details?: string;
  message?: string;
  outputPath?: string;
};

export type BatchTrimRange = {
  start: number;
  end: number;
};

export function normalizeVideoPaths(
  paths: readonly string[],
  supportedExtension: RegExp
): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawPath of paths) {
    if (typeof rawPath !== "string") continue;
    const path = rawPath.trim();
    if (!path || !supportedExtension.test(path)) continue;
    const key = path.replaceAll("/", "\\").toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(path);
  }

  return normalized;
}

export function normalizeBatchTrimRange(
  duration: number,
  requestedStart: number,
  requestedEnd: number
): BatchTrimRange {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const start = Number.isFinite(requestedStart) && requestedStart > 0 ? requestedStart : 0;
  const end = Number.isFinite(requestedEnd) && requestedEnd > 0 ? requestedEnd : 0;
  const availableTrim = Math.max(0, safeDuration - MIN_BATCH_CLIP_SECONDS);
  const requestedTotal = start + end;

  if (requestedTotal <= availableTrim || requestedTotal <= 0) {
    return {
      start: Math.min(start, availableTrim),
      end: Math.min(end, availableTrim - Math.min(start, availableTrim)),
    };
  }

  if (availableTrim <= 0) return { start: 0, end: 0 };
  const scale = availableTrim / requestedTotal;
  return { start: start * scale, end: end * scale };
}

export function batchClipDuration(duration: number, trim: BatchTrimRange): number {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return Math.max(0, safeDuration - trim.start - trim.end);
}

export function formatBatchVideoDetails(probe: ProbeData): string {
  const resolution = `${probe.width}×${probe.height}`;
  const frameRate = formatFrameRate(probe.frame_rate);
  const codec = formatCodec(probe.codec);
  const bitrate = formatAverageBitrate(probe.bitrate);
  const length = formatVideoDuration(probe.duration);
  return `${resolution} · ${frameRate} · ${codec} · ${bitrate} · ${length}`;
}

export function batchOutputSummary(items: readonly BatchQueueItem[]): {
  completed: number;
  failed: number;
  cancelled: number;
  pending: number;
} {
  return items.reduce(
    (summary, item) => {
      if (item.status === "completed") summary.completed += 1;
      else if (item.status === "failed") summary.failed += 1;
      else if (item.status === "cancelled") summary.cancelled += 1;
      else summary.pending += 1;
      return summary;
    },
    { completed: 0, failed: 0, cancelled: 0, pending: 0 }
  );
}

export function batchProgressFromItems(items: readonly BatchQueueItem[]): number {
  if (items.length === 0) return 0;
  return Math.round(
    items.reduce((total, item) => {
      if (item.status === "completed" || item.status === "failed" || item.status === "cancelled") {
        return total + 100;
      }
      return total + Math.max(0, Math.min(100, item.progress));
    }, 0) / items.length
  );
}

export function groupOutputPathsByFolder(paths: readonly string[]): string[] {
  const folders = new Map<string, string>();
  for (const outputPath of paths) {
    const folder = outputPath.replace(/[\\/][^\\/]*$/, "");
    if (!folders.has(folder)) folders.set(folder, outputPath);
  }
  return [...folders.values()];
}

export function sourceFrameRateForBatch(probe: ProbeData): number | null {
  return typeof probe.frame_rate === "number" &&
    Number.isFinite(probe.frame_rate) &&
    probe.frame_rate > 0
    ? probe.frame_rate
    : null;
}
