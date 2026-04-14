import { memo } from "react";

type Props = { progress: number; eta: string };

const shimmerKeyframes = `
  @keyframes shimmer {
    0%   { background-position: -200% center; }
    100% { background-position: 200% center; }
  }
`;

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
  background: "var(--border)",
  borderRadius: "2px",
  overflow: "hidden",
};

const etaStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--text-secondary)",
  textAlign: "center",
};

function ProgressSection({ progress, eta }: Props) {
  const isActive = progress > 0 && progress < 100;
  // Only the width/animation differs by state — mutable styles stay inline.
  const barStyle: React.CSSProperties = {
    height: "100%",
    width: `${progress}%`,
    background: isActive
      ? `linear-gradient(90deg, var(--accent) 0%, var(--accent-hover) 50%, var(--accent) 100%)`
      : "var(--accent)",
    backgroundSize: isActive ? "200% 100%" : "100% 100%",
    animation: isActive ? "shimmer 1.6s linear infinite" : "none",
    borderRadius: "2px",
    transition: "width 0.2s ease",
  };
  return (
    <div style={wrapperStyle}>
      <style>{shimmerKeyframes}</style>
      <div style={trackStyle}>
        <div style={barStyle} />
      </div>
      <span style={etaStyle}>{eta}</span>
    </div>
  );
}

export default memo(ProgressSection);
