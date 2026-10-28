import { describe, expect, it } from "vitest";
import { nativeSizeForContent, widthForWorkArea } from "../windowSizing";

describe("desktop window sizing", () => {
  it("reserves a consistent content width while fitting scaled monitor work areas", () => {
    expect(widthForWorkArea(1920, 16, 1)).toBe(800);
    expect(widthForWorkArea(1706, 100, 2)).toBe(800);
    expect(widthForWorkArea(1000, 12, 2)).toBe(492);
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
});
