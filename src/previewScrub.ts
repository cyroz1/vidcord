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

export function shouldGenerateFilmstrip(isLinux: boolean, initialPreviewSettled: boolean): boolean {
  return initialPreviewSettled && isLinux;
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

export function shouldHoldPausedFrame(
  preserveDirectSource: boolean,
  readyState: number | undefined
): boolean {
  // After stopping, keep the video element on screen when it still holds a
  // valid paused frame: the source was not preserved for scrub preview, but
  // the media already has data (readyState >= HAVE_CURRENT_DATA), so the
  // current frame stays visible instead of jumping back to the start.
  return !preserveDirectSource && (readyState ?? 0) >= 2;
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
