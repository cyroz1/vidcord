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
