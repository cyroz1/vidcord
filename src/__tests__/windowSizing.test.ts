import { describe, expect, it } from "vitest";
import {
  compressSizeForWorkArea,
  isSettledSize,
  nativeSizeForContent,
  positionWithinWorkArea,
  shouldUseNarrowLayout,
  widthForWorkArea,
} from "../windowSizing";

describe("desktop window sizing", () => {
  it("fits the Compress window inside a small scaled work area", () => {
    expect(
      compressSizeForWorkArea({ width: 1920, height: 1080 }, { width: 16, height: 39 }, 1)
    ).toEqual({ width: 460, height: 690 });
    expect(
      compressSizeForWorkArea({ width: 800, height: 600 }, { width: 20, height: 40 }, 2)
    ).toEqual({ width: 390, height: 280 });
  });

  it("moves a resized window back into the current work area", () => {
    const area = { position: { x: -800, y: 0 }, size: { width: 800, height: 600 } };
    expect(positionWithinWorkArea({ x: -500, y: 400 }, { width: 460, height: 590 }, area)).toEqual({
      x: -500,
      y: 10,
    });
  });
  it("uses the compact layout only when it fits horizontally and saves height", () => {
    expect(shouldUseNarrowLayout(700, 400, 700, 800, 500)).toBe(true);
    expect(shouldUseNarrowLayout(700, 400, 700, 640, 500)).toBe(false);
    expect(shouldUseNarrowLayout(700, 720, 700, 800, 500)).toBe(false);
  });

  it("rechecks the viewport before treating a measured size as settled", () => {
    const settled = { width: 460, height: 600 };
    expect(isSettledSize(460, 601, settled, { width: 462, height: 602 })).toBe(true);
    expect(isSettledSize(460, 601, settled, { width: 400, height: 500 })).toBe(false);
    expect(isSettledSize(460, 610, settled, { width: 462, height: 602 })).toBe(false);
  });
  it("reserves a consistent content width while fitting scaled monitor work areas", () => {
    expect(widthForWorkArea(1920, 16, 1)).toBe(460);
    expect(widthForWorkArea(1706, 100, 2)).toBe(460);
    expect(widthForWorkArea(1000, 15, 1.25)).toBe(460);
    expect(widthForWorkArea(700, 12, 2)).toBe(342);
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
