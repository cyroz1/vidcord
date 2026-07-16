import { describe, expect, it } from "vitest";
import {
  formatAverageBitrate,
  formatCodec,
  formatFrameRate,
  formatVideoDuration,
} from "../videoMetadata";

describe("video metadata formatting", () => {
  it("formats duration as compact clock time", () => {
    expect(formatVideoDuration(65.25)).toBe("1:05.3");
    expect(formatVideoDuration(3723.45)).toBe("1:02:03.5");
    expect(formatVideoDuration(59.96)).toBe("1:00.0");
  });

  it("formats common source frame rates without noisy precision", () => {
    expect(formatFrameRate(30)).toBe("30 fps");
    expect(formatFrameRate(30000 / 1001)).toBe("29.97 fps");
  });

  it("formats source bitrate in readable units", () => {
    expect(formatAverageBitrate(850)).toBe("850 kbps");
    expect(formatAverageBitrate(8250)).toBe("8.25 Mbps");
  });

  it("uses familiar labels for common codecs", () => {
    expect(formatCodec("h264")).toBe("H.264");
    expect(formatCodec("hevc")).toBe("HEVC");
  });

  it("marks missing metadata as unknown", () => {
    expect(formatVideoDuration(0)).toBe("Unknown");
    expect(formatFrameRate()).toBe("Unknown");
    expect(formatAverageBitrate(0)).toBe("Unknown");
    expect(formatCodec("unknown")).toBe("Unknown");
  });
});
