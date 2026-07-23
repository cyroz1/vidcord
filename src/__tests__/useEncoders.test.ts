import { describe, expect, it } from "vitest";
import { parseCachedEncoders, selectEncoderIndex, type Encoder } from "../hooks/useEncoders";

const encoders: Encoder[] = [
  { name: "libx264", label: "CPU (libx264)" },
  { name: "h264_nvenc", label: "NVIDIA (h264_nvenc)" },
  { name: "hevc_nvenc", label: "NVIDIA H.265 (hevc_nvenc)" },
];

describe("selectEncoderIndex", () => {
  it("prefers the stable saved label when encoder ordering changes", () => {
    expect(selectEncoderIndex(encoders, "NVIDIA (h264_nvenc)", 0)).toBe(1);
  });

  it("falls back to a clamped saved index", () => {
    expect(selectEncoderIndex(encoders, "Missing encoder", 99)).toBe(2);
    expect(selectEncoderIndex(encoders, undefined, -4)).toBe(0);
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
    expect(parseCachedEncoders("libx264")).toEqual([]);
  });
});
