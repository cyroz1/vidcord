import { describe, expect, it } from "vitest";
import {
  buildAudioPeakAnalysisArgs,
  buildCompressionArgs,
  buildGifArgs,
  buildLosslessArgs,
  createExportPlan,
  getAvailableFpsOptions,
  getRetryBitrate,
  outputFileName,
  parsePeakNormalizationGain,
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
  sourceBitrateKbps: 4_000,
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
    expect(targetBitrateKbps(20, 30, false)).toBe(4800);
    expect(targetBitrateKbps(20, 30, true)).toBeGreaterThan(targetBitrateKbps(20, 30, false));
    expect(targetBitrateKbps(20, 30, false, 1, 3_200)).toBe(3_200);
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
    expect(standard).toContain("2.000");
    expect(standard).toContain("-maxrate");
    expect(standard).toContain("3000k");
    expect(standard.some((argument) => argument.includes("crop="))).toBe(true);
    expect(standard.some((argument) => argument.includes("fps=30"))).toBe(true);
    expect(gif.some((argument) => argument.includes("palettegen"))).toBe(true);
    expect(gif).toContain("-filter_complex");
    expect(gif).toContain("[gif]");
    expect(gif).toContain("-an");
    expect(lossless).toContain("copy");
    expect(lossless).not.toContain("-vf");
  });

  it("keeps source-quality advanced exports at the source bitrate", () => {
    const advanced = normalizeBrowserSettings({ mode: "advanced", advancedTargetSize: "" });
    expect(createExportPlan(metadata, advanced, "advanced", 0, 20).bitrateKbps).toBe(4_000);
  });

  it("matches desktop FPS filtering and peak-normalization analysis", () => {
    expect(getAvailableFpsOptions(30).map((option) => option.value)).toEqual(["off", "24"]);
    expect(
      parsePeakNormalizationGain(
        "[volumedetect] max_volume: -12.5 dB\n[volumedetect] max_volume: -2.0 dB"
      )
    ).toBe(2);
    expect(parsePeakNormalizationGain("[volumedetect] max_volume: -inf dB")).toBe(0);

    const plan = createExportPlan(
      metadata,
      { ...settings, audioNormalize: true },
      "compress",
      2,
      20
    );
    const analysis = buildAudioPeakAnalysisArgs("input.mp4", plan);
    const normalized = buildCompressionArgs(
      "input.mp4",
      "output.mp4",
      metadata,
      { ...settings, audioNormalize: true },
      plan,
      3_000,
      2
    );
    expect(analysis).toContain("volumedetect");
    expect(normalized).toContain("volume=2.000000dB");
  });

  it("corrects oversized target encodes and sanitizes browser downloads", () => {
    expect(getRetryBitrate(4000, 30 * 1024 * 1024, 20)).toBe(2400);
    expect(outputFileName("my capture (final).mov", "mp4", 0)).toBe(
      "my capture - final-vidcord.mp4"
    );
    expect(outputFileName("capture.mp4", "mp4", 2)).toBe("capture-vidcord-3.mp4");
  });

  it("accepts bounded custom advanced FPS values and rejects unsafe settings", () => {
    const normalized = normalizeBrowserSettings({
      resolution: "4k",
      fps: "120.5",
      crop: "javascript:",
      gifFps: 12,
    });

    expect(normalized.resolution).toBe("Native");
    expect(normalized.fps).toBe("120.5");
    expect(normalized.crop).toBe("off");
    expect(normalized.gifFps).toBe(15);

    expect(normalizeBrowserSettings({ fps: "240.01" }).fps).toBe("off");
    expect(normalizeBrowserSettings({ fps: "javascript:" }).fps).toBe("off");
  });
});
