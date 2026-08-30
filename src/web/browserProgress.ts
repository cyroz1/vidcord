import { formatClock } from "./webMedia";

const MINIMUM_ETA_SAMPLE_MS = 750;

export function clampBrowserProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
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
