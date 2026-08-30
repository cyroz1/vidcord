import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { formatTimelineTime, parseTimelineTimeInput } from "../timelineZoom";

type TrimRange = { start: number; end: number };

type Props = {
  duration: number;
  startTime: number;
  endTime: number;
  currentTime: number;
  disabled?: boolean;
  editableTimes: boolean;
  losslessTrim: boolean;
  losslessInfoLoading: boolean;
  losslessInfoError: string | null;
  historyKey: string;
  loopPlayback: boolean;
  onLoopPlaybackChange: (enabled: boolean) => void;
  onRangeChange: (start: number, end: number, playheadTime?: number) => void;
  onSeek: (value: number) => void;
};

const MIN_TRIM_GAP = 0.1;
const MAX_HISTORY = 50;

type TrimIconName = "mark-in" | "mark-out" | "undo" | "redo" | "loop" | "more";

const TRIM_ICON_PATHS: Record<Exclude<TrimIconName, "mark-in" | "mark-out">, readonly string[]> = {
  undo: ["M6 5H3V2", "M3.2 5A5.5 5.5 0 1 1 4.5 11.5"],
  redo: ["M10 5h3V2", "M12.8 5A5.5 5.5 0 1 0 11.5 11.5"],
  loop: ["M3 6a3 3 0 0 1 3-3h6", "M10 1l2 2-2 2", "M13 10a3 3 0 0 1-3 3H4", "M6 11l-2 2 2 2"],
  more: ["M4 8h.01M8 8h.01M12 8h.01"],
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function sameRange(left: TrimRange, right: TrimRange): boolean {
  return Math.abs(left.start - right.start) <= 0.0005 && Math.abs(left.end - right.end) <= 0.0005;
}

function TrimIcon({ name }: { name: TrimIconName }) {
  if (name === "mark-in" || name === "mark-out") {
    return (
      <svg
        className="web-trim-icon"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        {name === "mark-in" ? (
          <>
            <path d="M5 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path
              d="M12 5 8 8l4 3"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            <path d="M11 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path
              d="M4 5l4 3-4 3"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
      </svg>
    );
  }

  return (
    <svg
      className="web-trim-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      {TRIM_ICON_PATHS[name].map((path) => (
        <path
          key={path}
          d={path}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

type TimelineTimeInputProps = {
  side: "start" | "end";
  time: number;
  clockFormat: boolean;
  disabled: boolean;
  onFocus: () => void;
  onCommit: (time: number) => void;
};

const TimelineTimeInput = memo(function TimelineTimeInput({
  side,
  time,
  clockFormat,
  disabled,
  onFocus,
  onCommit,
}: TimelineTimeInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelCommitRef = useRef(false);
  const displayValue = draft ?? formatTimelineTime(time, clockFormat);

  return (
    <input
      type="text"
      className={`web-time-label web-time-label-input web-time-label-${side}`}
      value={displayValue}
      disabled={disabled}
      inputMode="decimal"
      aria-label={`Trim ${side} time`}
      title="Enter seconds or h:m:s; press Enter to apply"
      onFocus={(event) => {
        onFocus();
        setDraft(event.currentTarget.value);
        event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        if (cancelCommitRef.current) {
          cancelCommitRef.current = false;
          setDraft(null);
          return;
        }
        const parsed = parseTimelineTimeInput(event.currentTarget.value);
        if (parsed !== null) onCommit(parsed);
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelCommitRef.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
});

function WebTrimTimeline({
  duration,
  startTime,
  endTime,
  currentTime,
  disabled = false,
  editableTimes,
  losslessTrim,
  losslessInfoLoading,
  losslessInfoError,
  historyKey,
  loopPlayback,
  onLoopPlaybackChange,
  onRangeChange,
  onSeek,
}: Props) {
  const [trimOptionsOpen, setTrimOptionsOpen] = useState(false);
  const [clockTimeFormat, setClockTimeFormat] = useState(false);
  const [, setHistoryRevision] = useState(0);
  const historyRef = useRef<{ past: TrimRange[]; future: TrimRange[] }>({
    past: [],
    future: [],
  });
  const rangeRef = useRef<TrimRange>({ start: startTime, end: endTime });
  const interactionStartRef = useRef<TrimRange | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const optionsButtonRef = useRef<HTMLButtonElement>(null);

  const hasDuration = duration > 0;
  const safeDuration = hasDuration ? duration : 0.1;
  const safeStart = hasDuration ? clamp(startTime, 0, safeDuration) : 0;
  const safeEnd = hasDuration ? clamp(Math.max(endTime, safeStart), safeStart, safeDuration) : 0;
  const selectedDuration = Math.max(0, safeEnd - safeStart);
  const selectedDurationPct = duration > 0 ? (selectedDuration / duration) * 100 : 0;
  const startPercent = (safeStart / safeDuration) * 100;
  const endPercent = (safeEnd / safeDuration) * 100;
  const playheadPercent = clamp((currentTime / safeDuration) * 100, 0, 100);
  const trimReady = !disabled && duration > 0;
  const canSetInPoint = trimReady && currentTime < safeEnd - MIN_TRIM_GAP;
  const canSetOutPoint = trimReady && currentTime > safeStart + MIN_TRIM_GAP;
  const canUndoTrim = historyRef.current.past.length > 0;
  const canRedoTrim = historyRef.current.future.length > 0;

  useEffect(() => {
    rangeRef.current = { start: safeStart, end: safeEnd };
  }, [safeEnd, safeStart]);

  useEffect(() => {
    historyRef.current = { past: [], future: [] };
    interactionStartRef.current = null;
    setHistoryRevision((value) => value + 1);
  }, [historyKey]);

  useEffect(() => {
    const handleShortcutKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target instanceof HTMLInputElement) return;
      if (event.key === "?") {
        event.preventDefault();
        setTrimOptionsOpen((open) => {
          const next = !open;
          if (next) window.requestAnimationFrame(() => optionsButtonRef.current?.focus());
          return next;
        });
      } else if (event.key === "Escape" && trimOptionsOpen) {
        event.preventDefault();
        setTrimOptionsOpen(false);
      }
    };

    window.addEventListener("keydown", handleShortcutKey);
    return () => window.removeEventListener("keydown", handleShortcutKey);
  }, [trimOptionsOpen]);

  const bumpHistory = useCallback(() => {
    setHistoryRevision((value) => value + 1);
  }, []);

  const pushHistory = useCallback(
    (range: TrimRange) => {
      historyRef.current = {
        past: [...historyRef.current.past, range].slice(-MAX_HISTORY),
        future: [],
      };
      bumpHistory();
    },
    [bumpHistory]
  );

  const beginInteraction = useCallback(() => {
    if (!interactionStartRef.current) interactionStartRef.current = rangeRef.current;
  }, []);

  const finishInteraction = useCallback(() => {
    const initialRange = interactionStartRef.current;
    interactionStartRef.current = null;
    if (initialRange && !sameRange(initialRange, rangeRef.current)) pushHistory(initialRange);
  }, [pushHistory]);

  const applyRange = useCallback(
    (nextRange: TrimRange, playheadTime?: number, recordHistory = true) => {
      const normalized = {
        start: clamp(nextRange.start, 0, safeDuration),
        end: clamp(Math.max(nextRange.end, nextRange.start), nextRange.start, safeDuration),
      };
      const previous = rangeRef.current;
      if (sameRange(previous, normalized)) {
        if (typeof playheadTime === "number") onSeek(playheadTime);
        return;
      }
      if (recordHistory) pushHistory(previous);
      rangeRef.current = normalized;
      onRangeChange(normalized.start, normalized.end, playheadTime);
    },
    [onRangeChange, onSeek, pushHistory, safeDuration]
  );

  const handleStartChange = useCallback(
    (value: number) => {
      beginInteraction();
      const nextStart = clamp(value, 0, Math.max(0, safeEnd - MIN_TRIM_GAP));
      applyRange({ start: nextStart, end: safeEnd }, nextStart, false);
    },
    [applyRange, beginInteraction, safeEnd]
  );

  const handleEndChange = useCallback(
    (value: number) => {
      beginInteraction();
      const nextEnd = clamp(value, Math.min(safeDuration, safeStart + MIN_TRIM_GAP), safeDuration);
      applyRange({ start: safeStart, end: nextEnd }, nextEnd, false);
    },
    [applyRange, beginInteraction, safeDuration, safeStart]
  );

  const commitTime = useCallback(
    (side: "start" | "end", value: number) => {
      const nextValue = clamp(value, 0, safeDuration);
      if (side === "start") {
        applyRange(
          { start: Math.min(nextValue, safeEnd - MIN_TRIM_GAP), end: safeEnd },
          nextValue,
          false
        );
      } else {
        applyRange(
          { start: safeStart, end: Math.max(nextValue, safeStart + MIN_TRIM_GAP) },
          nextValue,
          false
        );
      }
    },
    [applyRange, safeDuration, safeEnd, safeStart]
  );

  const setInPoint = useCallback(() => {
    if (!canSetInPoint) return;
    const nextStart = clamp(currentTime, 0, safeEnd - MIN_TRIM_GAP);
    applyRange({ start: nextStart, end: safeEnd }, nextStart);
  }, [applyRange, canSetInPoint, currentTime, safeEnd]);

  const setOutPoint = useCallback(() => {
    if (!canSetOutPoint) return;
    const nextEnd = clamp(currentTime, safeStart + MIN_TRIM_GAP, safeDuration);
    applyRange({ start: safeStart, end: nextEnd }, nextEnd);
  }, [applyRange, canSetOutPoint, currentTime, safeDuration, safeStart]);

  const undoTrim = useCallback(() => {
    const previous = historyRef.current.past[historyRef.current.past.length - 1];
    if (!previous) return;
    const current = rangeRef.current;
    historyRef.current = {
      past: historyRef.current.past.slice(0, -1),
      future: [...historyRef.current.future, current].slice(-MAX_HISTORY),
    };
    rangeRef.current = previous;
    bumpHistory();
    onRangeChange(previous.start, previous.end, previous.start);
  }, [bumpHistory, onRangeChange]);

  const redoTrim = useCallback(() => {
    const next = historyRef.current.future[historyRef.current.future.length - 1];
    if (!next) return;
    const current = rangeRef.current;
    historyRef.current = {
      past: [...historyRef.current.past, current].slice(-MAX_HISTORY),
      future: historyRef.current.future.slice(0, -1),
    };
    rangeRef.current = next;
    bumpHistory();
    onRangeChange(next.start, next.end, next.start);
  }, [bumpHistory, onRangeChange]);

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const bounds = trackRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0) return;
      onSeek(clamp(((clientX - bounds.left) / bounds.width) * safeDuration, 0, safeDuration));
    },
    [onSeek, safeDuration]
  );

  const handlePlayheadPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!trimReady) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      seekFromPointer(event.clientX);
    },
    [seekFromPointer, trimReady]
  );

  const handlePlayheadPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromPointer(event.clientX);
    },
    [seekFromPointer]
  );

  const handlePlayheadPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <section
      className={`web-timeline${trimOptionsOpen ? " options-open" : ""}`}
      aria-labelledby="web-timeline-title"
    >
      <div className="web-trim-heading-row">
        <div className="web-trim-heading-copy">
          <span className="web-section-label">Trim Video</span>
          <span className="web-trim-selection-meta" id="web-timeline-title">
            {selectedDuration.toFixed(1)} sec · {selectedDurationPct.toFixed(1)}%
          </span>
          {losslessTrim && (
            <span
              className="web-trim-lossless-status"
              role={losslessInfoError ? "alert" : "status"}
              title={
                losslessInfoError ??
                "Lossless Trim is less precise: boundaries snap outward to source keyframes."
              }
            >
              {losslessInfoLoading
                ? "Finding keyframes…"
                : losslessInfoError
                  ? "Unavailable"
                  : "Keyframe aligned"}
            </span>
          )}
        </div>
      </div>

      <div className="web-trim-toolbar" role="toolbar" aria-label="Trim editing controls">
        <div className="web-trim-control-group" role="group" aria-label="Set trim points">
          <button
            type="button"
            className="web-trim-mini-btn web-trim-labeled-btn"
            onClick={setInPoint}
            disabled={!canSetInPoint}
            title="Set in point to playhead (I)"
          >
            <TrimIcon name="mark-in" />
            <span>In</span>
          </button>
          <button
            type="button"
            className="web-trim-mini-btn web-trim-labeled-btn"
            onClick={setOutPoint}
            disabled={!canSetOutPoint}
            title="Set out point to playhead (O)"
          >
            <TrimIcon name="mark-out" />
            <span>Out</span>
          </button>
        </div>

        <div className="web-trim-toolbar-actions">
          <div className="web-trim-control-group" role="group" aria-label="Trim history">
            <button
              type="button"
              className="web-trim-mini-btn web-trim-icon-btn"
              onClick={undoTrim}
              aria-label="Undo trim"
              title="Undo trim (Cmd/Ctrl+Z)"
              disabled={!canUndoTrim}
            >
              <TrimIcon name="undo" />
            </button>
            <button
              type="button"
              className="web-trim-mini-btn web-trim-icon-btn"
              onClick={redoTrim}
              aria-label="Redo trim"
              title="Redo trim (Cmd/Ctrl+Shift+Z)"
              disabled={!canRedoTrim}
            >
              <TrimIcon name="redo" />
            </button>
          </div>

          <button
            type="button"
            className={`web-trim-loop-toggle${loopPlayback ? " active" : ""}`}
            aria-label="Loop trim playback"
            aria-pressed={loopPlayback}
            title="Loop trim playback"
            disabled={!trimReady}
            onClick={() => onLoopPlaybackChange(!loopPlayback)}
          >
            <TrimIcon name="loop" />
          </button>

          <div
            className="web-trim-options-popover"
            onBlurCapture={(event) => {
              const nextTarget = event.relatedTarget;
              if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
              setTrimOptionsOpen(false);
            }}
          >
            <button
              ref={optionsButtonRef}
              type="button"
              className="web-trim-mini-btn web-trim-icon-btn"
              aria-label="More trim options"
              aria-haspopup="dialog"
              aria-controls="web-trim-options-panel"
              aria-expanded={trimOptionsOpen}
              title="More trim options"
              onClick={() => setTrimOptionsOpen((open) => !open)}
            >
              <TrimIcon name="more" />
            </button>
            <div
              id="web-trim-options-panel"
              className="web-trim-options-panel"
              role="dialog"
              aria-label="More trim options"
              hidden={!trimOptionsOpen}
            >
              <div className="web-trim-option-row">
                <span>Time labels</span>
                <button
                  type="button"
                  className={`web-trim-time-format-toggle${clockTimeFormat ? " active" : ""}`}
                  aria-label="Show timeline times as hours, minutes, and seconds"
                  aria-pressed={clockTimeFormat}
                  onClick={() => setClockTimeFormat((enabled) => !enabled)}
                >
                  {clockTimeFormat ? "h:m:s" : "seconds"}
                </button>
              </div>
              <p className="web-trim-option-note">Browser trim uses the source timeline.</p>
            </div>
          </div>
        </div>
      </div>

      <div className="web-slider-row web-trim-dual-row">
        {editableTimes ? (
          <TimelineTimeInput
            side="start"
            time={safeStart}
            clockFormat={clockTimeFormat}
            disabled={!trimReady}
            onFocus={beginInteraction}
            onCommit={(value) => {
              commitTime("start", value);
              finishInteraction();
            }}
          />
        ) : (
          <span
            className={`web-time-label web-time-label-left${clockTimeFormat ? " clock-format" : ""}`}
          >
            {formatTimelineTime(safeStart, clockTimeFormat)}
          </span>
        )}

        <div ref={trackRef} className={`web-trim-dual-wrap${trimReady ? "" : " disabled"}`}>
          <button
            className="web-trim-click-target"
            type="button"
            aria-label="Seek video timeline"
            disabled={!trimReady}
            onClick={(event) => seekFromPointer(event.clientX)}
          />
          <div className="web-trim-dual-track" />
          <div
            className="web-trim-dual-range"
            style={{
              transform: `translateX(${startPercent}%) scaleX(${Math.max(endPercent - startPercent, 0) / 100})`,
            }}
            aria-hidden="true"
          />
          <div
            className="web-trim-playhead-position"
            style={{ transform: `translateX(${playheadPercent}%)` }}
            hidden={!duration}
          >
            <div
              className="web-trim-playhead"
              onPointerDown={handlePlayheadPointerDown}
              onPointerMove={handlePlayheadPointerMove}
              onPointerUp={handlePlayheadPointerUp}
              onPointerCancel={handlePlayheadPointerUp}
            />
          </div>
          <input
            className="web-trim-handle web-trim-start-handle"
            type="range"
            min="0"
            max={safeDuration}
            step="0.01"
            value={safeStart}
            disabled={!trimReady}
            aria-label="Trim start"
            onFocus={beginInteraction}
            onPointerDown={() => {
              beginInteraction();
              onSeek(safeStart);
            }}
            onPointerUp={finishInteraction}
            onPointerCancel={finishInteraction}
            onChange={(event) => handleStartChange(Number(event.target.value))}
          />
          <input
            className="web-trim-handle web-trim-end-handle"
            type="range"
            min="0"
            max={safeDuration}
            step="0.01"
            value={safeEnd}
            disabled={!trimReady}
            aria-label="Trim end"
            onFocus={beginInteraction}
            onPointerDown={() => {
              beginInteraction();
              onSeek(safeEnd);
            }}
            onPointerUp={finishInteraction}
            onPointerCancel={finishInteraction}
            onChange={(event) => handleEndChange(Number(event.target.value))}
          />
        </div>

        {editableTimes ? (
          <TimelineTimeInput
            side="end"
            time={safeEnd}
            clockFormat={clockTimeFormat}
            disabled={!trimReady}
            onFocus={beginInteraction}
            onCommit={(value) => {
              commitTime("end", value);
              finishInteraction();
            }}
          />
        ) : (
          <span
            className={`web-time-label web-time-label-right${clockTimeFormat ? " clock-format" : ""}`}
          >
            {formatTimelineTime(safeEnd, clockTimeFormat)}
          </span>
        )}
      </div>
    </section>
  );
}

export default memo(WebTrimTimeline);
