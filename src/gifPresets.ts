export const GIF_PRESETS = [
  { label: "5 MB", sizeMb: 5, targetHeight: 360 },
  { label: "10 MB", sizeMb: 10, targetHeight: 480 },
  { label: "20 MB", sizeMb: 20, targetHeight: 720 },
] as const;

export type GifTargetMb = (typeof GIF_PRESETS)[number]["sizeMb"];

const LEGACY_GIF_TARGETS: readonly GifTargetMb[] = [20, 20];

export function isGifTargetMb(value: unknown): value is GifTargetMb {
  return GIF_PRESETS.some((preset) => preset.sizeMb === value);
}

export function normalizeGifTarget(value: unknown, fallback: GifTargetMb = 5): GifTargetMb {
  return isGifTargetMb(value) ? value : fallback;
}

export function gifPresetIndexForTarget(
  value: unknown,
  fallback: GifTargetMb = GIF_PRESETS[0].sizeMb
): number {
  const target = normalizeGifTarget(value, fallback);
  return GIF_PRESETS.findIndex((preset) => preset.sizeMb === target);
}

/**
 * The pre-7.4 schema stored indexes for the old 20 MB and 50 MB presets. The
 * removed 50 MB target is intentionally capped at the largest 7.4 target so
 * an existing user's setting never silently selects the new smallest target.
 */
export function migrateLegacyGifQualityIndex(value: unknown): GifTargetMb | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value >= LEGACY_GIF_TARGETS.length) return null;
  return LEGACY_GIF_TARGETS[value];
}
