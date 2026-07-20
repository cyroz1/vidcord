export const TIMELINE_ZOOM_MAX = 100;

export function getSelectionCenter(start: number, end: number, timelineMax: number): number {
  const clampedStart = Math.max(0, Math.min(start, timelineMax));
  const clampedEnd = Math.max(0, Math.min(end, timelineMax));
  return (clampedStart + clampedEnd) / 2;
}

export function getTimelineViewBounds(
  center: number,
  zoom: number,
  timelineMax: number,
  minimumSpan: number
): { start: number; end: number } {
  const span = Math.max(minimumSpan, timelineMax / Math.max(1, zoom));
  const start = Math.max(0, Math.min(center - span / 2, timelineMax - span));
  return { start, end: start + span };
}

export function formatTimelineTime(timeSec: number, clockFormat: boolean): string {
  const safeTime = Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0;
  if (!clockFormat) return `${safeTime.toFixed(1)}s`;

  const totalTenths = Math.round(safeTime * 10);
  const hours = Math.floor(totalTenths / 36_000);
  const minutes = Math.floor(totalTenths / 600) % 60;
  const seconds = Math.floor(totalTenths / 10) % 60;
  const tenths = totalTenths % 10;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}.${tenths}`;
}

export function parseTimelineTimeInput(value: string): number | null {
  const normalized = value.trim().toLowerCase().replace(/s$/, "").trim();
  if (!normalized) return null;

  const parts = normalized.split(":");
  if (parts.length === 1) {
    const seconds = Number(parts[0]);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (parts.some((part) => !part.trim())) return null;

  const numericParts = parts.map(Number);
  if (numericParts.some((part) => !Number.isFinite(part) || part < 0)) return null;

  const seconds = numericParts[numericParts.length - 1];
  const minutes = numericParts[numericParts.length - 2];
  if (seconds >= 60 || minutes >= 60) return null;

  const hours = numericParts.length === 3 ? numericParts[0] : 0;
  return hours * 3600 + minutes * 60 + seconds;
}

export function timeToTimelineValue(
  timeSec: number,
  durationSec: number,
  timelineMax: number
): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || timelineMax <= 0) return 0;
  const safeTime = Number.isFinite(timeSec) ? Math.max(0, Math.min(timeSec, durationSec)) : 0;
  return Math.round((safeTime / durationSec) * timelineMax);
}
