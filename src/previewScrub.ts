export function shouldFetchScrubFrame(
  isScrubbing: boolean,
  hasFilmstripFrames: boolean,
  supportsLiveScrubPreview: boolean,
  scrubVideoReady: boolean
): boolean {
  return isScrubbing && !hasFilmstripFrames && !(supportsLiveScrubPreview && scrubVideoReady);
}

export function shouldFetchReleasedScrubFrame(
  wasScrubbing: boolean,
  isScrubbing: boolean,
  hasExplicitPreviewTime: boolean
): boolean {
  return wasScrubbing && !isScrubbing && hasExplicitPreviewTime;
}

export function shouldShowDirectPreviewVideo(
  supportsLiveScrubPreview: boolean,
  hasProbeData: boolean,
  scrubVideoReady: boolean,
  playing: boolean
): boolean {
  return supportsLiveScrubPreview && hasProbeData && scrubVideoReady && !playing;
}

export function shouldGenerateFilmstrip(
  isLinux: boolean,
  directPreviewFailed: boolean,
  initialPreviewSettled: boolean
): boolean {
  return initialPreviewSettled && (isLinux || directPreviewFailed);
}

export function isFilmstripUseful(frameCount: number, durationSec: number): boolean {
  const minimumFrames = Math.min(8, Math.max(2, Math.floor(durationSec / 2)));
  return frameCount >= minimumFrames;
}

export function getFilmstripFrameBudget(durationSec: number): number {
  return durationSec >= 180 ? 8 : 30;
}

export function canPreserveDirectVideoSource(
  supportsLiveScrubPreview: boolean,
  mediaReady: boolean,
  usingGeneratedClip: boolean,
  sourceMatches: boolean
): boolean {
  return supportsLiveScrubPreview && mediaReady && !usingGeneratedClip && sourceMatches;
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
