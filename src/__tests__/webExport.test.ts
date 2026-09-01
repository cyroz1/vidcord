import { describe, expect, it } from "vitest";
import {
  buildAudioPeakAnalysisArgs,
  buildCompressionArgs,
  buildGifArgs,
  buildLosslessArgs,
  createExportPlan,
  buildVideoFilter,
  getAvailableFpsOptions,
  getRetryBitrate,
  outputFileName,
  parsePeakNormalizationGain,
  targetBitrateKbps,
  GIF_PRESETS,
} from "../web/exportPlan";
import { formatBrowserEta } from "../web/browserProgress";
import { exportBrowserFile } from "../web/webExporter";
import { isAudioCompatibilityError } from "../web/webExporter";
import type { BrowserFfmpegEngine } from "../web/ffmpegEngine";
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
  it("formats an ETA from observed browser export progress", () => {
    expect(formatBrowserEta(0, 2_000)).toBe("ETA: estimating…");
    expect(formatBrowserEta(50, 10_000)).toBe("ETA: 0:10");
    expect(formatBrowserEta(100, 10_000)).toBe("Complete");
  });

  it("calculates a target-aware bitrate with an audio allowance", () => {
    expect(targetBitrateKbps(20, 30, false)).toBe(4800);
    expect(targetBitrateKbps(20, 30, true)).toBeGreaterThan(targetBitrateKbps(20, 30, false));
    expect(targetBitrateKbps(20, 30, false, 2)).toBe(4684);
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
    const losslessWithoutAudio = buildLosslessArgs("input.mp4", "output.mp4", 2, 20, true);

    expect(standard).toContain("libx264");
    expect(standard).toContain("2.000");
    expect(standard.indexOf("-t")).toBeLessThan(standard.indexOf("-i"));
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
    expect(lossless).not.toContain("-an");
    expect(losslessWithoutAudio).toContain("-an");
  });

  it("uses the shared 5, 10, and 20 MB GIF targets", () => {
    expect(GIF_PRESETS.map((preset) => preset.sizeMb)).toEqual([5, 10, 20]);

    const plan = createExportPlan(
      metadata,
      normalizeBrowserSettings({ gifTargetMb: 20 }),
      "gif",
      0,
      20
    );

    expect(plan.targetSizeMb).toBe(20);
    expect(plan.targetHeight).toBe(720);
  });

  it("keeps source-quality advanced exports at the source bitrate", () => {
    const advanced = normalizeBrowserSettings({ mode: "advanced", advancedTargetSize: "" });
    const plan = createExportPlan(metadata, advanced, "advanced", 0, 20);
    const args = buildCompressionArgs("input.mp4", "output.mp4", metadata, advanced, plan, 4_000);

    expect(plan.bitrateKbps).toBe(4_000);
    expect(args).toContain("-b:v");
    expect(args).not.toContain("-maxrate");
    expect(args).not.toContain("-bufsize");
  });

  it("matches desktop FPS filtering and peak-normalization analysis", () => {
    expect(getAvailableFpsOptions(30).map((option) => option.value)).toEqual(["off", "24"]);
    expect(getAvailableFpsOptions(null).map((option) => option.value)).toEqual(["off"]);
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
    expect(analysis.indexOf("-t")).toBeLessThan(analysis.indexOf("-i"));
    expect(normalized).toContain("volume=2.000000dB");
  });

  it("uses literal encoded heights for portrait sources and keeps unknown FPS unchanged", () => {
    const portrait = { ...metadata, width: 1080, height: 1920 };
    const advanced = normalizeBrowserSettings({
      mode: "advanced",
      resolution: "720p",
      fps: "60",
    });
    const portraitFilter = buildVideoFilter(portrait, advanced, 720, "advanced");
    const unknownFpsFilter = buildVideoFilter(
      { ...metadata, frameRate: null },
      advanced,
      720,
      "advanced"
    );

    expect(portraitFilter).toContain("scale=-2:720");
    expect(portraitFilter).not.toContain("scale=720:-2");
    expect(unknownFpsFilter).not.toContain("fps=60");
  });

  it("keeps cropped H.264 dimensions even for odd square sources", () => {
    const oddSource = { ...metadata, width: 1081, height: 721 };
    const settingsWithSquareCrop = normalizeBrowserSettings({ crop: "1:1" });
    const filter = buildVideoFilter(oddSource, settingsWithSquareCrop, null, "compress");

    expect(filter).toContain("crop=trunc(min(iw\\,ih)/2)*2:trunc(min(iw\\,ih)/2)*2");
    expect(filter).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  });

  it("matches the native GIF quality tradeoff across FPS and retries", () => {
    const gifSettings = normalizeBrowserSettings({ mode: "gif", gifTargetMb: 20, gifFps: 15 });
    const gifPlan = createExportPlan(metadata, gifSettings, "gif", 0, 20);
    const standardFilter = buildGifArgs(
      "input.mp4",
      "output.gif",
      metadata,
      gifSettings,
      gifPlan,
      gifPlan.targetHeight ?? 480
    ).find((argument) => argument.includes("palettegen"));
    const highFpsFilter = buildGifArgs(
      "input.mp4",
      "output.gif",
      metadata,
      { ...gifSettings, gifFps: 50 },
      gifPlan,
      gifPlan.targetHeight ?? 480
    ).find((argument) => argument.includes("palettegen"));
    const retryFilter = buildGifArgs(
      "input.mp4",
      "output.gif",
      metadata,
      gifSettings,
      gifPlan,
      gifPlan.targetHeight ?? 480,
      Math.floor((gifPlan.bitrateKbps ?? 1) * 0.25)
    ).find((argument) => argument.includes("palettegen"));

    expect(standardFilter).toContain("max_colors=256");
    expect(highFpsFilter).toContain("fps=50");
    expect(highFpsFilter).toContain("max_colors=256");
    expect(retryFilter).toContain("max_colors=128");
    expect(retryFilter).toContain("scale=640:360");
  });

  it("retries an export without audio normalization when its filter fails", async () => {
    const encodedArgs: string[][] = [];
    let transcodeCount = 0;
    const engine = {
      run: async () => "[volumedetect] max_volume: -6.0 dB",
      transcode: async (
        _file: File,
        argsForInput: (inputName: string) => string[],
        _outputName: string
      ) => {
        encodedArgs.push(argsForInput("input.mp4"));
        transcodeCount += 1;
        if (transcodeCount === 1) throw new Error("audio filter failed");
        return new Uint8Array(16_000);
      },
    } as unknown as BrowserFfmpegEngine;

    const normalized = normalizeBrowserSettings({
      mode: "advanced",
      advancedTargetSize: "",
      audioNormalize: true,
    });
    const result = await exportBrowserFile({
      engine,
      file: { name: "capture.mp4" } as File,
      metadata,
      settings: normalized,
      mode: "advanced",
      startTime: 2,
      endTime: 20,
    });

    expect(transcodeCount).toBe(2);
    expect(encodedArgs[0]).toContain("volume=6.000000dB");
    expect(encodedArgs[1]).not.toContain("-af");
    expect(result.normalizationSkipped).toBe(true);
    expect(result.audioRemovedForCompatibility).toBe(false);
  });

  it("falls back to a video-only export when the source audio path fails", async () => {
    const encodedArgs: string[][] = [];
    let transcodeCount = 0;
    const engine = {
      run: async () => "[volumedetect] max_volume: -6.0 dB",
      transcode: async (
        _file: File,
        argsForInput: (inputName: string) => string[],
        _outputName: string
      ) => {
        encodedArgs.push(argsForInput("input.mp4"));
        transcodeCount += 1;
        if (transcodeCount < 3) throw new Error("audio stream failed");
        return new Uint8Array(16_000);
      },
    } as unknown as BrowserFfmpegEngine;

    const result = await exportBrowserFile({
      engine,
      file: { name: "capture.mp4" } as File,
      metadata,
      settings: normalizeBrowserSettings({
        mode: "advanced",
        advancedTargetSize: "",
        audioNormalize: true,
      }),
      mode: "advanced",
      startTime: 2,
      endTime: 20,
    });

    expect(transcodeCount).toBe(3);
    expect(encodedArgs[2]).toContain("-an");
    expect(encodedArgs[2]).not.toContain("0:a:0?");
    expect(result.audioRemovedForCompatibility).toBe(true);
  });

  it("does not change the requested media shape after an unrelated encode failure", async () => {
    let transcodeCount = 0;
    const engine = {
      run: async () => "[volumedetect] max_volume: -6.0 dB",
      transcode: async () => {
        transcodeCount += 1;
        throw new Error("filter graph failed while allocating frames");
      },
    } as unknown as BrowserFfmpegEngine;

    await expect(
      exportBrowserFile({
        engine,
        file: { name: "capture.mp4" } as File,
        metadata,
        settings: normalizeBrowserSettings({ mode: "advanced", audioNormalize: true }),
        mode: "advanced",
        startTime: 0,
        endTime: 20,
      })
    ).rejects.toThrow("filter graph failed");
    expect(transcodeCount).toBe(1);
    expect(isAudioCompatibilityError("filter graph failed while allocating frames")).toBe(false);
    expect(isAudioCompatibilityError("audio filter failed")).toBe(true);
  });

  it("gives browser GIF exports the same four bounded adaptive attempts", async () => {
    const filters: string[] = [];
    let transcodeCount = 0;
    const engine = {
      transcode: async (
        _file: File,
        argsForInput: (inputName: string) => string[],
        _outputName: string
      ) => {
        const args = argsForInput("input.mp4");
        filters.push(args[args.indexOf("-filter_complex") + 1] ?? "");
        transcodeCount += 1;
        return new Uint8Array(5 * 1024 * 1024 + 1);
      },
    } as unknown as BrowserFfmpegEngine;

    const settings = normalizeBrowserSettings({ mode: "gif", gifTargetMb: 5 });
    const result = await exportBrowserFile({
      engine,
      file: { name: "capture.mp4" } as File,
      metadata,
      settings,
      mode: "gif",
      startTime: 0,
      endTime: 20,
    });

    expect(transcodeCount).toBe(4);
    expect(new Set(filters).size).toBeGreaterThan(1);
    expect(result.wasOversized).toBe(true);
  });

  it("corrects oversized target encodes and sanitizes browser downloads", () => {
    expect(getRetryBitrate(4000, 30 * 1024 * 1024, 20)).toBe(2400);
    expect(outputFileName("my capture (final).mov", "mp4", 0)).toBe(
      "my capture - final-vidcord.mp4"
    );
    expect(outputFileName("capture.mp4", "mp4", 2)).toBe("capture-vidcord-3.mp4");
  });

  it("maps FFmpeg progress across every adaptive browser encode pass", async () => {
    const progress: number[] = [];
    let transcodeCount = 0;
    const engine = {
      transcode: async (
        _file: File,
        _argsForInput: (inputName: string) => string[],
        _outputName: string,
        onProgress?: (event: { progress: number; time: number }) => void
      ) => {
        transcodeCount += 1;
        onProgress?.({ progress: 0.5, time: 15_000_000 });
        return new Uint8Array(200_000);
      },
    } as unknown as BrowserFfmpegEngine;

    const advanced = normalizeBrowserSettings({
      mode: "advanced",
      advancedTargetSize: "0.1",
    });
    const result = await exportBrowserFile({
      engine,
      file: { name: "capture.mp4" } as File,
      metadata,
      settings: advanced,
      mode: "advanced",
      startTime: 0,
      endTime: 30,
      onProgress: (value) => progress.push(value),
    });

    expect(transcodeCount).toBe(3);
    expect(progress.some((value) => value > 0 && value < 1)).toBe(true);
    expect(progress[progress.length - 1]).toBe(1);
    expect(result.wasOversized).toBe(true);
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
    expect(normalized.gifTargetMb).toBe(5);
    expect(normalizeBrowserSettings({ gifQualityIndex: 0 }).gifTargetMb).toBe(20);
    expect(normalizeBrowserSettings({ gifQualityIndex: 1 }).gifTargetMb).toBe(20);
    expect(normalizeBrowserSettings({ gifQualityIndex: 2 }).gifTargetMb).toBe(5);
    expect(normalizeBrowserSettings({ gifQualityIndex: 3 }).gifTargetMb).toBe(5);

    expect(normalizeBrowserSettings({ fps: "240.01" }).fps).toBe("off");
    expect(normalizeBrowserSettings({ fps: "javascript:" }).fps).toBe("off");
  });
});
