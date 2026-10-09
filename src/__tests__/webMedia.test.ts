import { describe, expect, it, vi } from "vitest";
import {
  browserContainerLabel,
  estimateAverageBitrateKbps,
  estimateVideoBitrateKbps,
  inferBrowserAudioMetadata,
  isBrowserFileSizeSupported,
  isMobileDevice,
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

  it("keeps audio enabled when mobile browsers expose an empty track list", () => {
    expect(inferBrowserAudioMetadata({ audioTracks: { length: 0 } })).toEqual({
      hasAudio: true,
      audioTrackCount: undefined,
    });
    expect(inferBrowserAudioMetadata({ audioTracks: { length: 2 } })).toEqual({
      hasAudio: true,
      audioTrackCount: 2,
    });
  });

  it("honors Firefox's explicit audio-presence flag", () => {
    expect(inferBrowserAudioMetadata({ mozHasAudio: false })).toEqual({
      hasAudio: false,
      audioTrackCount: 0,
    });
    expect(inferBrowserAudioMetadata({ mozHasAudio: true })).toEqual({
      hasAudio: true,
      audioTrackCount: 1,
    });
  });

  it("detects mobile devices including iPadOS desktop-mode user agents", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      maxTouchPoints: 5,
    });
    expect(isMobileDevice()).toBe(true);
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)",
      maxTouchPoints: 5,
    });
    expect(isMobileDevice()).toBe(true);
    // iPadOS 13+ reports a desktop Macintosh user agent.
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      maxTouchPoints: 5,
    });
    expect(isMobileDevice()).toBe(true);
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      maxTouchPoints: 0,
    });
    expect(isMobileDevice()).toBe(false);
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      maxTouchPoints: 0,
    });
    expect(isMobileDevice()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("treats a missing navigator as non-mobile", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isMobileDevice()).toBe(false);
    vi.unstubAllGlobals();
  });
});
