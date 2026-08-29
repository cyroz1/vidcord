import { getCroppedDimensions } from "../videoMetadata";
import type { BrowserVideoMetadata } from "./webMedia";
import { normalizeBrowserFps, type BrowserMode, type BrowserSettings } from "./webSettings";

export const QUALITY_PRESETS = [
  { label: "20 MB · 480p", sizeMb: 20, targetHeight: 480 },
  { label: "50 MB · 720p", sizeMb: 50, targetHeight: 720 },
  { label: "100 MB · 1080p", sizeMb: 100, targetHeight: 1080 },
  { label: "500 MB · native", sizeMb: 500, targetHeight: null },
] as const;

export const GIF_PRESETS = [
  { label: "20 MB", sizeMb: 20, targetHeight: 480 },
  { label: "50 MB", sizeMb: 50, targetHeight: 720 },
] as const;

export const RESOLUTION_OPTIONS = ["Native", "1080p", "720p", "480p"] as const;
export const FPS_OPTIONS = [
  { label: "Source", value: "off", fps: null },
  { label: "24", value: "24", fps: 24 },
  { label: "30", value: "30", fps: 30 },
  { label: "60", value: "60", fps: 60 },
] as const;

const LOSSLESS_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm"]);

export type ExportPlan = {
  mode: BrowserMode;
  outputExtension: "mp4" | "gif" | "mov" | "mkv" | "webm";
  targetSizeMb: number | null;
  targetHeight: number | null;
  bitrateKbps: number | null;
  selectedDuration: number;
  summary: string;
};

export function selectedDuration(startTime: number, endTime: number, duration: number): number {
  const start = Math.max(0, Math.min(startTime, duration));
  const end = Math.max(start, Math.min(endTime, duration));
  return Math.max(0.1, end - start);
}

export function targetBitrateKbps(
  sizeMb: number,
  duration: number,
  removeAudio: boolean,
  audioTracks = 1
): number {
  const totalKbits = sizeMb * 1024 * 8;
  const audioKbits = removeAudio ? 0 : 128 * audioTracks * duration;
  return Math.max(100, Math.floor(((totalKbits - audioKbits) / Math.max(duration, 0.1)) * 0.88));
}

export function resolutionToHeight(value: string): number | null {
  if (value === "1080p") return 1080;
  if (value === "720p") return 720;
  if (value === "480p") return 480;
  return null;
}

function formatTargetSize(sizeMb: number | null): string {
  return sizeMb === null ? "Source quality" : `Up to ${sizeMb} MB`;
}

function formatCrop(crop: string): string {
  return crop === "off" ? "No crop" : crop;
}

function formatFps(fps: string): string {
  return fps === "off" ? "Keep source FPS" : `${fps} fps`;
}

export function createExportPlan(
  metadata: BrowserVideoMetadata,
  settings: BrowserSettings,
  mode: BrowserMode,
  startTime: number,
  endTime: number
): ExportPlan {
  const duration = selectedDuration(startTime, endTime, metadata.duration);

  if (mode === "lossless") {
    const sourceExtension = metadata.name.split(".").pop()?.toLowerCase() ?? "";
    const outputExtension = LOSSLESS_EXTENSIONS.has(sourceExtension)
      ? (sourceExtension as ExportPlan["outputExtension"])
      : "mp4";
    return {
      mode,
      outputExtension,
      targetSizeMb: null,
      targetHeight: null,
      bitrateKbps: null,
      selectedDuration: duration,
      summary: `Stream copy · ${formatCrop("off")} · No re-encode`,
    };
  }

  if (mode === "gif") {
    const preset = GIF_PRESETS[settings.gifQualityIndex] ?? GIF_PRESETS[0];
    return {
      mode,
      outputExtension: "gif",
      targetSizeMb: preset.sizeMb,
      targetHeight: preset.targetHeight,
      bitrateKbps: null,
      selectedDuration: duration,
      summary: `GIF · ${formatTargetSize(preset.sizeMb)} · ${formatCrop(settings.crop)} · ${settings.gifFps} fps`,
    };
  }

  const isAdvanced = mode === "advanced";
  const advancedSize = Number(settings.advancedTargetSize.trim());
  const targetSizeMb = isAdvanced
    ? Number.isFinite(advancedSize) && advancedSize > 0
      ? advancedSize
      : null
    : (QUALITY_PRESETS[settings.qualityIndex] ?? QUALITY_PRESETS[0]).sizeMb;
  const targetHeight = isAdvanced
    ? resolutionToHeight(settings.resolution)
    : (QUALITY_PRESETS[settings.qualityIndex] ?? QUALITY_PRESETS[0]).targetHeight;
  const bitrateKbps =
    targetSizeMb === null ? null : targetBitrateKbps(targetSizeMb, duration, settings.removeAudio);

  return {
    mode,
    outputExtension: "mp4",
    targetSizeMb,
    targetHeight,
    bitrateKbps,
    selectedDuration: duration,
    summary: `${formatTargetSize(targetSizeMb)} · ${targetHeight ? `${targetHeight}p` : "Native"} · ${formatCrop(settings.crop)} · ${formatFps(settings.fps)}`,
  };
}

function cropFilter(crop: string): string | null {
  switch (crop) {
    case "16:9":
      return "crop=trunc(if(gt(iw/ih\\,16/9)\\,ih*16/9\\,iw)/2)*2:trunc(if(gt(iw/ih\\,16/9)\\,ih\\,iw*9/16)/2)*2";
    case "1:1":
      return "crop=min(iw\\,ih):min(iw\\,ih)";
    case "9:16":
      return "crop=trunc(if(gt(iw/ih\\,9/16)\\,ih*9/16\\,iw)/2)*2:trunc(if(gt(iw/ih\\,9/16)\\,ih\\,iw*16/9)/2)*2";
    case "4:3":
      return "crop=trunc(if(gt(iw/ih\\,4/3)\\,ih*4/3\\,iw)/2)*2:trunc(if(gt(iw/ih\\,4/3)\\,ih\\,iw*3/4)/2)*2";
    case "3:4":
      return "crop=trunc(if(gt(iw/ih\\,3/4)\\,ih*3/4\\,iw)/2)*2:trunc(if(gt(iw/ih\\,3/4)\\,ih\\,iw*4/3)/2)*2";
    case "4:5":
      return "crop=trunc(if(gt(iw/ih\\,4/5)\\,ih*4/5\\,iw)/2)*2:trunc(if(gt(iw/ih\\,4/5)\\,ih\\,iw*5/4)/2)*2";
    case "5:4":
      return "crop=trunc(if(gt(iw/ih\\,5/4)\\,ih*5/4\\,iw)/2)*2:trunc(if(gt(iw/ih\\,5/4)\\,ih\\,iw*4/5)/2)*2";
    default:
      return null;
  }
}

function scaleFilter(
  metadata: BrowserVideoMetadata,
  crop: string,
  targetHeight: number | null
): string | null {
  if (!targetHeight) return null;
  const [croppedWidth, croppedHeight] = getCroppedDimensions(metadata.width, metadata.height, crop);
  if (croppedWidth <= 0 || croppedHeight <= 0 || targetHeight >= croppedHeight) return null;
  return croppedWidth >= croppedHeight ? `scale=-2:${targetHeight}` : `scale=${targetHeight}:-2`;
}

export function buildVideoFilter(
  metadata: BrowserVideoMetadata,
  settings: BrowserSettings,
  targetHeight: number | null
): string | null {
  const filters = [
    cropFilter(settings.crop),
    scaleFilter(metadata, settings.crop, targetHeight),
  ].filter((value): value is string => Boolean(value));
  const normalizedFps = normalizeBrowserFps(settings.fps);
  const fps = normalizedFps !== "off" ? Number(normalizedFps) : 0;
  if (Number.isFinite(fps) && fps > 0) filters.push(`fps=${fps}`);
  return filters.length > 0 ? filters.join(",") : null;
}

export function buildCompressionArgs(
  inputName: string,
  outputName: string,
  metadata: BrowserVideoMetadata,
  settings: BrowserSettings,
  plan: ExportPlan,
  bitrateKbps: number | null
): string[] {
  const args = [
    "-ss",
    "0",
    "-i",
    inputName,
    "-t",
    plan.selectedDuration.toFixed(3),
    "-map",
    "0:v:0",
  ];
  const filter = buildVideoFilter(metadata, settings, plan.targetHeight);
  if (filter) args.push("-vf", filter);
  args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
  if (bitrateKbps !== null) {
    args.push(
      "-b:v",
      `${bitrateKbps}k`,
      "-maxrate",
      `${Math.round(bitrateKbps * 1.08)}k`,
      "-bufsize",
      `${Math.round(bitrateKbps * 2)}k`
    );
  } else {
    args.push("-crf", "23");
  }
  if (settings.removeAudio) {
    args.push("-an");
  } else {
    args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k");
    if (settings.audioNormalize) args.push("-af", "loudnorm=I=-14:TP=0.0:LRA=11");
  }
  args.push("-movflags", "+faststart", outputName);
  return args;
}

export function buildGifArgs(
  inputName: string,
  outputName: string,
  metadata: BrowserVideoMetadata,
  settings: BrowserSettings,
  plan: ExportPlan,
  targetHeight: number
): string[] {
  const visualFilters = [
    cropFilter(settings.crop),
    scaleFilter(metadata, settings.crop, targetHeight),
    `fps=${settings.gifFps}`,
  ].filter((value): value is string => Boolean(value));
  const filter = `${visualFilters.join(",")},split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a`;
  return [
    "-ss",
    "0",
    "-i",
    inputName,
    "-t",
    plan.selectedDuration.toFixed(3),
    "-vf",
    filter,
    "-an",
    "-loop",
    "0",
    outputName,
  ];
}

export function buildLosslessArgs(
  inputName: string,
  outputName: string,
  startTime: number,
  endTime: number
): string[] {
  return [
    "-ss",
    Math.max(0, startTime).toFixed(3),
    "-i",
    inputName,
    "-t",
    Math.max(0.1, endTime - startTime).toFixed(3),
    "-map",
    "0",
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    outputName,
  ];
}

export function getRetryBitrate(
  currentKbps: number,
  outputBytes: number,
  targetSizeMb: number
): number {
  const targetBytes = targetSizeMb * 1024 * 1024;
  const correction = targetBytes / Math.max(outputBytes, targetBytes);
  return Math.max(100, Math.floor(currentKbps * correction * 0.9));
}

export function outputFileName(name: string, extension: string, index = 0): string {
  const stem =
    name
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9._ -]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/\s*-\s*/g, " - ")
      .replace(/\s+-\s*$/, "")
      .trim() || "video";
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `${stem}-vidcord${suffix}.${extension}`;
}
