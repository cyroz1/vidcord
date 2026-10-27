import { describe, expect, it } from "vitest";
import { chooseWindowLayout, nativeSizeForContent } from "../windowSizing";

const sizes = {
  normal: { width: 546, height: 684 },
  compact: { width: 990, height: 385 },
  narrow: { width: 690, height: 463 },
};

describe("desktop window sizing", () => {
  it("chooses a layout that fits the work area, including native chrome and display scale", () => {
    const chrome = { width: 12, height: 42 };
    expect(chooseWindowLayout(sizes, { width: 1920, height: 1080 }, chrome, 1.25)).toBe("normal");
    expect(chooseWindowLayout(sizes, { width: 1500, height: 650 }, chrome, 1.25)).toBe("compact");
    expect(chooseWindowLayout(sizes, { width: 1000, height: 650 }, chrome, 1.25)).toBe("narrow");
    expect(chooseWindowLayout(sizes, { width: 1500, height: 1000 }, chrome, 2)).toBe("narrow");
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

  it("chooses the least-overflowing arrangement if the work area is smaller than every layout", () => {
    expect(
      chooseWindowLayout(sizes, { width: 900, height: 500 }, { width: 12, height: 42 }, 1.25)
    ).toBe("narrow");
  });
});
