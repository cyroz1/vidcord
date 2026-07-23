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

export function canPreserveDirectVideoSource(
  supportsLiveScrubPreview: boolean,
  mediaReady: boolean,
  usingGeneratedClip: boolean,
  sourceMatches: boolean
): boolean {
  return supportsLiveScrubPreview && mediaReady && !usingGeneratedClip && sourceMatches;
}
