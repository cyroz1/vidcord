import { describe, expect, it } from "vitest";
import {
  canPreserveDirectVideoSource,
  getStoppedPlaybackTime,
  isFilmstripUseful,
  shouldFetchReleasedScrubFrame,
  shouldFetchScrubFrame,
  shouldGenerateFilmstrip,
  shouldShowDirectPreviewVideo,
} from "../previewScrub";

describe("shouldFetchScrubFrame", () => {
  it("uses FFmpeg while dragging when neither live scrubbing nor a filmstrip is ready", () => {
    expect(shouldFetchScrubFrame(true, false, true, false)).toBe(true);
  });

  it("does not fetch when live scrubbing is ready", () => {
    expect(shouldFetchScrubFrame(true, false, true, true)).toBe(false);
  });

  it("does not fetch when filmstrip frames can update immediately", () => {
    expect(shouldFetchScrubFrame(true, true, false, false)).toBe(false);
  });

  it("does not fetch outside an active drag", () => {
    expect(shouldFetchScrubFrame(false, false, false, false)).toBe(false);
  });
});

describe("shouldFetchReleasedScrubFrame", () => {
  it("fetches the exact paused frame immediately when a drag ends", () => {
    expect(shouldFetchReleasedScrubFrame(true, false, true)).toBe(true);
  });

  it("keeps normal non-drag preview updates debounced", () => {
    expect(shouldFetchReleasedScrubFrame(false, false, true)).toBe(false);
  });

  it("does not fetch while the drag is still active", () => {
    expect(shouldFetchReleasedScrubFrame(true, true, true)).toBe(false);
  });

  it("requires an explicit final preview position", () => {
    expect(shouldFetchReleasedScrubFrame(true, false, false)).toBe(false);
  });
});

describe("shouldShowDirectPreviewVideo", () => {
  it("shows a ready direct source as soon as probing completes", () => {
    expect(shouldShowDirectPreviewVideo(true, true, true, false)).toBe(true);
  });

  it("keeps the direct video frame visible after scrubbing settles", () => {
    expect(shouldShowDirectPreviewVideo(true, true, true, false)).toBe(true);
  });

  it("falls back to generated frames when direct preview is unavailable", () => {
    expect(shouldShowDirectPreviewVideo(false, true, true, false)).toBe(false);
    expect(shouldShowDirectPreviewVideo(true, true, false, false)).toBe(false);
  });

  it("lets active playback control video visibility", () => {
    expect(shouldShowDirectPreviewVideo(true, true, true, true)).toBe(false);
  });

  it("does not show the video until probing validates the selected file", () => {
    expect(shouldShowDirectPreviewVideo(true, false, true, false)).toBe(false);
  });
});

describe("shouldGenerateFilmstrip", () => {
  it("waits for the first exact preview before starting background work", () => {
    expect(shouldGenerateFilmstrip(true, false, false)).toBe(false);
  });

  it("uses filmstrips for Linux and failed direct previews", () => {
    expect(shouldGenerateFilmstrip(true, false, true)).toBe(true);
    expect(shouldGenerateFilmstrip(false, true, true)).toBe(true);
  });

  it("skips redundant filmstrips when direct preview is available", () => {
    expect(shouldGenerateFilmstrip(false, false, true)).toBe(false);
  });
});

describe("isFilmstripUseful", () => {
  it("accepts a representative keyframe strip", () => {
    expect(isFilmstripUseful(25, 27)).toBe(true);
  });

  it("keeps exact-frame fetching enabled for unusually sparse strips", () => {
    expect(isFilmstripUseful(3, 27)).toBe(false);
  });

  it("allows small strips for very short videos", () => {
    expect(isFilmstripUseful(2, 3)).toBe(true);
  });
});

describe("canPreserveDirectVideoSource", () => {
  it("reuses a ready matching direct source across play and stop", () => {
    expect(canPreserveDirectVideoSource(true, true, false, true)).toBe(true);
  });

  it("does not preserve generated clips or a different source", () => {
    expect(canPreserveDirectVideoSource(true, true, true, true)).toBe(false);
    expect(canPreserveDirectVideoSource(true, true, false, false)).toBe(false);
  });

  it("requires direct preview support and loaded media", () => {
    expect(canPreserveDirectVideoSource(false, true, false, true)).toBe(false);
    expect(canPreserveDirectVideoSource(true, false, false, true)).toBe(false);
  });
});

describe("getStoppedPlaybackTime", () => {
  it("preserves a paused or failed playback position inside the trim", () => {
    expect(getStoppedPlaybackTime(9.2, 4, 12)).toBe(9.2);
  });

  it("clamps invalid or out-of-range playback positions", () => {
    expect(getStoppedPlaybackTime(Number.NaN, 4, 12)).toBe(4);
    expect(getStoppedPlaybackTime(18, 4, 12)).toBe(12);
    expect(getStoppedPlaybackTime(2, 4, 12)).toBe(4);
  });
});
