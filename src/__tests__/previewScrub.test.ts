import { describe, expect, it } from "vitest";
import { shouldFetchScrubFrame } from "../previewScrub";

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
