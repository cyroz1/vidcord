import { memo, useMemo, type CSSProperties } from "react";
import { formatClock } from "./webMedia";

type Props = {
  duration: number;
  startTime: number;
  endTime: number;
  currentTime: number;
  disabled?: boolean;
  onStartChange: (value: number) => void;
  onEndChange: (value: number) => void;
  onSeek: (value: number) => void;
};

const MIN_TRIM_GAP = 0.1;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function WebTrimTimeline({
  duration,
  startTime,
  endTime,
  currentTime,
  disabled = false,
  onStartChange,
  onEndChange,
  onSeek,
}: Props) {
  const safeDuration = Math.max(duration, 0.1);
  const startPercent = (startTime / safeDuration) * 100;
  const endPercent = (endTime / safeDuration) * 100;
  const playheadPercent = (currentTime / safeDuration) * 100;
  const rangeStyle = useMemo(
    () =>
      ({
        "--trim-start": `${startPercent}%`,
        "--trim-end": `${endPercent}%`,
      }) as CSSProperties,
    [endPercent, startPercent]
  );

  return (
    <section className="web-timeline" aria-labelledby="web-timeline-title">
      <div className="web-section-heading">
        <div>
          <span className="web-section-label">Trim video</span>
          <strong id="web-timeline-title">
            {formatClock(Math.max(0, endTime - startTime))} selected
          </strong>
        </div>
        <span className="web-timeline-range">
          {formatClock(startTime)} — {formatClock(endTime)}
        </span>
      </div>

      <div className="web-timeline-track-wrap">
        <button
          className="web-timeline-click-target"
          type="button"
          aria-label="Seek video timeline"
          disabled={disabled}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 0;
            onSeek(clamp(ratio * safeDuration, 0, safeDuration));
          }}
        />
        <div className="web-timeline-track" style={rangeStyle} aria-hidden="true">
          <span
            className="web-timeline-playhead"
            style={{ left: `${clamp(playheadPercent, 0, 100)}%` }}
          />
        </div>
        <input
          className="web-range web-range-start"
          type="range"
          min="0"
          max={safeDuration}
          step="0.01"
          value={startTime}
          disabled={disabled}
          aria-label="Trim start"
          onChange={(event) => {
            const next = Number(event.target.value);
            onStartChange(clamp(next, 0, Math.max(0, endTime - MIN_TRIM_GAP)));
          }}
        />
        <input
          className="web-range web-range-end"
          type="range"
          min="0"
          max={safeDuration}
          step="0.01"
          value={endTime}
          disabled={disabled}
          aria-label="Trim end"
          onChange={(event) => {
            const next = Number(event.target.value);
            onEndChange(
              clamp(next, Math.min(safeDuration, startTime + MIN_TRIM_GAP), safeDuration)
            );
          }}
        />
      </div>

      <div className="web-timeline-labels" aria-hidden="true">
        <span>0:00</span>
        <span>{formatClock(duration)}</span>
      </div>
    </section>
  );
}

export default memo(WebTrimTimeline);
