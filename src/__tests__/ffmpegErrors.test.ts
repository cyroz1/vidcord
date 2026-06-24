import { describe, expect, it } from "vitest";
import { isFfmpegMissingError } from "../ffmpegErrors";

describe("isFfmpegMissingError", () => {
  it("recognizes backend missing-ffmpeg markers", () => {
    expect(
      isFfmpegMissingError(
        "FFMPEG_MISSING: FFmpeg was not found on PATH. Install FFmpeg and restart vidcord."
      )
    ).toBe(true);
  });

  it("recognizes Windows command spawn wording", () => {
    expect(isFfmpegMissingError("program not found")).toBe(true);
  });

  it("ignores ordinary probe failures", () => {
    expect(isFfmpegMissingError("ffprobe failed: invalid data found when processing input")).toBe(
      false
    );
  });
});
