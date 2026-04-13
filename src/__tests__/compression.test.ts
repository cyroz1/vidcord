import { describe, expect, it } from "vitest";
import {
  calculateBitrate,
  computeTargetDimensions,
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
