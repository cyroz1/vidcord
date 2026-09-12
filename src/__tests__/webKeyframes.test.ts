import { describe, expect, it } from "vitest";
import { buildKeyframeProbeArgs, parseKeyframeTimes } from "../web/keyframes";

describe("browser keyframe discovery", () => {
  it("builds a showinfo probe that decodes only keyframes", () => {
    expect(buildKeyframeProbeArgs("input.mp4")).toEqual([
      "-hide_banner",
      "-loglevel",
      "info",
      "-skip_frame",
      "nokey",
      "-i",
      "input.mp4",
      "-map",
      "0:v:0",
      "-vf",
      "showinfo",
      "-an",
      "-f",
      "null",
      "-",
    ]);
  });

  it("parses showinfo timestamps and normalizes them to the source duration", () => {
    const log = [
      "[Parsed_showinfo_0] n: 0 pts_time:0 pos: 48 iskey:1 type:I",
      "[Parsed_showinfo_0] n: 1 pts_time:2 pos: 160 iskey:1 type:I",
      "[Parsed_showinfo_0] n: 2 pts_time:5 pos: 272 iskey:1 type:I",
      "[Parsed_showinfo_0] n: 3 pts_time:8 pos: 384 iskey:1 type:I",
    ].join("\n");

    expect(parseKeyframeTimes(log, 10)).toEqual([0, 2, 5, 8]);
  });

  it("ignores invalid values and timestamps outside the duration", () => {
    expect(
      parseKeyframeTimes("pts_time:-1 pts_time:2.5 pts_time:20 pts_time:not-a-time", 10)
    ).toEqual([2.5]);
  });
});
