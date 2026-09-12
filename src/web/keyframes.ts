import { normalizeLosslessKeyframes } from "../losslessTrim";

const KEYFRAME_TIME_PATTERN = /\bpts_time:\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\b/gi;

export function buildKeyframeProbeArgs(inputName: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "info",
    "-skip_frame",
    "nokey",
    "-i",
    inputName,
    "-map",
    "0:v:0",
    "-vf",
    "showinfo",
    "-an",
    "-f",
    "null",
    "-",
  ];
}

export function parseKeyframeTimes(log: string, duration: number): number[] {
  const values: number[] = [];
  for (const match of log.matchAll(KEYFRAME_TIME_PATTERN)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return normalizeLosslessKeyframes(values, duration);
}
