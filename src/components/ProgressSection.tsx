import { memo } from "react";

type Props = { progress: number; eta: string };

// Hoisted to module scope so unrelated parent re-renders (e.g. trim-slider
// movement) don't allocate fresh style objects for the progress track.
const wrapperStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const trackStyle: React.CSSProperties = {
  width: "100%",
  height: "4px",
  background: "var(--track)",
  borderRadius: "2px",
  overflow: "hidden",
};

const etaStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--text-secondary)",
  textAlign: "center",
};

function ProgressSection({ progress, eta }: Props) {
  const safeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
  const isActive = safeProgress > 0 && safeProgress < 100;
  // Scale the full-width fill on the compositor instead of changing layout width.
  const barStyle: React.CSSProperties = {
    transform: `scaleX(${safeProgress / 100})`,
  };
  return (
    <div className="progress-section" style={wrapperStyle}>
      <div
        style={trackStyle}
        role="progressbar"
        aria-label="Compression progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(safeProgress)}
        aria-valuetext={`${Math.round(safeProgress)}% complete, ${eta}`}
      >
        <div className={`progress-bar${isActive ? " is-active" : ""}`} style={barStyle} />
      </div>
      <span className="progress-status" style={etaStyle} title={eta}>
        {eta}
      </span>
    </div>
  );
}

export default memo(ProgressSection);
