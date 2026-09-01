import { describe, expect, it } from "vitest";
import {
  browserContainerLabel,
  estimateAverageBitrateKbps,
  estimateVideoBitrateKbps,
  isBrowserFileSizeSupported,
  MAX_BROWSER_INPUT_BYTES,
  VIDEO_FILE_ACCEPT,
} from "../web/webMedia";

describe("browser media metadata helpers", () => {
  it("identifies a useful container label from MIME type or extension", () => {
    expect(browserContainerLabel({ name: "clip.mp4", type: "video/mp4" })).toBe("MP4 container");
    expect(browserContainerLabel({ name: "clip.webm", type: "" })).toBe("WebM container");
    expect(browserContainerLabel({ name: "clip.mkv", type: "video/x-unknown" })).toBe(
      "Matroska container"
    );
  });

  it("estimates average and video bitrate from local file size and duration", () => {
    expect(estimateAverageBitrateKbps(1_000_000, 10)).toBe(800);
    expect(estimateVideoBitrateKbps(1_000_000, 10)).toBe(672);
    expect(estimateVideoBitrateKbps(1_000_000, 10, 0)).toBe(800);
    expect(estimateVideoBitrateKbps(1_000_000, 10, 2)).toBe(544);
    expect(estimateAverageBitrateKbps(0, 10)).toBe(0);
  });

  it("shares the picker extension allowlist and enforces the browser input cap", () => {
    expect(VIDEO_FILE_ACCEPT).toContain(".m4v");
    expect(VIDEO_FILE_ACCEPT).toContain(".ogv");
    expect(isBrowserFileSizeSupported({ size: MAX_BROWSER_INPUT_BYTES })).toBe(true);
    expect(isBrowserFileSizeSupported({ size: MAX_BROWSER_INPUT_BYTES + 1 })).toBe(false);
  });
});
