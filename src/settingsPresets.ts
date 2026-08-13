export type OutputDestination = "downloads" | "source" | "ask" | "custom";
export type CompletionAction = "reveal" | "copy";

export type PresetSettings = {
  quality_index: number;
  gif_mode: boolean;
  gif_quality_index: number;
  gif_fps: number;
  advanced_mode: boolean;
  lossless_mode: boolean;
  advanced_target_size: string;
  advanced_resolution: string;
  fps_option: string;
  advanced_fps: string;
  advanced_encoder: string;
  remove_audio: boolean;
  audio_normalize: boolean;
  crop_aspect_ratio: string;
  batch_trim_start_seconds: number;
  batch_trim_end_seconds: number;
  encoder_index: number;
  encoder_label: string;
};

export type SettingsPreset = { id: string; name: string; settings: PresetSettings };

export const MAX_SETTINGS_PRESETS = 20;
export const MAX_PRESET_NAME_LENGTH = 40;

const DEFAULT_PRESET_SETTINGS: PresetSettings = {
  quality_index: 0,
  gif_mode: false,
  gif_quality_index: 0,
  gif_fps: 15,
  advanced_mode: false,
  lossless_mode: false,
  advanced_target_size: "",
  advanced_resolution: "Native",
  fps_option: "off",
  advanced_fps: "",
  advanced_encoder: "",
  remove_audio: false,
  audio_normalize: false,
  crop_aspect_ratio: "off",
  batch_trim_start_seconds: 0,
  batch_trim_end_seconds: 0,
  encoder_index: 0,
  encoder_label: "",
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePresetSettings(value: unknown): PresetSettings {
  const record = isRecord(value) ? value : {};
  const normalized = { ...DEFAULT_PRESET_SETTINGS };
  const mutable = normalized as unknown as UnknownRecord;

  for (const key of Object.keys(DEFAULT_PRESET_SETTINGS) as Array<keyof PresetSettings>) {
    if (typeof record[key] === typeof DEFAULT_PRESET_SETTINGS[key]) mutable[key] = record[key];
  }

  if (
    !Number.isInteger(normalized.quality_index) ||
    normalized.quality_index < 0 ||
    normalized.quality_index > 4
  ) {
    normalized.quality_index = 0;
  }
  if (
    !Number.isInteger(normalized.gif_quality_index) ||
    normalized.gif_quality_index < 0 ||
    normalized.gif_quality_index > 1
  ) {
    normalized.gif_quality_index = 0;
  }
  if (![15, 30, 50].includes(normalized.gif_fps)) normalized.gif_fps = 15;
  if (
    !Number.isFinite(normalized.batch_trim_start_seconds) ||
    normalized.batch_trim_start_seconds < 0
  ) {
    normalized.batch_trim_start_seconds = 0;
  }
  if (
    !Number.isFinite(normalized.batch_trim_end_seconds) ||
    normalized.batch_trim_end_seconds < 0
  ) {
    normalized.batch_trim_end_seconds = 0;
  }
  if (!Number.isInteger(normalized.encoder_index) || normalized.encoder_index < 0) {
    normalized.encoder_index = 0;
  }
  if (typeof record.lossless_mode !== "boolean")
    normalized.lossless_mode = record.quality_index === 5;
  return normalized;
}

export function arePresetSettingsEqual(left: PresetSettings, right: PresetSettings): boolean {
  return (Object.keys(DEFAULT_PRESET_SETTINGS) as Array<keyof PresetSettings>).every((key) =>
    Object.is(left[key], right[key])
  );
}

export function normalizePresetName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_PRESET_NAME_LENGTH);
}

export function createSettingsPresetId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

export function parseSettingsPresets(value: unknown): SettingsPreset[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const parsed: SettingsPreset[] = [];
  for (const item of value) {
    if (parsed.length >= MAX_SETTINGS_PRESETS) break;
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || item.id.length > 100)
      continue;
    const name = typeof item.name === "string" ? normalizePresetName(item.name) : "";
    if (!name || seenIds.has(item.id) || !isRecord(item.settings)) continue;
    seenIds.add(item.id);
    parsed.push({ id: item.id, name, settings: normalizePresetSettings(item.settings) });
  }
  return parsed;
}
