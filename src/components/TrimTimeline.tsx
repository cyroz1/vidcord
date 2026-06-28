import { memo, type MouseEvent, type RefObject, type WheelEvent } from "react";

export type SnapMode = "off" | "0.1" | "0.5" | "1.0";

type Props = {
  showShortcuts: boolean;
  selectedDuration: number;
  selectedDurationPct: number;
  playheadTime: number | null;
  snapMode: SnapMode;
  timelineZoom: number;
  trimWrapRef: RefObject<HTMLDivElement>;
  filePath: string | null;
  startTime: number;
  endTime: number;
  viewStartVal: number;
  viewEndVal: number;
  startVal: number;
  endVal: number;
  startPct: number;
  endPct: number;
  trimPlayheadLeftPct: number | null;
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
  onToggleShortcuts: () => void;
  onTrimWheel: (event: WheelEvent<HTMLDivElement>) => void;
  onTimelineClick: (event: MouseEvent<HTMLDivElement>) => void;
  onRangeDragStart: (event: MouseEvent<HTMLDivElement>) => void;
  onPlayheadDragStart: (event: MouseEvent<HTMLDivElement>) => void;
  onStartHandlePointerDown: () => void;
  onEndHandlePointerDown: () => void;
  onPointerUp: () => void;
  onStartChange: (value: number) => void;
  onEndChange: (value: number) => void;
};

function TrimTimeline({
  showShortcuts,
  selectedDuration,
  selectedDurationPct,
  playheadTime,
  snapMode,
  timelineZoom,
  trimWrapRef,
  filePath,
  startTime,
  endTime,
  viewStartVal,
  viewEndVal,
  startVal,
  endVal,
  startPct,
  endPct,
  trimPlayheadLeftPct,
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
  onToggleShortcuts,
  onTrimWheel,
  onTimelineClick,
  onRangeDragStart,
  onPlayheadDragStart,
  onStartHandlePointerDown,
  onEndHandlePointerDown,
  onPointerUp,
  onStartChange,
  onEndChange,
}: Props) {
  return (
    <div className="trim-section">
      <div className="trim-header">
        <span className="section-title">Trim Video</span>
        <span className="trim-selection-meta">
          {selectedDuration.toFixed(2)}s selected ({selectedDurationPct.toFixed(1)}%)
        </span>
        <button
          type="button"
          className="trim-mini-btn"
          onClick={onSetInPoint}
          disabled={playheadTime === null}
          title="Set in point to playhead (I)"
        >
          In
        </button>
        <button
          type="button"
          className="trim-mini-btn"
          onClick={onSetOutPoint}
          disabled={playheadTime === null}
          title="Set out point to playhead (O)"
        >
          Out
        </button>
        <label className="trim-inline-control">
          Snap
          <select
            value={snapMode}
            onChange={(event) => onSnapModeChange(event.target.value as SnapMode)}
          >
            <option value="off">Off</option>
            <option value="0.1">0.1s</option>
            <option value="0.5">0.5s</option>
            <option value="1.0">1.0s</option>
          </select>
        </label>
        <div className="trim-zoom-controls">
          <button type="button" className="trim-mini-btn" onClick={onZoomOut}>
            -
          </button>
          <button type="button" className="trim-mini-btn" onClick={onZoomReset} title="Reset zoom">
            {timelineZoom.toFixed(1)}x
          </button>
          <button type="button" className="trim-mini-btn" onClick={onZoomIn}>
            +
          </button>
        </div>
        <button
          type="button"
          className="trim-mini-btn"
          onClick={onUndoTrim}
          title="Undo trim (Cmd/Ctrl+Z)"
        >
          Undo
        </button>
        <button
          type="button"
          className="trim-mini-btn"
          onClick={onRedoTrim}
          title="Redo trim (Cmd/Ctrl+Shift+Z)"
        >
          Redo
        </button>
        <label className="trim-loop-toggle">
          <input
            type="checkbox"
            checked={loopPlayback}
            onChange={(event) => onLoopPlaybackChange(event.target.checked)}
          />
          Loop
        </label>
        <button
          type="button"
          className={`trim-mini-btn trim-shortcuts-btn${showShortcuts ? " active" : ""}`}
          onClick={onToggleShortcuts}
          title="Keyboard shortcuts"
        >
          ?
        </button>
      </div>
      {showShortcuts && (
        <div className="trim-shortcuts-panel">
          <div className="trim-shortcuts-grid">
            <span className="sc-key">Space</span>
            <span>Play / Pause</span>
            <span className="sc-key">, / .</span>
            <span>Step frame back / forward</span>
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
            <span className="sc-key">Shift Left / Right</span>
            <span>Nudge active handle</span>
            <span className="sc-key">Cmd Z / Shift Cmd Z</span>
            <span>Undo / Redo trim</span>
          </div>
        </div>
      )}
      <div className="slider-row trim-dual-row">
        <span className="time-label time-label-left">{startTime.toFixed(1)}s</span>
        <div
          ref={trimWrapRef}
          className="trim-dual-wrap"
          onWheel={onTrimWheel}
          onClick={onTimelineClick}
          title="Click to seek | Wheel to pan | Ctrl+Wheel to zoom"
          style={{ cursor: filePath ? "crosshair" : undefined }}
        >
          <div className="trim-dual-track" />
          <div
            className="trim-dual-range"
            style={{
              left: `${startPct}%`,
              width: `${Math.max(endPct - startPct, 0)}%`,
            }}
            onMouseDown={onRangeDragStart}
          />
          {trimPlayheadLeftPct !== null && (
            <div
              className="trim-playhead"
              style={{ left: `${trimPlayheadLeftPct}%` }}
              onMouseDown={onPlayheadDragStart}
            />
          )}
          <input
            className="trim-handle trim-start-handle"
            type="range"
            min={Math.round(viewStartVal)}
            max={Math.round(viewEndVal)}
            value={startVal}
            onPointerDown={onStartHandlePointerDown}
            onPointerUp={onPointerUp}
            onChange={(event) => onStartChange(+event.target.value)}
            aria-label="Trim start"
          />
          <input
            className="trim-handle trim-end-handle"
            type="range"
            min={Math.round(viewStartVal)}
            max={Math.round(viewEndVal)}
            value={endVal}
            onPointerDown={onEndHandlePointerDown}
            onPointerUp={onPointerUp}
            onChange={(event) => onEndChange(+event.target.value)}
            aria-label="Trim end"
          />
        </div>
        <span className="time-label time-label-right">{endTime.toFixed(1)}s</span>
      </div>
    </div>
  );
}

export default memo(TrimTimeline);
