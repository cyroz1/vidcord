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
  if (!Number.isFinite(value) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  }
  return Math.max(0, Math.min(1, (value - start) / (end - start)));
}

export function progressFromMediaTime(
  mediaTimeUs: number,
  durationSeconds: number,
  fallbackProgress: number,
  fullDurationSeconds?: number
): number {
  const safeFallback = Number.isFinite(fallbackProgress)
    ? Math.max(0, Math.min(1, fallbackProgress))
    : 0;

  const hasMediaTime = Number.isFinite(mediaTimeUs) && mediaTimeUs >= 0;
  const hasDuration = Number.isFinite(durationSeconds) && durationSeconds > 0;
  let timeProgress = safeFallback;
  if (hasMediaTime && hasDuration) {
    const p = mediaTimeUs / (durationSeconds * MICROSECONDS_PER_SECOND);
    if (Number.isFinite(p)) timeProgress = Math.max(0, Math.min(1, p));
  }

  // FFmpeg's own progress ratio, rescaled from the full input to the selected
  // range. It is self-consistent (media time / FFmpeg's input duration), so
  // it does not jump when the browser's duration disagrees with FFmpeg's
  // timestamps. Use it as a guard: never report 100% from the time-based
  // ratio while FFmpeg's own ratio says the encode is still in flight.
  if (
    timeProgress >= 1 &&
    Number.isFinite(fullDurationSeconds) &&
    (fullDurationSeconds as number) > 0 &&
    hasDuration
  ) {
    const rescaled = safeFallback * ((fullDurationSeconds as number) / durationSeconds);
    if (Number.isFinite(rescaled) && rescaled >= 0 && rescaled < 0.99) {
      return Math.max(0, Math.min(1, rescaled));
    }
  }

  return timeProgress;
}

export function formatBrowserEta(progress: number, elapsedMs: number): string {
  const safeProgress = clampBrowserProgress(progress);
  if (safeProgress >= 100) return "Complete";
  if (safeProgress <= 0 || !Number.isFinite(elapsedMs) || elapsedMs < MINIMUM_ETA_SAMPLE_MS) {
    return "ETA: estimating…";
  }

  const remainingSeconds = (elapsedMs / 1000) * ((100 - safeProgress) / safeProgress);
  if (!Number.isFinite(remainingSeconds) || remainingSeconds < 0) return "ETA: estimating…";
  return `ETA: ${formatClock(remainingSeconds)}`;
}

/**
 * ETA text for the per-pass progress bar. The bar tracks the current pass, so
 * a pass reaching 100% must not read as "Complete" while later passes (or
 * later files in a batch) are still pending.
 */
export function formatPassEta(args: {
  passPercent: number;
  fileProgress: number;
  isLastFile: boolean;
  elapsedMs: number;
}): string {
  const fileDone = Number.isFinite(args.fileProgress) && args.fileProgress >= 1;
  if (fileDone && args.isLastFile) return "Complete";
  if (fileDone || args.passPercent >= 100) return "Continuing…";
  return formatBrowserEta(args.passPercent, args.elapsedMs);
}
