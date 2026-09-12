import { describe, expect, it } from "vitest";
import { playheadForTrimHandleChange } from "../web/trimPlayhead";

describe("trim playhead anchoring", () => {
  it("follows a start handle in either direction when the playhead is attached", () => {
    expect(playheadForTrimHandleChange(5, 5, 4, "start")).toBe(4);
    expect(playheadForTrimHandleChange(5, 5, 6, "start")).toBe(6);
  });

  it("follows an end handle in either direction when the playhead is attached", () => {
    expect(playheadForTrimHandleChange(10, 10, 9, "end")).toBe(9);
    expect(playheadForTrimHandleChange(10, 10, 11, "end")).toBe(11);
  });

  it("only pushes an unattached playhead when the new trim range would exclude it", () => {
    expect(playheadForTrimHandleChange(5, 2, 6, "start")).toBe(6);
    expect(playheadForTrimHandleChange(5, 8, 4, "end")).toBe(4);
    expect(playheadForTrimHandleChange(5, 2, 3, "start")).toBeNull();
    expect(playheadForTrimHandleChange(5, 8, 7, "end")).toBeNull();
  });
});
