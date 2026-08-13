import { describe, expect, it } from "vitest";
import {
  batchClipDuration,
  batchOutputSummary,
  batchProgressFromItems,
  formatBatchVideoDetails,
  groupOutputPathsByFolder,
  normalizeBatchTrimRange,
  normalizeVideoPaths,
} from "../batchProcessing";
import { normalizePresetSettings } from "../settingsPresets";

const VIDEO_EXTENSION = /\.(mp4|mov|mkv|webm)$/i;

describe("batch processing helpers", () => {
  it("preserves order while filtering and deduplicating selected paths", () => {
    expect(
      normalizeVideoPaths(
        ["C:/clips/one.mp4", "c:\\clips\\ONE.MP4", "C:/clips/two.txt", "C:/clips/two.mov"],
        VIDEO_EXTENSION
      )
    ).toEqual(["C:/clips/one.mp4", "C:/clips/two.mov"]);
  });

  it("keeps independent start and end trims when the duration allows them", () => {
    const trim = normalizeBatchTrimRange(20, 3, 4);
    expect(trim).toEqual({ start: 3, end: 4 });
    expect(batchClipDuration(20, trim)).toBe(13);
  });

  it("formats the same source details shown for a single video", () => {
    expect(
      formatBatchVideoDetails({
        duration: 83.4,
        width: 1920,
        height: 1080,
        frame_rate: 29.97,
        bitrate: 4500,
        codec: "h264",
        audio_tracks: [],
      })
    ).toBe("1920×1080 · 29.97 fps · H.264 · 4.5 Mbps · 1:23.4");
  });

  it("reduces overlapping trims proportionally while preserving a one-second clip", () => {
    const trim = normalizeBatchTrimRange(5, 10, 5);
    expect(trim.start + trim.end).toBeCloseTo(4);
    expect(trim.start / trim.end).toBeCloseTo(2);
    expect(batchClipDuration(5, trim)).toBeCloseTo(1);
  });

  it("normalizes persisted batch trim settings", () => {
    const settings = normalizePresetSettings({
      batch_trim_start_seconds: 2.5,
      batch_trim_end_seconds: -4,
    });
    expect(settings.batch_trim_start_seconds).toBe(2.5);
    expect(settings.batch_trim_end_seconds).toBe(0);
  });

  it("calculates aggregate progress and completion summaries", () => {
    const items = [
      { id: 0, inputPath: "one.mp4", status: "completed" as const, progress: 100 },
      { id: 1, inputPath: "two.mp4", status: "encoding" as const, progress: 40 },
      { id: 2, inputPath: "three.mp4", status: "failed" as const, progress: 100 },
    ];
    expect(batchProgressFromItems(items)).toBe(80);
    expect(batchOutputSummary(items)).toEqual({
      completed: 1,
      failed: 1,
      cancelled: 0,
      pending: 1,
    });
  });

  it("groups completion reveals by distinct output folder", () => {
    expect(
      groupOutputPathsByFolder(["C:/out/one.mp4", "C:/out/two.mp4", "C:/other/three.mp4"])
    ).toEqual(["C:/out/one.mp4", "C:/other/three.mp4"]);
  });
});
