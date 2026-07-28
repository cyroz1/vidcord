import {
  memo,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
  type WheelEvent,
} from "react";
import { formatTimelineTime, parseTimelineTimeInput, TIMELINE_ZOOM_MAX } from "../timelineZoom";

export type SnapMode = "off" | "0.1" | "0.5" | "1.0";

const TRIM_RANGE_MAX = 10000;

type Props = {
  selectedDuration: number;
  selectedDurationPct: number;
  editableTimes: boolean;
  losslessTrim: boolean;
  losslessInfoLoading: boolean;
  losslessInfoError: string | null;
  trimReady: boolean;
  canSetInPoint: boolean;
  canSetOutPoint: boolean;
  canUndoTrim: boolean;
  canRedoTrim: boolean;
  snapMode: SnapMode;
  timelineZoom: number;
  trimWrapRef: RefObject<HTMLDivElement>;
  startTime: number;
  endTime: number;
  viewStartVal: number;
  viewEndVal: number;
  startVal: number;
  endVal: number;
  startPct: number;
  endPct: number;
  trimPlayheadRef: RefObject<HTMLDivElement>;
  onSetInPoint: () => void;
  onSetOutPoint: () => void;
  onSnapModeChange: (mode: SnapMode) => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onZoomIn: () => void;
  onUndoTrim: () => void;
  onRedoTrim: () => void;
  loopPlayback: boolean;
  onLoopPlaybackChange: (enabled: boolean) => void;
  onTrimWheel: (event: WheelEvent<HTMLDivElement>) => void;
  onTimelineClick: (event: MouseEvent<HTMLDivElement>) => void;
  onRangeDragStart: (event: MouseEvent<HTMLDivElement>) => void;
  onPlayheadDragStart: (event: MouseEvent<HTMLDivElement>) => void;
  onStartHandlePointerDown: () => void;
  onEndHandlePointerDown: () => void;
  onStartHandleFocus: () => void;
  onEndHandleFocus: () => void;
  onPointerUp: () => void;
  onStartChange: (value: number) => void;
  onEndChange: (value: number) => void;
  onStartTimeCommit: (time: number) => void;
  onEndTimeCommit: (time: number) => void;
};

type TrimIconName =
  | "mark-in"
  | "mark-out"
  | "minus"
  | "plus"
  | "undo"
  | "redo"
  | "loop"
  | "snap"
  | "help";

type StrokedTrimIconName = Exclude<TrimIconName, "snap">;

const TRIM_ICON_PATHS: Record<StrokedTrimIconName, readonly string[]> = {
  "mark-in": ["M5 3v10", "M12 5 8 8l4 3"],
  "mark-out": ["M11 3v10", "M4 5l4 3-4 3"],
  minus: ["M4 8h8"],
  plus: ["M8 4v8", "M4 8h8"],
  undo: ["M6 5H3V2", "M3.2 5A5.5 5.5 0 1 1 4.5 11.5"],
  redo: ["M10 5h3V2", "M12.8 5A5.5 5.5 0 1 0 11.5 11.5"],
  loop: ["M3 6a3 3 0 0 1 3-3h6", "M10 1l2 2-2 2", "M13 10a3 3 0 0 1-3 3H4", "M6 11l-2 2 2 2"],
  help: ["M6.4 6a1.7 1.7 0 1 1 2.45 1.53C8.2 7.86 8 8.15 8 9", "M8 11.8h.01"],
};

const initialPlayheadPositionStyle = { transform: "translateX(0%)" };

const TrimPlayheadPosition = memo(function TrimPlayheadPosition({
  elementRef,
  onMouseDown,
}: {
  elementRef: RefObject<HTMLDivElement>;
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      ref={elementRef}
      className="trim-playhead-position"
      style={initialPlayheadPositionStyle}
      hidden
    >
      <div className="trim-playhead" onMouseDown={onMouseDown} />
    </div>
  );
});

function TrimIcon({ name }: { name: TrimIconName }) {
  if (name === "snap") {
    return (
      <svg
        className="trim-icon"
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
          <path d="M2.5 4.5h4M9.5 4.5h4" stroke="var(--surface)" strokeWidth="0.8" />
        </g>
      </svg>
    );
  }

  return (
    <svg
      className="trim-icon"
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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
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
      className={`time-label time-label-input time-label-${side}`}
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
      onChange={(event) => setDraft(event.currentTarget.value)}
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

function TrimTimeline({
  selectedDuration,
  selectedDurationPct,
  editableTimes,
  losslessTrim,
  losslessInfoLoading,
  losslessInfoError,
  trimReady,
  canSetInPoint,
  canSetOutPoint,
  canUndoTrim,
  canRedoTrim,
  snapMode,
  timelineZoom,
  trimWrapRef,
  startTime,
  endTime,
  viewStartVal,
  viewEndVal,
  startVal,
  endVal,
  startPct,
  endPct,
  trimPlayheadRef,
  onSetInPoint,
  onSetOutPoint,
  onSnapModeChange,
  onZoomOut,
  onZoomReset,
  onZoomIn,
  onUndoTrim,
  onRedoTrim,
  loopPlayback,
  onLoopPlaybackChange,
  onTrimWheel,
  onTimelineClick,
  onRangeDragStart,
  onPlayheadDragStart,
  onStartHandlePointerDown,
  onEndHandlePointerDown,
  onStartHandleFocus,
  onEndHandleFocus,
  onPointerUp,
  onStartChange,
  onEndChange,
  onStartTimeCommit,
  onEndTimeCommit,
}: Props) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [clockTimeFormat, setClockTimeFormat] = useState(false);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const helpPointerDownRef = useRef(false);
  const canZoomOut = trimReady && timelineZoom > 1.0001;
  const canZoomIn = trimReady && timelineZoom < TIMELINE_ZOOM_MAX - 0.0001;
  const visibleRangeMin = Math.max(0, Math.ceil(viewStartVal));
  const visibleRangeMax = Math.min(TRIM_RANGE_MAX, Math.floor(viewEndVal));
  const startHandleInView = startVal >= visibleRangeMin && startVal <= visibleRangeMax;
  const endHandleInView = endVal >= visibleRangeMin && endVal <= visibleRangeMax;

  useEffect(() => {
    const handleShortcutKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        isEditableTarget(event.target) ||
        helpButtonRef.current?.closest("[inert]")
      ) {
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen((open) => {
          const next = !open;
          if (next) {
            window.requestAnimationFrame(() => helpButtonRef.current?.focus());
          }
          return next;
        });
        return;
      }

      if (event.key === "Escape" && shortcutsOpen) {
        event.preventDefault();
        setShortcutsOpen(false);
      }
    };

    window.addEventListener("keydown", handleShortcutKey);
    return () => window.removeEventListener("keydown", handleShortcutKey);
  }, [shortcutsOpen]);

  return (
    <div className={`trim-section${shortcutsOpen ? " shortcuts-open" : ""}`}>
      <div className="trim-heading-row">
        <div className="trim-heading-copy">
          <span className="section-title">Trim Video</span>
          <span className="trim-selection-meta">
            {selectedDuration.toFixed(2)}s selected ({selectedDurationPct.toFixed(1)}%)
          </span>
          {losslessTrim && (
            <span
              className="trim-lossless-status"
              role={losslessInfoError ? "alert" : "status"}
              title={
                losslessInfoError ??
                "Lossless Trim is less precise: boundaries snap outward to source keyframes."
              }
            >
              {losslessInfoLoading
                ? "Finding keyframes…"
                : losslessInfoError
                  ? "Lossless trim unavailable"
                  : "Lossless · less precise · keyframe aligned"}
            </span>
          )}
        </div>
        <div className="trim-heading-actions">
          <button
            type="button"
            className={`trim-time-format-toggle${clockTimeFormat ? " active" : ""}`}
            aria-label="Show timeline times as hours, minutes, and seconds"
            aria-pressed={clockTimeFormat}
            title="Show timeline times as hours:minutes:seconds"
            onClick={() => setClockTimeFormat((enabled) => !enabled)}
          >
            h:m:s
          </button>
          <div
            className="trim-shortcuts-popover"
            onBlurCapture={(event) => {
              const nextTarget = event.relatedTarget;
              if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
              helpPointerDownRef.current = false;
              setShortcutsOpen(false);
            }}
          >
            <button
              ref={helpButtonRef}
              type="button"
              className="trim-mini-btn trim-shortcuts-btn"
              aria-label="Keyboard shortcuts"
              aria-controls="trim-shortcuts-panel"
              aria-expanded={shortcutsOpen}
              aria-describedby={shortcutsOpen ? "trim-shortcuts-panel" : undefined}
              title="Keyboard shortcuts"
              onPointerDown={() => {
                helpPointerDownRef.current = true;
              }}
              onPointerCancel={() => {
                helpPointerDownRef.current = false;
              }}
              onFocus={() => {
                if (!helpPointerDownRef.current) setShortcutsOpen(true);
              }}
              onClick={() => {
                helpPointerDownRef.current = false;
                setShortcutsOpen((open) => !open);
              }}
            >
              <TrimIcon name="help" />
            </button>
            <div
              id="trim-shortcuts-panel"
              className="trim-shortcuts-panel"
              role="tooltip"
              hidden={!shortcutsOpen}
            >
              <div className="trim-shortcuts-grid">
                <span className="sc-key">Space</span>
                <span>Play / Pause</span>
                <span className="sc-key">, / .</span>
                <span>Step 1/30s back / forward</span>
                <span className="sc-key">I</span>
                <span>Set in point to playhead</span>
                <span className="sc-key">O</span>
                <span>Set out point to playhead</span>
                <span className="sc-key">J</span>
                <span>Seek to in point</span>
                <span className="sc-key">K</span>
                <span>Seek to out point</span>
                <span className="sc-key">[ / ]</span>
                <span>Expand in / out point</span>
                <span className="sc-key">R / U</span>
                <span>Reset trim to full clip</span>
                <span className="sc-key">Shift + Arrow</span>
                <span>Nudge active handle</span>
                <span className="sc-key">Cmd/Ctrl + Z</span>
                <span>Undo / Redo trim</span>
                <span className="sc-key">?</span>
                <span>Toggle shortcut help</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="trim-toolbar" role="toolbar" aria-label="Trim editing controls">
        <div className="trim-control-group" role="group" aria-label="Set trim points">
          <button
            type="button"
            className="trim-mini-btn trim-labeled-btn"
            onClick={onSetInPoint}
            disabled={!canSetInPoint}
            title="Set in point to playhead (I)"
          >
            <TrimIcon name="mark-in" />
            <span>In</span>
          </button>
          <button
            type="button"
            className="trim-mini-btn trim-labeled-btn"
            onClick={onSetOutPoint}
            disabled={!canSetOutPoint}
            title="Set out point to playhead (O)"
          >
            <TrimIcon name="mark-out" />
            <span>Out</span>
          </button>
        </div>

        {!losslessTrim ? (
          <label className="trim-inline-control" title="Timeline snap interval">
            <TrimIcon name="snap" />
            <select
              value={snapMode}
              aria-label="Timeline snap interval"
              disabled={!trimReady}
              onChange={(event) => onSnapModeChange(event.target.value as SnapMode)}
            >
              <option value="off">Off</option>
              <option value="0.1">0.1s</option>
              <option value="0.5">0.5s</option>
              <option value="1.0">1.0s</option>
            </select>
          </label>
        ) : null}

        <div
          className="trim-control-group trim-zoom-controls"
          role="group"
          aria-label="Timeline zoom"
        >
          <button
            type="button"
            className="trim-mini-btn trim-icon-btn"
            onClick={onZoomOut}
            aria-label="Zoom timeline out"
            title="Zoom out"
            disabled={!canZoomOut}
          >
            <TrimIcon name="minus" />
          </button>
          <button
            type="button"
            className="trim-mini-btn trim-zoom-value"
            onClick={onZoomReset}
            aria-label="Reset timeline zoom to 1x"
            title="Reset timeline zoom"
            disabled={!canZoomOut}
          >
            {timelineZoom.toFixed(1)}x
          </button>
          <button
            type="button"
            className="trim-mini-btn trim-icon-btn"
            onClick={onZoomIn}
            aria-label="Zoom timeline in"
            title="Zoom in"
            disabled={!canZoomIn}
          >
            <TrimIcon name="plus" />
          </button>
        </div>

        <div className="trim-control-group" role="group" aria-label="Trim history">
          <button
            type="button"
            className="trim-mini-btn trim-icon-btn"
            onClick={onUndoTrim}
            aria-label="Undo trim"
            title="Undo trim (Cmd/Ctrl+Z)"
            disabled={!canUndoTrim}
          >
            <TrimIcon name="undo" />
          </button>
          <button
            type="button"
            className="trim-mini-btn trim-icon-btn"
            onClick={onRedoTrim}
            aria-label="Redo trim"
            title="Redo trim (Cmd/Ctrl+Shift+Z)"
            disabled={!canRedoTrim}
          >
            <TrimIcon name="redo" />
          </button>
        </div>

        <button
          type="button"
          className={`trim-loop-toggle${loopPlayback ? " active" : ""}`}
          aria-label="Loop trim playback"
          aria-pressed={loopPlayback}
          title="Loop trim playback"
          disabled={!trimReady}
          onClick={() => onLoopPlaybackChange(!loopPlayback)}
        >
          <TrimIcon name="loop" />
        </button>
      </div>
      <div className="slider-row trim-dual-row">
        {editableTimes ? (
          <TimelineTimeInput
            side="start"
            time={startTime}
            clockFormat={clockTimeFormat}
            disabled={!trimReady}
            onFocus={onStartHandleFocus}
            onCommit={onStartTimeCommit}
          />
        ) : (
          <span className={`time-label time-label-left${clockTimeFormat ? " clock-format" : ""}`}>
            {formatTimelineTime(startTime, clockTimeFormat)}
          </span>
        )}
        <div
          ref={trimWrapRef}
          className={`trim-dual-wrap${trimReady ? "" : " disabled"}`}
          onWheel={trimReady ? onTrimWheel : undefined}
          onClick={trimReady ? onTimelineClick : undefined}
          title={
            trimReady
              ? "Click to seek | Wheel to pan | Ctrl+Wheel to zoom"
              : "Load a video to enable trimming"
          }
          style={{ cursor: trimReady ? "crosshair" : undefined }}
        >
          <div className="trim-dual-track" />
          <div
            className="trim-dual-range"
            style={{
              transform: `translateX(${startPct}%) scaleX(${Math.max(endPct - startPct, 0) / 100})`,
            }}
            onMouseDown={trimReady ? onRangeDragStart : undefined}
          />
          <TrimPlayheadPosition elementRef={trimPlayheadRef} onMouseDown={onPlayheadDragStart} />
          {startHandleInView && (
            <input
              className="trim-handle trim-start-handle"
              type="range"
              min={visibleRangeMin}
              max={visibleRangeMax}
              step={1}
              value={startVal}
              disabled={!trimReady}
              onFocus={onStartHandleFocus}
              onPointerDown={onStartHandlePointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onChange={(event) => onStartChange(+event.target.value)}
              aria-label="Trim start"
              aria-valuemin={0}
              aria-valuemax={TRIM_RANGE_MAX}
              aria-valuenow={startVal}
              aria-valuetext={
                clockTimeFormat
                  ? formatTimelineTime(startTime, true)
                  : `${startTime.toFixed(1)} seconds`
              }
            />
          )}
          {endHandleInView && (
            <input
              className="trim-handle trim-end-handle"
              type="range"
              min={visibleRangeMin}
              max={visibleRangeMax}
              step={1}
              value={endVal}
              disabled={!trimReady}
              onFocus={onEndHandleFocus}
              onPointerDown={onEndHandlePointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onChange={(event) => onEndChange(+event.target.value)}
              aria-label="Trim end"
              aria-valuemin={0}
              aria-valuemax={TRIM_RANGE_MAX}
              aria-valuenow={endVal}
              aria-valuetext={
                clockTimeFormat
                  ? formatTimelineTime(endTime, true)
                  : `${endTime.toFixed(1)} seconds`
              }
            />
          )}
        </div>
        {editableTimes ? (
          <TimelineTimeInput
            side="end"
            time={endTime}
            clockFormat={clockTimeFormat}
            disabled={!trimReady}
            onFocus={onEndHandleFocus}
            onCommit={onEndTimeCommit}
          />
        ) : (
          <span className={`time-label time-label-right${clockTimeFormat ? " clock-format" : ""}`}>
            {formatTimelineTime(endTime, clockTimeFormat)}
          </span>
        )}
      </div>
    </div>
  );
}

export default memo(TrimTimeline);
