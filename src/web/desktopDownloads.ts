export type DownloadPlatform = "windows" | "macos" | "linux" | "unknown";
export type DownloadArch = "x64" | "arm64" | "unknown";

export type DownloadEnvironment = {
  platform: DownloadPlatform;
  arch: DownloadArch;
  archCertain: boolean;
};

export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

export type LatestRelease = {
  tag_name: string;
  assets: readonly ReleaseAsset[];
};

export const LATEST_RELEASE_URL = "https://github.com/cyroz1/vidcord/releases/latest";
const RELEASE_API_URL = "https://api.github.com/repos/cyroz1/vidcord/releases/latest";
const RELEASE_DOWNLOAD_ORIGIN = "https://github.com";
const RELEASE_DOWNLOAD_PATH = "/cyroz1/vidcord/releases/download/";
const RELEASE_ASSET_NAME = /^vidcord_[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PLATFORM_NAMES: Record<DownloadPlatform, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  unknown: "your platform",
};

const ARCH_NAMES: Record<Exclude<DownloadArch, "unknown">, string> = {
  x64: "x64",
  arm64: "ARM64",
};

const DEFAULT_ENVIRONMENT: DownloadEnvironment = {
  platform: "unknown",
  arch: "unknown",
  archCertain: false,
};

type UserAgentData = {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
};

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: UserAgentData;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTrustedReleaseAsset(asset: ReleaseAsset): boolean {
  if (!RELEASE_ASSET_NAME.test(asset.name)) return false;

  try {
    const url = new URL(asset.browser_download_url);
    const fileName = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    return (
      url.origin === RELEASE_DOWNLOAD_ORIGIN &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.startsWith(RELEASE_DOWNLOAD_PATH) &&
      fileName === asset.name &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function normalizeDownloadPlatform(value: unknown): DownloadPlatform {
  const text = String(value ?? "").toLowerCase();

  if (/android|iphone|ipad|ipod|cros/.test(text)) return "unknown";
  if (text.includes("mac") || text.includes("darwin")) {
    return "macos";
  }

  if (text.includes("win")) {
    return "windows";
  }

  if (text.includes("linux") || text.includes("x11")) {
    return "linux";
  }

  return "unknown";
}

export function normalizeDownloadArch(value: unknown): DownloadArch {
  const text = String(value ?? "").toLowerCase();
  const compactText = text.replace(/[\s_-]+/g, "");

  if (
    compactText.includes("arm64") ||
    compactText.includes("aarch64") ||
    (compactText.includes("arm") && compactText.includes("64"))
  ) {
    return "arm64";
  }

  if (
    compactText.includes("x8664") ||
    compactText.includes("x64") ||
    compactText.includes("amd64") ||
    text.includes("win64") ||
    text.includes("wow64")
  ) {
    return "x64";
  }

  return "unknown";
}

export async function detectDownloadEnvironment(): Promise<DownloadEnvironment> {
  if (typeof navigator === "undefined") {
    return DEFAULT_ENVIRONMENT;
  }

  const navigatorWithUserAgentData = navigator as NavigatorWithUserAgentData;
  if (
    /android|iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  ) {
    return DEFAULT_ENVIRONMENT;
  }
  const userAgentData = navigatorWithUserAgentData.userAgentData;
  let platformSource =
    userAgentData?.platform || navigatorWithUserAgentData.platform || navigator.userAgent;
  let arch: DownloadArch = "unknown";
  let archCertain = false;

  if (userAgentData && typeof userAgentData.getHighEntropyValues === "function") {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const values = await Promise.race([
        userAgentData.getHighEntropyValues(["architecture", "bitness", "platform"]),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), 1500);
        }),
      ]);
      if (!values)
        return { platform: normalizeDownloadPlatform(platformSource), arch, archCertain };
      const detectedArch = normalizeDownloadArch(
        `${values.architecture ?? ""} ${values.bitness ?? ""}`
      );
      platformSource = typeof values.platform === "string" ? values.platform : platformSource;

      if (detectedArch !== "unknown") {
        arch = detectedArch;
        archCertain = true;
      }
    } catch {
      arch = "unknown";
      archCertain = false;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    platform: normalizeDownloadPlatform(platformSource),
    arch,
    archCertain,
  };
}

export function platformDisplayName(platform: DownloadPlatform): string {
  return PLATFORM_NAMES[platform] ?? PLATFORM_NAMES.unknown;
}

export function archDisplayName(arch: Exclude<DownloadArch, "unknown">): string {
  return ARCH_NAMES[arch];
}

export function platformExtension(platform: DownloadPlatform): string {
  if (platform === "windows") {
    return ".exe";
  }

  if (platform === "macos") {
    return ".dmg";
  }

  if (platform === "linux") {
    return ".appimage";
  }

  return "";
}

function isArm64Name(name: string): boolean {
  return /(?:arm64|aarch64)/i.test(name);
}

function isX64Name(name: string): boolean {
  return /(?:x64|x86_64|amd64)/i.test(name);
}

function assetMatchesArch(asset: ReleaseAsset, arch: DownloadArch): boolean {
  if (arch === "arm64") {
    return isArm64Name(asset.name);
  }

  if (arch === "x64") {
    return isX64Name(asset.name);
  }

  return false;
}

export function selectBestDownloadAsset(
  platform: DownloadPlatform,
  arch: DownloadArch,
  assets: readonly ReleaseAsset[]
): ReleaseAsset | null {
  const extension = platformExtension(platform);

  if (!extension || !Array.isArray(assets)) {
    return null;
  }

  const candidates = assets.filter(
    (asset) => isTrustedReleaseAsset(asset) && asset.name.toLowerCase().endsWith(extension)
  );

  if (!candidates.length) {
    return null;
  }

  if (platform === "macos") {
    return candidates.find((asset) => asset.name.toLowerCase().includes("universal")) ?? null;
  }

  return (
    candidates
      .filter((asset) => assetMatchesArch(asset, arch))
      .sort((a, b) => a.name.localeCompare(b.name))[0] ?? null
  );
}

export function needsArchitectureChoice(platform: DownloadPlatform, arch: DownloadArch): boolean {
  return (platform === "windows" || platform === "linux") && arch === "unknown";
}

export function downloadLabel(platform: DownloadPlatform, arch: DownloadArch): string {
  const platformLabel = platformDisplayName(platform);

  if (arch === "unknown" || platform === "unknown") {
    return `Download for ${platformLabel}`;
  }

  return `Download for ${platformLabel} ${archDisplayName(arch)}`;
}

export function parseLatestRelease(value: unknown): LatestRelease {
  if (!isRecord(value)) {
    throw new Error("GitHub returned an invalid release payload");
  }

  const assets = Array.isArray(value.assets)
    ? value.assets.filter((asset): asset is ReleaseAsset => {
        return (
          isRecord(asset) &&
          typeof asset.name === "string" &&
          typeof asset.browser_download_url === "string" &&
          isTrustedReleaseAsset({
            name: asset.name,
            browser_download_url: asset.browser_download_url,
          })
        );
      })
    : [];

  return {
    tag_name: typeof value.tag_name === "string" ? value.tag_name : "latest",
    assets,
  };
}

export async function fetchLatestRelease(signal: AbortSignal): Promise<LatestRelease> {
  const response = await fetch(RELEASE_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }

  return parseLatestRelease(await response.json());
}

export { DEFAULT_ENVIRONMENT };
