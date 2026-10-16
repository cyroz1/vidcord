export const GIF_OUTPUT_FORMATS = [
  { value: "gif", label: "GIF", extension: "gif" },
  { value: "webp", label: "WebP", extension: "webp" },
] as const;

export type GifOutputFormat = (typeof GIF_OUTPUT_FORMATS)[number]["value"];

export function normalizeGifOutputFormat(value: unknown): GifOutputFormat {
  return value === "webp" ? "webp" : "gif";
}

export function gifOutputFormatLabel(format: GifOutputFormat): string {
  return format === "webp" ? "WebP" : "GIF";
}
