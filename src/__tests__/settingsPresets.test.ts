import { describe, expect, it } from "vitest";
import {
  arePresetSettingsEqual,
  MAX_SETTINGS_PRESETS,
  normalizePresetName,
  normalizePresetSettings,
  parseSettingsPresets,
} from "../settingsPresets";

describe("arePresetSettingsEqual", () => {
  it("detects when a preset-covered setting changes", () => {
    const original = normalizePresetSettings({ quality_index: 2 });

    expect(arePresetSettingsEqual(original, original)).toBe(true);
    expect(arePresetSettingsEqual(original, { ...original, advanced_resolution: "720p" })).toBe(
      false
    );
  });
});

describe("normalizePresetName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizePresetName("  Discord   mobile  ")).toBe("Discord mobile");
  });
});

describe("normalizePresetSettings", () => {
  it("fills defaults and preserves supported custom values", () => {
    expect(
      normalizePresetSettings({
        quality_index: 3,
        advanced_mode: true,
        advanced_target_size: "18.5",
        advanced_resolution: "720p",
        encoder_index: 2,
        encoder_label: "NVIDIA (h264_nvenc)",
      })
    ).toMatchObject({
      quality_index: 3,
      advanced_mode: true,
      advanced_target_size: "18.5",
      advanced_resolution: "720p",
      encoder_index: 2,
      encoder_label: "NVIDIA (h264_nvenc)",
      gif_fps: 15,
      fps_option: "off",
    });

    expect(
      normalizePresetSettings({ output_destination: "custom", completion_action: "reveal" })
    ).not.toHaveProperty("output_destination");
  });

  it("migrates the old lossless quality value", () => {
    expect(normalizePresetSettings({ quality_index: 5 })).toMatchObject({
      quality_index: 0,
      lossless_mode: true,
    });
  });

  it("stores semantic GIF targets and migrates the old index values", () => {
    expect(normalizePresetSettings({ gif_target_mb: 20 }).gif_target_mb).toBe(20);
    expect(normalizePresetSettings({ gif_quality_index: 0 }).gif_target_mb).toBe(20);
    expect(normalizePresetSettings({ gif_quality_index: 1 }).gif_target_mb).toBe(20);
    expect(normalizePresetSettings({ gif_quality_index: 2 }).gif_target_mb).toBe(5);
    expect(normalizePresetSettings({ gif_quality_index: 3 }).gif_target_mb).toBe(5);
    expect(normalizePresetSettings({ gif_target_mb: 50 }).gif_target_mb).toBe(5);
  });
});

describe("parseSettingsPresets", () => {
  it("ignores malformed entries, de-duplicates ids, and caps the list", () => {
    const input = [
      { id: "first", name: " First ", settings: { quality_index: 2 } },
      { id: "first", name: "Duplicate", settings: { quality_index: 3 } },
      { id: "missing-settings", name: "Missing" },
      ...Array.from({ length: MAX_SETTINGS_PRESETS + 2 }, (_, index) => ({
        id: `preset-${index}`,
        name: `Preset ${index}`,
        settings: { gif_mode: true },
      })),
    ];

    const parsed = parseSettingsPresets(input);

    expect(parsed).toHaveLength(MAX_SETTINGS_PRESETS);
    expect(parsed[0]).toMatchObject({ id: "first", name: "First", settings: { quality_index: 2 } });
    expect(parsed.some((preset) => preset.id === "missing-settings")).toBe(false);
  });
});
