import { describe, expect, it } from "vitest";
import {
  getEncoderRefreshDelay,
  parseCachedEncoders,
  selectEncoderIndex,
  type Encoder,
} from "../hooks/useEncoders";

const encoders: Encoder[] = [
  { name: "libx264", label: "CPU (libx264)" },
  {
    name: "h264_nvenc",
    label: "NVIDIA (h264_nvenc)",
    auto_selectable: true,
  },
  { name: "hevc_nvenc", label: "NVIDIA H.265 (hevc_nvenc)" },
];

describe("selectEncoderIndex", () => {
  it("prefers the stable saved label when encoder ordering changes", () => {
    expect(selectEncoderIndex(encoders, "NVIDIA (h264_nvenc)", 0)).toBe(1);
  });

  it("falls back to a clamped saved index when a saved encoder disappeared", () => {
    expect(selectEncoderIndex(encoders, "Missing encoder", 99)).toBe(2);
  });

  it("prefers a detected H.264 hardware encoder for first-run settings", () => {
    expect(selectEncoderIndex(encoders, undefined, 0)).toBe(1);
    expect(selectEncoderIndex([encoders[0], encoders[2]], undefined, 1)).toBe(0);
  });

  it("does not auto-select hardware that failed initialization validation", () => {
    const unverified = encoders.map((encoder) => ({ ...encoder, auto_selectable: false }));
    expect(selectEncoderIndex(unverified, undefined, 0)).toBe(0);
  });

  it("handles an empty discovery result", () => {
    expect(selectEncoderIndex([], undefined, 2)).toBe(0);
  });
});

describe("parseCachedEncoders", () => {
  it("accepts a bounded persisted capability list", () => {
    expect(parseCachedEncoders(encoders)).toEqual(encoders);
  });

  it("rejects malformed or unsafe encoder entries", () => {
    expect(parseCachedEncoders([{ name: "h264_nvenc;rm", label: "NVIDIA" }])).toEqual([]);
    expect(parseCachedEncoders([{ name: "libx264", label: "" }])).toEqual([]);
    expect(
      parseCachedEncoders([{ name: "h264_nvenc", label: "NVIDIA", auto_selectable: "yes" }])
    ).toEqual([]);
    expect(parseCachedEncoders("libx264")).toEqual([]);
  });
});

describe("getEncoderRefreshDelay", () => {
  it("waits for settings and a quiet import window", () => {
    expect(getEncoderRefreshDelay(false, false)).toBeNull();
    expect(getEncoderRefreshDelay(true, true)).toBeNull();
    expect(getEncoderRefreshDelay(true, false)).toBe(900);
  });
});
