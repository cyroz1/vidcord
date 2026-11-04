import { describe, expect, it } from "vitest";
import { nativeSizeForContent, widthForWorkArea } from "../windowSizing";

describe("desktop window sizing", () => {
  it("reserves a consistent content width while fitting scaled monitor work areas", () => {
    expect(widthForWorkArea(1920, 16, 1)).toBe(850);
    expect(widthForWorkArea(1706, 100, 2)).toBe(801);
    expect(widthForWorkArea(1000, 12, 2)).toBe(492);
    expect(widthForWorkArea(1000, 15, 1.25)).toBe(786);
  });

  it("corrects the last native size request for the measured viewport and scaling", () => {
    expect(
      nativeSizeForContent(
        { width: 546, height: 684 },
        { width: 460, height: 650 },
        { width: 587, height: 855 },
        1.25
      )
    ).toEqual({ width: 697, height: 900 });
  });

  it("rounds fractional-scale requests up to avoid clipping", () => {
    expect(
      nativeSizeForContent(
        { width: 786, height: 684 },
        { width: 460, height: 650 },
        { width: 575, height: 812.5 },
        1.25
      )
    ).toEqual({ width: 985, height: 858 });
  });
});
