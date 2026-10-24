import { describe, expect, it } from "vitest";
import { managedUpdateChannel, updateChannelLabel } from "../updateChannel";
import type { UpdateCheckResult } from "../ipc";

describe("managedUpdateChannel", () => {
  it("returns the manager for a managed payload", () => {
    for (const manager of ["apt", "dnf", "pacman", "flatpak"] as const) {
      const result: UpdateCheckResult = {
        update_available: false,
        updates_managed_by_package_manager: true,
        package_manager: manager,
      };
      expect(managedUpdateChannel(result)).toBe(manager);
    }
  });

  it("returns null for a GitHub-flow payload", () => {
    const result: UpdateCheckResult = {
      update_available: true,
      latest_version: "7.7.0",
      release_url: "https://github.com/cyroz1/vidcord/releases/tag/v7.7",
    };
    expect(managedUpdateChannel(result)).toBeNull();
  });

  it("returns null when the flag is set without a manager", () => {
    const result: UpdateCheckResult = {
      update_available: false,
      updates_managed_by_package_manager: true,
    };
    expect(managedUpdateChannel(result)).toBeNull();
  });

  it("returns null when a manager is named but the flag is absent", () => {
    const result: UpdateCheckResult = {
      update_available: false,
      package_manager: "apt",
    };
    expect(managedUpdateChannel(result)).toBeNull();
  });
});

describe("updateChannelLabel", () => {
  it("labels package managers by name and capitalizes Flatpak", () => {
    expect(updateChannelLabel("apt")).toBe("updates via apt");
    expect(updateChannelLabel("dnf")).toBe("updates via dnf");
    expect(updateChannelLabel("pacman")).toBe("updates via pacman");
    expect(updateChannelLabel("flatpak")).toBe("updates via Flatpak");
  });
});
