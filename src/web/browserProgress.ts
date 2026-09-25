import { formatClock } from "./webMedia";

const MINIMUM_ETA_SAMPLE_MS = 750;
const MICROSECONDS_PER_SECOND = 1_000_000;

export function clampBrowserProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
}

/**
 * Progress within the current operation segment (for example one encode pass),
 * as a 0-1 fraction. Falls back to the overall value when the segment is
 * missing or degenerate.
 */
export function progressInSegment(value: number, start: number, end: number): number {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start
  ) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  }
  return Math.max(0, Math.min(1, (value - start) / (end - start)));
}

export function progressFromMediaTime(
  mediaTimeUs: number,
  durationSeconds: number,
  fallbackProgress: number
): number {
  const safeFallback = Number.isFinite(fallbackProgress)
    ? Math.max(0, Math.min(1, fallbackProgress))
    : 0;
  if (
    !Number.isFinite(mediaTimeUs) ||
    mediaTimeUs < 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return safeFallback;
  }

  const progress = mediaTimeUs / (durationSeconds * MICROSECONDS_PER_SECOND);
  return Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : safeFallback;
}

export function formatBrowserEta(progress: number, elapsedMs: number): string {  const safeProgress = clampBrowserProgress(progress);
  if (safeProgress >= 100) return "Complete";
  if (safeProgress <= 0 || !Number.isFinite(elapsedMs) || elapsedMs < MINIMUM_ETA_SAMPLE_MS) {
    return "ETA: estimating…";
  }

  const remainingSeconds = (elapsedMs / 1000) * ((100 - safeProgress) / safeProgress);
  if (!Number.isFinite(remainingSeconds) || remainingSeconds < 0) return "ETA: estimating…";
  return `ETA: ${formatClock(remainingSeconds)}`;
}
