export type BrowserMode = "compress" | "advanced" | "lossless" | "gif";

export type BrowserSettings = {
  mode: BrowserMode;
  qualityIndex: number;
  gifQualityIndex: number;
  gifFps: number;
  advancedTargetSize: string;
  resolution: string;
  fps: string;
  removeAudio: boolean;
  audioNormalize: boolean;
  crop: string;
};

const SETTINGS_KEY = "vidcord.browser.settings.v1";
const RESOLUTION_VALUES = new Set(["Native", "1080p", "720p", "480p"]);
const FPS_VALUES = new Set(["off", "24", "30", "60"]);
const CROP_VALUES = new Set(["off", "16:9", "1:1", "9:16", "4:3", "3:4", "4:5", "5:4"]);
export const MAX_BROWSER_FPS = 240;

const FPS_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  mode: "compress",
  qualityIndex: 0,
  gifQualityIndex: 0,
  gifFps: 15,
  advancedTargetSize: "",
  resolution: "Native",
  fps: "off",
  removeAudio: false,
  audioNormalize: false,
  crop: "off",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing and storage-disabled contexts can reject persistence.
  }
}

function normalizeMode(value: unknown): BrowserMode {
  return value === "advanced" || value === "lossless" || value === "gif" ? value : "compress";
}

export function normalizeBrowserFps(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_BROWSER_SETTINGS.fps;
  const fps = value.trim();
  if (fps === "" || fps === "off") return DEFAULT_BROWSER_SETTINGS.fps;
  if (!FPS_PATTERN.test(fps)) return DEFAULT_BROWSER_SETTINGS.fps;

  const numeric = Number(fps);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= MAX_BROWSER_FPS
    ? fps
    : DEFAULT_BROWSER_SETTINGS.fps;
}

export function normalizeBrowserSettings(value: unknown): BrowserSettings {
  const record = isRecord(value) ? value : {};
  const qualityIndex =
    typeof record.qualityIndex === "number" && Number.isInteger(record.qualityIndex)
      ? Math.max(0, Math.min(3, record.qualityIndex))
      : DEFAULT_BROWSER_SETTINGS.qualityIndex;
  const gifQualityIndex =
    typeof record.gifQualityIndex === "number" && Number.isInteger(record.gifQualityIndex)
      ? Math.max(0, Math.min(1, record.gifQualityIndex))
      : DEFAULT_BROWSER_SETTINGS.gifQualityIndex;
  const gifFps = record.gifFps === 30 || record.gifFps === 50 ? record.gifFps : 15;
  const resolution =
    typeof record.resolution === "string" && RESOLUTION_VALUES.has(record.resolution)
      ? record.resolution
      : DEFAULT_BROWSER_SETTINGS.resolution;
  const fps =
    typeof record.fps === "string" &&
    (FPS_VALUES.has(record.fps) || FPS_PATTERN.test(record.fps.trim()))
      ? normalizeBrowserFps(record.fps)
      : DEFAULT_BROWSER_SETTINGS.fps;
  const crop =
    typeof record.crop === "string" && CROP_VALUES.has(record.crop)
      ? record.crop
      : DEFAULT_BROWSER_SETTINGS.crop;

  return {
    mode: normalizeMode(record.mode),
    qualityIndex,
    gifQualityIndex,
    gifFps,
    advancedTargetSize:
      typeof record.advancedTargetSize === "string" ? record.advancedTargetSize.slice(0, 12) : "",
    resolution,
    fps,
    removeAudio: record.removeAudio === true,
    audioNormalize: record.audioNormalize === true,
    crop,
  };
}

export function loadBrowserSettings(): BrowserSettings {
  const raw = safeStorageGet(SETTINGS_KEY);
  if (!raw) return DEFAULT_BROWSER_SETTINGS;
  try {
    return normalizeBrowserSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_BROWSER_SETTINGS;
  }
}

export function saveBrowserSettings(settings: BrowserSettings): void {
  safeStorageSet(SETTINGS_KEY, JSON.stringify(settings));
}
