import { describe, expect, it } from "vitest";
import {
  canPreserveDirectVideoSource,
  getCompletedPlaybackTime,
  getStoppedPlaybackTime,
} from "../previewScrub";

describe("canPreserveDirectVideoSource", () => {
  it("reuses a ready matching HTML video source across play and stop", () => {
    expect(canPreserveDirectVideoSource(true, true)).toBe(true);
  });

  it("does not preserve an unready or different source", () => {
    expect(canPreserveDirectVideoSource(false, true)).toBe(false);
    expect(canPreserveDirectVideoSource(true, false)).toBe(false);
  });
});

describe("getStoppedPlaybackTime", () => {
  it("preserves a paused position inside the trim", () => {
    expect(getStoppedPlaybackTime(9.2, 4, 12)).toBe(9.2);
  });

  it("clamps invalid or out-of-range playback positions", () => {
    expect(getStoppedPlaybackTime(Number.NaN, 4, 12)).toBe(4);
    expect(getStoppedPlaybackTime(18, 4, 12)).toBe(12);
    expect(getStoppedPlaybackTime(2, 4, 12)).toBe(4);
  });
});

describe("getCompletedPlaybackTime", () => {
  it("commits completed trim playback to the exact out point", () => {
    expect(getCompletedPlaybackTime(11.82, 12, true)).toBe(12);
  });

  it("preserves progress if the media ends before the selected trim-out", () => {
    expect(getCompletedPlaybackTime(11.82, 20, false)).toBe(11.82);
  });
});
