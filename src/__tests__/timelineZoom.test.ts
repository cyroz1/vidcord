import { describe, expect, it } from "vitest";
import { getSelectionCenter, getTimelineViewBounds } from "../timelineZoom";

describe("timeline zoom", () => {
  it("centers zoom on a selected portion near the start of the clip", () => {
    const center = getSelectionCenter(0, 1667, 10_000);
    const view = getTimelineViewBounds(center, 2, 10_000, 1);

    expect(center).toBe(833.5);
    expect(view).toEqual({ start: 0, end: 5000 });
    expect(view.start).toBeLessThanOrEqual(0);
    expect(view.end).toBeGreaterThanOrEqual(1667);
  });

  it("centers zoom on a selection in the middle of the clip", () => {
    const center = getSelectionCenter(4000, 6000, 10_000);
    expect(getTimelineViewBounds(center, 2, 10_000, 1)).toEqual({
      start: 2500,
      end: 7500,
    });
  });

  it("clamps a selection-centered view at the end of the clip", () => {
    const center = getSelectionCenter(9000, 10_000, 10_000);
    expect(getTimelineViewBounds(center, 4, 10_000, 1)).toEqual({
      start: 7500,
      end: 10_000,
    });
  });
});
