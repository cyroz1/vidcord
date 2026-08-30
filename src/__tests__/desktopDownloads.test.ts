import { describe, expect, it } from "vitest";
import {
  downloadLabel,
  needsArchitectureChoice,
  normalizeDownloadArch,
  normalizeDownloadPlatform,
  parseLatestRelease,
  selectBestDownloadAsset,
  type ReleaseAsset,
} from "../web/desktopDownloads";

const assets: ReleaseAsset[] = [
  {
    name: "vidcord_windows_x86_64.exe",
    browser_download_url: "https://example.test/windows-x64.exe",
  },
  {
    name: "vidcord_windows_arm64.exe",
    browser_download_url: "https://example.test/windows-arm64.exe",
  },
  {
    name: "vidcord_macos_x64.dmg",
    browser_download_url: "https://example.test/macos-x64.dmg",
  },
  {
    name: "vidcord_macos_universal.dmg",
    browser_download_url: "https://example.test/macos-universal.dmg",
  },
  {
    name: "vidcord_linux_x86_64.AppImage",
    browser_download_url: "https://example.test/linux-x64.AppImage",
  },
  {
    name: "vidcord_linux_aarch64.AppImage",
    browser_download_url: "https://example.test/linux-arm64.AppImage",
  },
];

describe("desktop download detection", () => {
  it("normalizes legacy platform and architecture signals", () => {
    expect(normalizeDownloadPlatform("Win32")).toBe("windows");
    expect(normalizeDownloadPlatform("MacIntel")).toBe("macos");
    expect(normalizeDownloadPlatform("X11; Linux x86_64")).toBe("linux");
    expect(normalizeDownloadArch("aarch64 64")).toBe("arm64");
    expect(normalizeDownloadArch("x86_64")).toBe("x64");
    expect(normalizeDownloadArch("WOW64")).toBe("x64");
  });

  it("selects the matching binary and prefers the universal Mac build", () => {
    expect(selectBestDownloadAsset("windows", "x64", assets)?.name).toBe(
      "vidcord_windows_x86_64.exe"
    );
    expect(selectBestDownloadAsset("windows", "arm64", assets)?.name).toBe(
      "vidcord_windows_arm64.exe"
    );
    expect(selectBestDownloadAsset("linux", "x64", assets)?.name).toBe(
      "vidcord_linux_x86_64.AppImage"
    );
    expect(selectBestDownloadAsset("linux", "arm64", assets)?.name).toBe(
      "vidcord_linux_aarch64.AppImage"
    );
    expect(selectBestDownloadAsset("macos", "unknown", assets)?.name).toBe(
      "vidcord_macos_universal.dmg"
    );
    expect(selectBestDownloadAsset("windows", "unknown", assets)).toBeNull();
  });

  it("requires a choice only for unknown Windows and Linux architectures", () => {
    expect(needsArchitectureChoice("windows", "unknown")).toBe(true);
    expect(needsArchitectureChoice("linux", "unknown")).toBe(true);
    expect(needsArchitectureChoice("macos", "unknown")).toBe(false);
    expect(needsArchitectureChoice("windows", "x64")).toBe(false);
    expect(downloadLabel("linux", "arm64")).toBe("Download for Linux ARM64");
  });

  it("drops malformed release assets while keeping a valid release", () => {
    expect(
      parseLatestRelease({
        tag_name: "v7.4.0",
        assets: [assets[0], { name: "missing-url" }, null],
      })
    ).toEqual({ tag_name: "v7.4.0", assets: [assets[0]] });
  });
});
