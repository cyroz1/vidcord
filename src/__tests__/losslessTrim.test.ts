import { describe, expect, it } from "vitest";
import {
  losslessTrimFitsTarget,
  normalizeLosslessKeyframes,
  snapLosslessTrimRange,
  snapLosslessTrimSliderRange,
} from "../losslessTrim";

describe("losslessTrimFitsTarget", () => {
  it("accepts a target whose bitrate covers the source bitrate", () => {
    expect(losslessTrimFitsTarget(10, 10, 8192)).toBe(true);
    expect(losslessTrimFitsTarget(10, 10, 8193)).toBe(false);
  });

  it("rejects missing or invalid sizing inputs", () => {
    expect(losslessTrimFitsTarget(null, 10, 1000)).toBe(false);
    expect(losslessTrimFitsTarget(10, 0, 1000)).toBe(false);
    expect(losslessTrimFitsTarget(10, 10, 0)).toBe(false);
  });
});

describe("normalizeLosslessKeyframes", () => {
  it("sorts, clamps, and deduplicates keyframe timestamps", () => {
    expect(normalizeLosslessKeyframes([4, 0, 4.0002, -1, 12, 20], 10)).toEqual([0, 4]);
  });

  it("rejects invalid durations", () => {
    expect(normalizeLosslessKeyframes([0, 1], 0)).toEqual([]);
    expect(normalizeLosslessKeyframes([0, 1], Number.NaN)).toEqual([]);
  });
});

describe("snapLosslessTrimRange", () => {
  const keyframes = [0, 2, 5, 8, 10];

  it("snaps outward to avoid cutting away requested content", () => {
    expect(snapLosslessTrimRange(2.4, 7.2, 10, keyframes)).toEqual({ start: 2, end: 8 });
  });

  it("clamps selections to the source duration", () => {
    expect(snapLosslessTrimRange(-2, 20, 10, keyframes)).toEqual({ start: 0, end: 10 });
  });

  it("returns null when snapping cannot produce a positive range", () => {
    expect(snapLosslessTrimRange(5, 5, 10, [0, 5, 10])).toBeNull();
    expect(snapLosslessTrimRange(0, 1, 10, [])).toBeNull();
  });
});

describe("snapLosslessTrimSliderRange", () => {
  it("restores timeline values on outward keyframe boundaries", () => {
    expect(snapLosslessTrimSliderRange(2400, 7200, 10, [0, 2, 5, 8, 10], 10000)).toEqual({
      start: 2000,
      end: 8000,
    });
  });

  it("rejects an invalid timeline scale", () => {
    expect(snapLosslessTrimSliderRange(0, 100, 10, [0, 10], 0)).toBeNull();
  });
});
