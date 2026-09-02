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
    browser_download_url:
      "https://github.com/cyroz1/vidcord/releases/download/v7.3/vidcord_windows_x86_64.exe",
  },
  {
    name: "vidcord_windows_arm64.exe",
    browser_download_url:
      "https://github.com/cyroz1/vidcord/releases/download/v7.3/vidcord_windows_arm64.exe",
  },
  {
    name: "vidcord_macos_x64.dmg",
    browser_download_url:
      "https://github.com/cyroz1/vidcord/releases/download/v7.3/vidcord_macos_x64.dmg",
  },
  {
    name: "vidcord_macos_universal.dmg",
    browser_download_url:
      "https://github.com/cyroz1/vidcord/releases/download/v7.3/vidcord_macos_universal.dmg",
  },
  {
    name: "vidcord_linux_x86_64.AppImage",
    browser_download_url:
      "https://github.com/cyroz1/vidcord/releases/download/v7.3/vidcord_linux_x86_64.AppImage",
  },
  {
    name: "vidcord_linux_aarch64.AppImage",
    browser_download_url:
      "https://github.com/cyroz1/vidcord/releases/download/v7.3/vidcord_linux_aarch64.AppImage",
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

  it("requires a universal macOS asset instead of guessing an architecture", () => {
    expect(
      selectBestDownloadAsset(
        "macos",
        "unknown",
        assets.filter((asset) => !asset.name.includes("universal"))
      )
    ).toBeNull();
  });

  it("drops malformed release assets while keeping a valid release", () => {
    expect(
      parseLatestRelease({
        tag_name: "v7.4.0",
        assets: [assets[0], { name: "missing-url" }, null],
      })
    ).toEqual({ tag_name: "v7.4.0", assets: [assets[0]] });
  });

  it("drops release assets outside the expected GitHub download path", () => {
    expect(
      parseLatestRelease({
        tag_name: "v7.4.0",
        assets: [
          assets[0],
          {
            name: "vidcord_7.4.0_x64-setup.exe",
            browser_download_url: "https://downloads.example.test/installer.exe",
          },
          {
            name: "vidcord_7.4.0_x64-setup.exe",
            browser_download_url: "javascript:alert(1)",
          },
          {
            name: "other_7.4.0_x64-setup.exe",
            browser_download_url:
              "https://github.com/cyroz1/vidcord/releases/download/v7.4/other_7.4.0_x64-setup.exe",
          },
        ],
      })
    ).toEqual({ tag_name: "v7.4.0", assets: [assets[0]] });
  });
});
