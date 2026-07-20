import { describe, expect, it } from "vitest";
import {
  formatTimelineTime,
  getSelectionCenter,
  getTimelineViewBounds,
  parseTimelineTimeInput,
  timeToTimelineValue,
  TIMELINE_ZOOM_MAX,
} from "../timelineZoom";

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

  it("supports detailed zooming for long videos", () => {
    expect(TIMELINE_ZOOM_MAX).toBe(100);
    expect(getTimelineViewBounds(5000, TIMELINE_ZOOM_MAX, 10_000, 1)).toEqual({
      start: 4950,
      end: 5050,
    });
  });

  it("formats timeline labels as seconds or clock time", () => {
    expect(formatTimelineTime(3723.45, false)).toBe("3723.4s");
    expect(formatTimelineTime(3723.45, true)).toBe("1:02:03.5");
    expect(formatTimelineTime(65.25, true)).toBe("0:01:05.3");
  });

  it("parses editable timeline times in seconds or clock notation", () => {
    expect(parseTimelineTimeInput("83.5")).toBe(83.5);
    expect(parseTimelineTimeInput("83.5s")).toBe(83.5);
    expect(parseTimelineTimeInput("2:03.5")).toBe(123.5);
    expect(parseTimelineTimeInput("1:02:03.5")).toBe(3723.5);
    expect(parseTimelineTimeInput("1:60:00")).toBeNull();
    expect(parseTimelineTimeInput("-1")).toBeNull();
    expect(parseTimelineTimeInput("")).toBeNull();
  });

  it("clamps typed times to the timeline duration", () => {
    expect(timeToTimelineValue(30, 120, 10_000)).toBe(2500);
    expect(timeToTimelineValue(180, 120, 10_000)).toBe(10_000);
    expect(timeToTimelineValue(-10, 120, 10_000)).toBe(0);
  });
});
