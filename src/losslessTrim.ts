export type LosslessVideoExtension = "mp4" | "mov" | "mkv" | "webm" | "avi" | "flv" | "wmv";

export type LosslessTrimInfo = {
  keyframe_times: number[];
  source_container_extension: LosslessVideoExtension | null;
};

export function losslessTrimFitsTarget(
  targetSizeMb: number | null,
  duration: number,
  sourceBitrateKbps: number
): boolean {
  if (
    targetSizeMb === null ||
    !Number.isFinite(targetSizeMb) ||
    targetSizeMb <= 0 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(sourceBitrateKbps) ||
    sourceBitrateKbps <= 0
  ) {
    return false;
  }

  const targetBitrateKbps = (targetSizeMb * 1024 * 8) / duration;
  return targetBitrateKbps >= sourceBitrateKbps;
}

function findFloor(values: readonly number[], target: number): number | null {
  let low = 0;
  let high = values.length - 1;
  let result: number | null = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = values[middle];
    if (value <= target) {
      result = value;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

function findCeil(values: readonly number[], target: number): number | null {
  let low = 0;
  let high = values.length - 1;
  let result: number | null = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = values[middle];
    if (value >= target) {
      result = value;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return result;
}

export function snapLosslessTrimRange(
  requestedStart: number,
  requestedEnd: number,
  duration: number,
  keyframeTimes: readonly number[]
): { start: number; end: number } | null {
  if (!Number.isFinite(duration) || duration <= 0 || keyframeTimes.length === 0) return null;

  const startTime = Math.max(0, Math.min(requestedStart, duration));
  const endTime = Math.max(0, Math.min(requestedEnd, duration));
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return null;

  const start = findFloor(keyframeTimes, startTime) ?? 0;
  const end = findCeil(keyframeTimes, endTime) ?? duration;
  if (end <= start) return null;

  return { start, end };
}

export function snapLosslessTrimSliderRange(
  requestedStart: number,
  requestedEnd: number,
  duration: number,
  keyframeTimes: readonly number[],
  sliderMax: number
): { start: number; end: number } | null {
  if (!Number.isFinite(sliderMax) || sliderMax <= 0) return null;

  const snapped = snapLosslessTrimRange(
    (requestedStart / sliderMax) * duration,
    (requestedEnd / sliderMax) * duration,
    duration,
    keyframeTimes
  );
  if (!snapped) return null;

  return {
    start: Math.round((snapped.start / duration) * sliderMax),
    end: Math.round((snapped.end / duration) * sliderMax),
  };
}

export function normalizeLosslessKeyframes(
  keyframeTimes: readonly number[],
  duration: number
): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];

  const values = new Set<number>();
  for (const time of keyframeTimes) {
    if (Number.isFinite(time) && time >= 0 && time <= duration) {
      values.add(time);
    }
  }

  const sorted = Array.from(values).sort((a, b) => a - b);
  const normalized: number[] = [];
  for (const time of sorted) {
    if (normalized.length === 0 || time - normalized[normalized.length - 1] >= 0.0005) {
      normalized.push(time);
    }
  }
  return normalized;
}
