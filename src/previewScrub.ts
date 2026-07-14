export function shouldFetchScrubFrame(
  isScrubbing: boolean,
  hasFilmstripFrames: boolean,
  supportsLiveScrubPreview: boolean,
  scrubVideoReady: boolean
): boolean {
  return isScrubbing && !hasFilmstripFrames && !(supportsLiveScrubPreview && scrubVideoReady);
}
