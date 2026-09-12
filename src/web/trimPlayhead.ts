export type TrimHandle = "start" | "end";

export const TRIM_PLAYHEAD_EPSILON = 0.08;

export function playheadForTrimHandleChange(
  playheadTime: number,
  previousHandleTime: number,
  nextHandleTime: number,
  handle: TrimHandle,
  epsilon = TRIM_PLAYHEAD_EPSILON
): number | null {
  const wasAttached = Math.abs(playheadTime - previousHandleTime) <= epsilon;
  const wouldLeaveSelection =
    handle === "start" ? playheadTime < nextHandleTime : playheadTime > nextHandleTime;

  return wasAttached || wouldLeaveSelection ? nextHandleTime : null;
}
