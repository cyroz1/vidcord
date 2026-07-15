import { describe, expect, it } from "vitest";
import {
  canPreserveDirectVideoSource,
  shouldFetchReleasedScrubFrame,
  shouldFetchScrubFrame,
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
