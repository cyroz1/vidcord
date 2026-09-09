import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  formatTimelineTime,
  getSelectionCenter,
  getTimelineViewBounds,
  parseTimelineTimeInput,
  TIMELINE_ZOOM_MAX,
} from "../timelineZoom";

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

type TrimIconName =
  | "mark-in"
  | "mark-out"
  | "minus"
  | "plus"
  | "undo"
  | "redo"
  | "loop"
  | "snap"
  | "more";

const TRIM_ICON_PATHS: Record<
  Exclude<TrimIconName, "mark-in" | "mark-out" | "snap">,
  readonly string[]
> = {
  minus: ["M4 8h8"],
  plus: ["M8 4v8", "M4 8h8"],
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

  if (name === "snap") {
    return (
      <svg
        className="web-trim-icon"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <g transform="rotate(-18 8 8)">
          <path
            d="M2.5 2h4v5.4a1.5 1.5 0 0 0 3 0V2h4v5.4a5.5 5.5 0 0 1-11 0V2Z"
            fill="currentColor"
            opacity="0.58"
          />
          <path d="M2.5 2h4v2.5h-4zM9.5 2h4v2.5h-4z" fill="currentColor" />
          <path d="M2.5 4.5h4M9.5 4.5h4" stroke="var(--web-surface-solid)" strokeWidth="0.8" />
        </g>
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
  onFinish: () => void;
};

const TimelineTimeInput = memo(function TimelineTimeInput({
  side,
  time,
  clockFormat,
  disabled,
  onFocus,
  onCommit,
  onFinish,
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
          onFinish();
          return;
        }
        const parsed = parseTimelineTimeInput(event.currentTarget.value);
        if (parsed !== null) onCommit(parsed);
        setDraft(null);
        onFinish();
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
  const [snapMode, setSnapMode] = useState<"off" | "0.1" | "0.5" | "1.0">("off");
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [timelineCenter, setTimelineCenter] = useState(0);
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
  const boundsRef = useRef({ start: safeStart, end: safeEnd, duration: safeDuration });
  const selectedDuration = Math.max(0, safeEnd - safeStart);
  const selectedDurationPct = duration > 0 ? (selectedDuration / duration) * 100 : 0;
  const timelineView = getTimelineViewBounds(
    timelineCenter,
    timelineZoom,
    safeDuration,
    MIN_TRIM_GAP
  );
  const viewStart = timelineView.start;
  const viewEnd = timelineView.end;
  const viewSpan = Math.max(viewEnd - viewStart, MIN_TRIM_GAP);
  const toViewPercent = (value: number) => clamp(((value - viewStart) / viewSpan) * 100, 0, 100);
  const startPercent = toViewPercent(safeStart);
  const endPercent = toViewPercent(safeEnd);
  const playheadPercent = toViewPercent(currentTime);
  const startHandleInView = safeStart >= viewStart && safeStart <= viewEnd;
  const endHandleInView = safeEnd >= viewStart && safeEnd <= viewEnd;
  const trimReady = !disabled && duration > 0;
  const canSetInPoint = trimReady && currentTime < safeEnd - MIN_TRIM_GAP;
  const canSetOutPoint = trimReady && currentTime > safeStart + MIN_TRIM_GAP;
  const canUndoTrim = trimReady && historyRef.current.past.length > 0;
  const canRedoTrim = trimReady && historyRef.current.future.length > 0;

  useEffect(() => {
    rangeRef.current = { start: safeStart, end: safeEnd };
    boundsRef.current = { start: safeStart, end: safeEnd, duration: safeDuration };
  }, [safeDuration, safeEnd, safeStart]);

  useEffect(() => {
    const { start, end, duration: currentDuration } = boundsRef.current;
    historyRef.current = { past: [], future: [] };
    setTimelineZoom(1);
    setTimelineCenter(getSelectionCenter(start, end, currentDuration));
    interactionStartRef.current = null;
    setHistoryRevision((value) => value + 1);
  }, [historyKey]);

  useEffect(() => {
    setTimelineCenter((center) => clamp(center, 0, safeDuration));
  }, [safeDuration]);

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
    (
      nextRange: TrimRange,
      playheadTime?: number,
      recordHistory = true,
      anchor: "start" | "end" = "start"
    ) => {
      const snapSeconds = losslessTrim || snapMode === "off" ? 0 : Number(snapMode);
      const snapTime = (value: number) =>
        snapSeconds > 0 ? Math.round(value / snapSeconds) * snapSeconds : value;
      let start = clamp(snapTime(nextRange.start), 0, safeDuration);
      let end = clamp(snapTime(nextRange.end), 0, safeDuration);
      if (end - start < MIN_TRIM_GAP) {
        if (anchor === "end") {
          start = Math.max(0, end - MIN_TRIM_GAP);
        } else {
          end = Math.min(safeDuration, start + MIN_TRIM_GAP);
          if (end - start < MIN_TRIM_GAP) start = Math.max(0, end - MIN_TRIM_GAP);
        }
      }
      const normalized = { start, end };
      const previous = rangeRef.current;
      if (sameRange(previous, normalized)) {
        if (typeof playheadTime === "number") onSeek(playheadTime);
        return;
      }
      if (recordHistory) pushHistory(previous);
      rangeRef.current = normalized;
      onRangeChange(normalized.start, normalized.end, playheadTime);
    },
    [losslessTrim, onRangeChange, onSeek, pushHistory, safeDuration, snapMode]
  );

  const handleStartChange = useCallback(
    (value: number) => {
      beginInteraction();
      const nextStart = clamp(value, 0, Math.max(0, safeEnd - MIN_TRIM_GAP));
      applyRange({ start: nextStart, end: safeEnd }, nextStart, false, "start");
    },
    [applyRange, beginInteraction, safeEnd]
  );

  const handleEndChange = useCallback(
    (value: number) => {
      beginInteraction();
      const nextEnd = clamp(value, Math.min(safeDuration, safeStart + MIN_TRIM_GAP), safeDuration);
      applyRange({ start: safeStart, end: nextEnd }, nextEnd, false, "end");
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
          false,
          "start"
        );
      } else {
        applyRange(
          { start: safeStart, end: Math.max(nextValue, safeStart + MIN_TRIM_GAP) },
          nextValue,
          false,
          "end"
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
    if (!trimReady) return;
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
  }, [bumpHistory, onRangeChange, trimReady]);

  const redoTrim = useCallback(() => {
    if (!trimReady) return;
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
  }, [bumpHistory, onRangeChange, trimReady]);

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const bounds = trackRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0) return;
      const fraction = clamp((clientX - bounds.left) / bounds.width, 0, 1);
      onSeek(clamp(viewStart + fraction * viewSpan, 0, safeDuration));
    },
    [onSeek, safeDuration, viewSpan, viewStart]
  );

  const centerTimelineOnSelection = useCallback(() => {
    setTimelineCenter(getSelectionCenter(safeStart, safeEnd, safeDuration));
  }, [safeDuration, safeEnd, safeStart]);

  const zoomTimelineOut = useCallback(() => {
    centerTimelineOnSelection();
    setTimelineZoom((value) => Math.max(1, value / 1.25));
  }, [centerTimelineOnSelection]);

  const resetTimelineZoom = useCallback(() => {
    setTimelineZoom(1);
    centerTimelineOnSelection();
  }, [centerTimelineOnSelection]);

  const zoomTimelineIn = useCallback(() => {
    centerTimelineOnSelection();
    setTimelineZoom((value) => Math.min(TIMELINE_ZOOM_MAX, value * 1.25));
  }, [centerTimelineOnSelection]);

  const handleTimelineWheel = useCallback(
    (event: WheelEvent) => {
      if (!trimReady || (!event.ctrlKey && !event.metaKey && timelineZoom <= 1)) return;
      event.preventDefault();
      const bounds = trackRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0) return;

      if (event.ctrlKey || event.metaKey) {
        const fraction = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
        const focusTime = viewStart + fraction * viewSpan;
        const nextZoom = Math.max(
          1,
          Math.min(TIMELINE_ZOOM_MAX, timelineZoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15))
        );
        const nextView = getTimelineViewBounds(focusTime, nextZoom, safeDuration, MIN_TRIM_GAP);
        const nextSpan = nextView.end - nextView.start;
        const nextStart = clamp(
          focusTime - fraction * nextSpan,
          0,
          Math.max(0, safeDuration - nextSpan)
        );
        setTimelineZoom(nextZoom);
        setTimelineCenter(nextStart + nextSpan / 2);
        return;
      }

      const panStep = viewSpan * 0.08;
      const direction = event.deltaX !== 0 ? event.deltaX : event.deltaY;
      setTimelineCenter((center) =>
        clamp(center + (direction > 0 ? panStep : -panStep), 0, safeDuration)
      );
    },
    [safeDuration, timelineZoom, trimReady, viewSpan, viewStart]
  );

  useEffect(() => {
    const track = trackRef.current;
    // React's root wheel listener is passive and cannot suppress page zoom.
    track?.addEventListener("wheel", handleTimelineWheel, { passive: false });
    return () => track?.removeEventListener("wheel", handleTimelineWheel);
  }, [handleTimelineWheel]);

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
      tabIndex={0}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          !trimReady ||
          (event.target instanceof HTMLElement &&
            event.target.closest("input, textarea, select, [contenteditable=true]"))
        )
          return;
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && key === "z") {
          event.preventDefault();
          if (event.shiftKey) redoTrim();
          else undoTrim();
        } else if (
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          (key === "i" || key === "o")
        ) {
          event.preventDefault();
          if (key === "i") setInPoint();
          else setOutPoint();
        }
      }}
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
            title="Set in point to playhead"
          >
            <TrimIcon name="mark-in" />
            <span>In</span>
          </button>
          <button
            type="button"
            className="web-trim-mini-btn web-trim-labeled-btn"
            onClick={setOutPoint}
            disabled={!canSetOutPoint}
            title="Set out point to playhead"
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
              title="Undo trim"
              disabled={!canUndoTrim}
            >
              <TrimIcon name="undo" />
            </button>
            <button
              type="button"
              className="web-trim-mini-btn web-trim-icon-btn"
              onClick={redoTrim}
              aria-label="Redo trim"
              title="Redo trim"
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
              {!losslessTrim && (
                <div className="web-trim-option-row">
                  <span>
                    <TrimIcon name="snap" />
                    Snap
                  </span>
                  <select
                    value={snapMode}
                    aria-label="Timeline snap interval"
                    disabled={!trimReady}
                    onChange={(event) =>
                      setSnapMode(event.target.value as "off" | "0.1" | "0.5" | "1.0")
                    }
                  >
                    <option value="off">Off</option>
                    <option value="0.1">0.1s</option>
                    <option value="0.5">0.5s</option>
                    <option value="1.0">1.0s</option>
                  </select>
                </div>
              )}
              <div className="web-trim-option-row">
                <span>Timeline zoom</span>
                <div
                  className="web-trim-control-group web-trim-zoom-controls"
                  role="group"
                  aria-label="Timeline zoom"
                >
                  <button
                    type="button"
                    className="web-trim-mini-btn web-trim-icon-btn"
                    onClick={zoomTimelineOut}
                    aria-label="Zoom timeline out"
                    title="Zoom out"
                    disabled={!trimReady || timelineZoom <= 1.0001}
                  >
                    <TrimIcon name="minus" />
                  </button>
                  <button
                    type="button"
                    className="web-trim-mini-btn web-trim-zoom-value"
                    onClick={resetTimelineZoom}
                    aria-label="Reset timeline zoom to 1x"
                    title="Reset timeline zoom"
                    disabled={!trimReady || timelineZoom <= 1.0001}
                  >
                    {timelineZoom.toFixed(1)}x
                  </button>
                  <button
                    type="button"
                    className="web-trim-mini-btn web-trim-icon-btn"
                    onClick={zoomTimelineIn}
                    aria-label="Zoom timeline in"
                    title="Zoom in"
                    disabled={!trimReady || timelineZoom >= TIMELINE_ZOOM_MAX - 0.0001}
                  >
                    <TrimIcon name="plus" />
                  </button>
                </div>
              </div>
              <p className="web-trim-option-note">Scroll to pan; Ctrl/⌘+scroll to zoom.</p>
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
            onCommit={(value) => commitTime("start", value)}
            onFinish={finishInteraction}
          />
        ) : (
          <span
            className={`web-time-label web-time-label-left${clockTimeFormat ? " clock-format" : ""}`}
          >
            {formatTimelineTime(safeStart, clockTimeFormat)}
          </span>
        )}

        <div
          ref={trackRef}
          className={`web-trim-dual-wrap${trimReady ? "" : " disabled"}`}
          title={trimReady ? "Click to seek | Wheel to pan | Ctrl/⌘+Wheel to zoom" : undefined}
        >
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
            hidden={!duration || currentTime < viewStart || currentTime > viewEnd}
          >
            <div
              className="web-trim-playhead"
              onPointerDown={handlePlayheadPointerDown}
              onPointerMove={handlePlayheadPointerMove}
              onPointerUp={handlePlayheadPointerUp}
              onPointerCancel={handlePlayheadPointerUp}
            />
          </div>
          {startHandleInView && (
            <input
              className="web-trim-handle web-trim-start-handle"
              type="range"
              min={viewStart}
              max={viewEnd}
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
              onKeyUp={finishInteraction}
              onBlur={finishInteraction}
              onChange={(event) => handleStartChange(Number(event.target.value))}
            />
          )}
          {endHandleInView && (
            <input
              className="web-trim-handle web-trim-end-handle"
              type="range"
              min={viewStart}
              max={viewEnd}
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
              onKeyUp={finishInteraction}
              onBlur={finishInteraction}
              onChange={(event) => handleEndChange(Number(event.target.value))}
            />
          )}
        </div>

        {editableTimes ? (
          <TimelineTimeInput
            side="end"
            time={safeEnd}
            clockFormat={clockTimeFormat}
            disabled={!trimReady}
            onFocus={beginInteraction}
            onCommit={(value) => commitTime("end", value)}
            onFinish={finishInteraction}
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
