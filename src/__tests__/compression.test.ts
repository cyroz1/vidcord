import { describe, expect, it } from "vitest";
import {
  calculateBitrate,
  computeTargetDimensions,
  formatCompressionDone,
  formatCompressionProgress,
  formatSizeMb,
  resolveVideoBitrate,
  resolutionToShortSide,
} from "../hooks/useCompression";

describe("calculateBitrate", () => {
  it("returns correct bitrate with audio at 100 MB / 60 s", () => {
    // (100 * 1024 * 8 - 128 * 60) / 60 * 0.9 = ~11,827 kbps
    const result = calculateBitrate(100, 60, false);
    expect(result).toBeGreaterThan(11_000);
    expect(result).toBeLessThan(13_000);
  });

  it("returns higher bitrate when audio is removed", () => {
    const withAudio = calculateBitrate(100, 60, false);
    const withoutAudio = calculateBitrate(100, 60, true);
    expect(withoutAudio).toBeGreaterThan(withAudio);
  });

  it("clamps to minimum 100 kbps for tiny size targets", () => {
    expect(calculateBitrate(0.001, 3600, false)).toBe(100);
  });

  it("is proportional to file size", () => {
    const small = calculateBitrate(10, 60, true);
    const large = calculateBitrate(100, 60, true);
    expect(large).toBeCloseTo(small * 10, -2);
  });
});

describe("resolveVideoBitrate", () => {
  it("uses the source bitrate when the target size is empty", () => {
    expect(resolveVideoBitrate(null, 60, false, 8_500)).toBe(8_500);
  });

  it("caps a size-derived bitrate at the source bitrate", () => {
    expect(resolveVideoBitrate(100, 60, false, 4_000)).toBe(4_000);
  });

  it("keeps size-based calculation when source bitrate is unavailable", () => {
    expect(resolveVideoBitrate(10, 60, false, 0)).toBe(calculateBitrate(10, 60, false));
  });

  it("requires a known source bitrate when the target size is empty", () => {
    expect(resolveVideoBitrate(null, 60, false, 0)).toBeNull();
  });
});

describe("compression status formatting", () => {
  it("formats attempt metadata for progress updates", () => {
    expect(
      formatCompressionProgress({
        percent: 42,
        eta: "1m 12s",
        status: "Retrying with CPU encoder at 80% size safety...",
        attempt: 2,
        attempt_total: 10,
        encoder: "libx264",
        video_bitrate_k: 720,
      })
    ).toBe("Attempt 2 · libx264 · 720 kbps · ETA: 1m 12s");
  });

  it("falls back to status text for legacy progress payloads", () => {
    expect(
      formatCompressionProgress({
        percent: 10,
        eta: "Calculating...",
        status: "Compressing...",
      })
    ).toBe("Compressing... ETA: Calculating...");
  });

  it("omits the internal quality budget from GIF progress", () => {
    expect(
      formatCompressionProgress({
        percent: 35,
        eta: "8s",
        status: "Optimizing GIF to fit...",
        attempt: 2,
        attempt_total: 4,
        encoder: "gif",
        video_bitrate_k: 420,
        gif_mode: true,
      })
    ).toBe("Attempt 2 · gif · ETA: 8s");
  });

  it("formats final output size with its reduction from the source", () => {
    expect(
      formatCompressionDone({
        success: true,
        message: "Compression complete!",
        input_size_bytes: 100 * 1024 * 1024,
        output_size_bytes: 23.7 * 1024 * 1024,
        target_size_bytes: 25 * 1024 * 1024,
      })
    ).toBe("Compressed to 23.7 MB — 76.3% smaller.");
  });

  it("does not show the target when source size is unavailable", () => {
    expect(
      formatCompressionDone({
        success: true,
        message: "Compression complete!",
        output_size_bytes: 23.7 * 1024 * 1024,
        target_size_bytes: 25 * 1024 * 1024,
      })
    ).toBe("Compressed to 23.7 MB.");
  });

  it("describes an unexpectedly larger output without a negative reduction", () => {
    expect(
      formatCompressionDone({
        success: true,
        message: "Compression complete!",
        input_size_bytes: 20 * 1024 * 1024,
        output_size_bytes: 25 * 1024 * 1024,
      })
    ).toBe("Compressed to 25.0 MB — 25.0% larger.");
  });

  it("formats the smallest oversized result after target-size failure", () => {
    expect(
      formatCompressionDone({
        success: false,
        message: "Compression failed.",
        smallest_output_size_bytes: 27.4 * 1024 * 1024,
        target_size_bytes: 25 * 1024 * 1024,
      })
    ).toBe("Smallest result was 27.4 MB, above target 25.0 MB.");
  });

  it("formats small and large byte values", () => {
    expect(formatSizeMb(5.25 * 1024 * 1024)).toBe("5.25 MB");
    expect(formatSizeMb(500 * 1024 * 1024)).toBe("500 MB");
  });
});

describe("resolutionToShortSide", () => {
  it.each([
    ["4k", 2160],
    ["2160p", 2160],
    ["1440p", 1440],
    ["1080p", 1080],
    ["720p", 720],
    ["480p", 480],
  ])("maps %s → %i", (input, expected) => {
    expect(resolutionToShortSide(input)).toBe(expected);
  });

  it("is case-insensitive", () => {
    expect(resolutionToShortSide("1080P")).toBe(1080);
  });

  it("returns null for unknown presets", () => {
    expect(resolutionToShortSide("potato")).toBeNull();
  });
});

describe("computeTargetDimensions", () => {
  it("returns null when no target is specified", () => {
    expect(computeTargetDimensions(1920, 1080, null, null)).toBeNull();
  });

  it("returns null when short side target >= current short side", () => {
    expect(computeTargetDimensions(1280, 720, null, 720)).toBeNull();
    expect(computeTargetDimensions(1280, 720, null, 800)).toBeNull();
  });

  it("returns null when height target >= current height", () => {
    expect(computeTargetDimensions(1920, 1080, 1080, null)).toBeNull();
  });

  it("scales landscape video to 720p short side", () => {
    const result = computeTargetDimensions(1920, 1080, null, 720);
    expect(result).not.toBeNull();
    const [w, h] = result!;
    expect(Math.min(w, h)).toBe(720);
    expect(w % 2).toBe(0);
    expect(h % 2).toBe(0);
  });

  it("scales portrait video to 720p short side", () => {
    const result = computeTargetDimensions(1080, 1920, null, 720);
    expect(result).not.toBeNull();
    const [w, h] = result!;
    expect(Math.min(w, h)).toBe(720);
    expect(w % 2).toBe(0);
    expect(h % 2).toBe(0);
  });

  it("produces even-numbered dimensions for codec compatibility", () => {
    // Odd-source dimensions that would produce fractional scaled sizes
    const result = computeTargetDimensions(1921, 1081, null, 720);
    if (result) {
      const [w, h] = result;
      expect(w % 2).toBe(0);
      expect(h % 2).toBe(0);
    }
  });

  it("returns null for zero dimensions", () => {
    expect(computeTargetDimensions(0, 1080, null, 720)).toBeNull();
    expect(computeTargetDimensions(1920, 0, null, 720)).toBeNull();
  });
});
