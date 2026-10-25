import type { UpdateCheckResult, UpdatePackageManager } from "./ipc";

/// The package manager / platform channel managing this install's updates,
/// or null when the install uses the GitHub Releases flow (or the check did
/// not report a channel). Managed installs return `update_available: false`
/// from the backend by design, so without this the user would never learn
/// where their updates come from.
export function managedUpdateChannel(result: UpdateCheckResult): UpdatePackageManager | null {
  if (result.updates_managed_by_package_manager === true && result.package_manager) {
    return result.package_manager;
  }
  return null;
}

/// Short footer label for a managed channel, e.g. "updates via apt".
export function updateChannelLabel(manager: UpdatePackageManager): string {
  return manager === "flatpak" ? "updates via Flatpak" : `updates via ${manager}`;
}
