import { describe, expect, it } from "vitest";
import {
  browserContainerLabel,
  estimateAverageBitrateKbps,
  estimateVideoBitrateKbps,
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
    expect(estimateAverageBitrateKbps(0, 10)).toBe(0);
  });
});
