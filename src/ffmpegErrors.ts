const FFMPEG_MISSING_MARKER = "FFMPEG_MISSING:";

export const FFMPEG_MISSING_LOAD_MESSAGE = "FFmpeg is required to load videos.";
export const FFMPEG_MISSING_TOAST_MESSAGE =
  "FFmpeg was not found on PATH. Install FFmpeg and restart vidcord.";

export function isFfmpegMissingError(error: unknown): boolean {
  const message = String(error ?? "");
  const lower = message.toLowerCase();

  return (
    message.includes(FFMPEG_MISSING_MARKER) ||
    lower.includes("program not found") ||
    lower.includes("ffmpeg not found") ||
    lower.includes("ffmpeg was not found") ||
    lower.includes("ffprobe not found") ||
    lower.includes("ffprobe was not found")
  );
}
