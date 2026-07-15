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

export function canPreserveDirectVideoSource(
  supportsLiveScrubPreview: boolean,
  mediaReady: boolean,
  usingGeneratedClip: boolean,
  sourceMatches: boolean
): boolean {
  return supportsLiveScrubPreview && mediaReady && !usingGeneratedClip && sourceMatches;
}
