const CODEC_LABELS: Record<string, string> = {
  av1: "AV1",
  h264: "H.264",
  hevc: "HEVC",
  mpeg4: "MPEG-4",
  vp8: "VP8",
  vp9: "VP9",
};

function trimFixed(value: number, precision: number): string {
  return value.toFixed(precision).replace(/\.?0+$/, "");
}

export function formatVideoDuration(durationSec: number): string {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return "Unknown";

  const totalTenths = Math.round(durationSec * 10);
  const wholeSeconds = Math.floor(totalTenths / 10);
  const wholeMinutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  const formattedSeconds = `${String(seconds).padStart(2, "0")}.${totalTenths % 10}`;
  if (wholeMinutes < 60) return `${wholeMinutes}:${formattedSeconds}`;

  const hours = Math.floor(wholeMinutes / 60);
  const minutes = String(wholeMinutes % 60).padStart(2, "0");
  return `${hours}:${minutes}:${formattedSeconds}`;
}

export function formatFrameRate(frameRate?: number): string {
  if (typeof frameRate !== "number" || !Number.isFinite(frameRate) || frameRate <= 0) {
    return "Unknown";
  }
  return `${trimFixed(frameRate, 2)} fps`;
}

export function formatAverageBitrate(bitrateKbps: number): string {
  if (!Number.isFinite(bitrateKbps) || bitrateKbps <= 0) return "Unknown";
  if (bitrateKbps < 1000) return `${Math.round(bitrateKbps)} kbps`;
  return `${trimFixed(bitrateKbps / 1000, 2)} Mbps`;
}

export function formatCodec(codec: string): string {
  const normalized = codec.trim().toLowerCase();
  if (!normalized || normalized === "unknown") return "Unknown";
  return CODEC_LABELS[normalized] ?? normalized.toUpperCase();
}

export type CropOption = {
  value: string;
  label: string;
};

export const ALL_CROP_OPTIONS: CropOption[] = [
  { value: "off", label: "Off" },
  { value: "16:9", label: "16:9" },
  { value: "1:1", label: "1:1" },
  { value: "9:16", label: "9:16" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
  { value: "4:5", label: "4:5" },
  { value: "5:4", label: "5:4" },
];

// Single source of truth for crop ratios, derived from ALL_CROP_OPTIONS so
// preset detection and export-dimension math can never drift apart.
const CROP_RATIO_TABLE: ReadonlyArray<readonly [string, number]> = ALL_CROP_OPTIONS.filter(
  (option) => option.value !== "off"
)
  .map((option) => {
    const [width, height] = option.value.split(":").map(Number);
    return [option.value, width / height] as const;
  })
  // Only genuine "W:H" options belong in the table: a future non-ratio
  // option (e.g. "auto") would compute NaN here, and a NaN entry would make
  // getCroppedDimensions return NaN dimensions instead of the source size.
  .filter(([, ratio]) => Number.isFinite(ratio) && ratio > 0);
const CROP_RATIOS: ReadonlyMap<string, number> = new Map(CROP_RATIO_TABLE);

export function detectMatchingCropPreset(dw?: number, dh?: number): string | null {
  if (!dw || !dh || dw <= 0 || dh <= 0) return null;
  const ratio = dw / dh;

  for (const [key, targetRatio] of CROP_RATIO_TABLE) {
    if (Math.abs(ratio - targetRatio) < 0.03) {
      return key;
    }
  }
  return null;
}

export type VideoDetailsSource = {
  width: number;
  height: number;
  frame_rate?: number;
  bitrate: number;
  codec: string;
  duration: number;
};

/** The one-line source summary shown for single-file imports and batch items. */
export function formatVideoDetailsSummary(source: VideoDetailsSource): {
  text: string;
  label: string;
} {
  const resolution = `${source.width}×${source.height}`;
  const frameRate = formatFrameRate(source.frame_rate);
  const codec = formatCodec(source.codec);
  const bitrate = formatAverageBitrate(source.bitrate);
  const length = formatVideoDuration(source.duration);
  return {
    text: `${resolution} · ${frameRate} · ${codec} · ${bitrate} · ${length}`,
    label: `Resolution ${resolution}, frame rate ${frameRate}, codec ${codec}, average bitrate ${bitrate}, length ${length}`,
  };
}

export function getAvailableCropOptions(dw?: number, dh?: number): CropOption[] {
  if (!dw || !dh) return ALL_CROP_OPTIONS;
  const matched = detectMatchingCropPreset(dw, dh);
  if (!matched) return ALL_CROP_OPTIONS;
  return ALL_CROP_OPTIONS.filter((opt) => opt.value !== matched);
}

export function getCroppedDimensions(
  ow: number,
  oh: number,
  crop: string | null | undefined
): [number, number] {
  const { width, height } = getCenteredCropRect(ow, oh, crop);
  return [width, height];
}

export type CropRect = { x: number; y: number; width: number; height: number };

/** Return the centered source-pixel crop used by the preview and exports. */
export function getCenteredCropRect(
  ow: number,
  oh: number,
  crop: string | null | undefined
): CropRect {
  if (!ow || !oh || ow <= 0 || oh <= 0 || !crop || crop === "off") {
    return { x: 0, y: 0, width: ow, height: oh };
  }
  const targetRatio = CROP_RATIOS.get(crop);
  if (targetRatio === undefined) return { x: 0, y: 0, width: ow, height: oh };

  const sourceRatio = ow / oh;
  const width = sourceRatio > targetRatio ? Math.round(oh * targetRatio) : ow;
  const height = sourceRatio > targetRatio ? oh : Math.round(ow / targetRatio);
  return {
    x: Math.floor((ow - width) / 2),
    y: Math.floor((oh - height) / 2),
    width,
    height,
  };
}
