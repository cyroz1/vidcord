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
