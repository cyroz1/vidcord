import { describe, expect, it } from "vitest";
import {
  detectMatchingCropPreset,
  formatAverageBitrate,
  formatCodec,
  formatFrameRate,
  formatVideoDuration,
  getAvailableCropOptions,
  type CropOption,
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

  it("detects video aspect ratio and excludes matching preset from crop options", () => {
    expect(detectMatchingCropPreset(1920, 1080)).toBe("16:9");
    expect(detectMatchingCropPreset(1080, 1920)).toBe("9:16");
    expect(detectMatchingCropPreset(1080, 1080)).toBe("1:1");
    expect(detectMatchingCropPreset(1440, 1080)).toBe("4:3");
    expect(detectMatchingCropPreset(1080, 1440)).toBe("3:4");
    expect(detectMatchingCropPreset(1080, 1350)).toBe("4:5");
    expect(detectMatchingCropPreset(1350, 1080)).toBe("5:4");
    expect(detectMatchingCropPreset(2560, 1080)).toBeNull();

    const options169 = getAvailableCropOptions(1920, 1080);
    expect(options169.map((o: CropOption) => o.value)).toEqual([
      "off",
      "1:1",
      "9:16",
      "4:3",
      "3:4",
      "4:5",
      "5:4",
    ]);

    const options916 = getAvailableCropOptions(1080, 1920);
    expect(options916.map((o: CropOption) => o.value)).toEqual([
      "off",
      "16:9",
      "1:1",
      "4:3",
      "3:4",
      "4:5",
      "5:4",
    ]);
  });
});
