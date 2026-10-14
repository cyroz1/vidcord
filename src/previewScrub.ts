export function canPreserveDirectVideoSource(mediaReady: boolean, sourceMatches: boolean): boolean {
  return mediaReady && sourceMatches;
}

export function getStoppedPlaybackTime(
  currentTime: number,
  startTime: number,
  endTime: number
): number {
  const min = Math.min(startTime, endTime);
  const max = Math.max(startTime, endTime);
  if (!Number.isFinite(currentTime)) return min;
  return Math.max(min, Math.min(currentTime, max));
}

export function getCompletedPlaybackTime(
  currentTime: number,
  endTime: number,
  reachedTrimEnd: boolean
): number {
  return reachedTrimEnd ? endTime : currentTime;
}
