import { describe, expect, it } from "vitest";
import {
  GIF_OUTPUT_FORMATS,
  gifOutputFormatLabel,
  normalizeGifOutputFormat,
} from "../gifOutputFormat";

describe("normalizeGifOutputFormat", () => {
  it("keeps the webp format", () => {
    expect(normalizeGifOutputFormat("webp")).toBe("webp");
  });

  it("keeps the gif format", () => {
    expect(normalizeGifOutputFormat("gif")).toBe("gif");
  });

  it("falls back to gif for anything else", () => {
    expect(normalizeGifOutputFormat("avif")).toBe("gif");
    expect(normalizeGifOutputFormat("")).toBe("gif");
    expect(normalizeGifOutputFormat(undefined)).toBe("gif");
    expect(normalizeGifOutputFormat(null)).toBe("gif");
    expect(normalizeGifOutputFormat(42)).toBe("gif");
  });
});

describe("gifOutputFormatLabel", () => {
  it("labels both formats", () => {
    expect(gifOutputFormatLabel("webp")).toBe("WebP");
    expect(gifOutputFormatLabel("gif")).toBe("GIF");
  });
});

describe("GIF_OUTPUT_FORMATS", () => {
  it("maps every format to its file extension", () => {
    expect(GIF_OUTPUT_FORMATS).toEqual([
      { value: "gif", label: "GIF", extension: "gif" },
      { value: "webp", label: "WebP", extension: "webp" },
    ]);
  });
});
