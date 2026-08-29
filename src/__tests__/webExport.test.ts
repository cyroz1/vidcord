import { describe, expect, it } from "vitest";
import {
  buildCompressionArgs,
  buildGifArgs,
  buildLosslessArgs,
  createExportPlan,
  getRetryBitrate,
  outputFileName,
  targetBitrateKbps,
} from "../web/exportPlan";
import { normalizeBrowserSettings } from "../web/webSettings";
import type { BrowserVideoMetadata } from "../web/webMedia";

const metadata: BrowserVideoMetadata = {
  name: "capture.mp4",
  sizeBytes: 42_000_000,
  duration: 30,
  width: 1920,
  height: 1080,
  frameRate: 60,
  bitrateKbps: 0,
  codec: "H264",
  hasAudio: true,
};

const settings = normalizeBrowserSettings({
  mode: "compress",
  qualityIndex: 0,
  crop: "16:9",
  fps: "30",
});

describe("browser export planning", () => {
  it("calculates a target-aware bitrate with an audio allowance", () => {
    expect(targetBitrateKbps(20, 30, false)).toBe(4693);
    expect(targetBitrateKbps(20, 30, true)).toBeGreaterThan(targetBitrateKbps(20, 30, false));
  });

  it("builds the standard, GIF, and lossless command shapes", () => {
    const plan = createExportPlan(metadata, settings, "compress", 2, 20);
    const standard = buildCompressionArgs(
      "input.mp4",
      "output.mp4",
      metadata,
      settings,
      plan,
      3000
    );
    const gif = buildGifArgs(
      "input.mp4",
      "output.gif",
      metadata,
      settings,
      createExportPlan(metadata, settings, "gif", 2, 20),
      480
    );
    const lossless = buildLosslessArgs("input.mp4", "output.mp4", 2, 20);

    expect(standard).toContain("libx264");
    expect(standard.some((argument) => argument.includes("crop="))).toBe(true);
    expect(standard.some((argument) => argument.includes("fps=30"))).toBe(true);
    expect(gif.some((argument) => argument.includes("palettegen"))).toBe(true);
    expect(gif).toContain("-an");
    expect(lossless).toContain("copy");
    expect(lossless).not.toContain("-vf");
  });

  it("corrects oversized target encodes and sanitizes browser downloads", () => {
    expect(getRetryBitrate(4000, 30 * 1024 * 1024, 20)).toBe(2400);
    expect(outputFileName("my capture (final).mov", "mp4", 0)).toBe(
      "my capture - final-vidcord.mp4"
    );
    expect(outputFileName("capture.mp4", "mp4", 2)).toBe("capture-vidcord-3.mp4");
  });

  it("falls back to allowlisted browser settings", () => {
    const normalized = normalizeBrowserSettings({
      resolution: "4k",
      fps: "120",
      crop: "javascript:",
      gifFps: 12,
    });

    expect(normalized.resolution).toBe("Native");
    expect(normalized.fps).toBe("off");
    expect(normalized.crop).toBe("off");
    expect(normalized.gifFps).toBe(15);
  });
});
