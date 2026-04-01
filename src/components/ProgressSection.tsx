type Props = { progress: number; eta: string };

const shimmerKeyframes = `
  @keyframes shimmer {
    0%   { background-position: -200% center; }
    100% { background-position: 200% center; }
  }
`;

export default function ProgressSection({ progress, eta }: Props) {
  const isActive = progress > 0 && progress < 100;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <style>{shimmerKeyframes}</style>
      <div style={{
        width: "100%",
        height: "4px",
        background: "var(--border)",
        borderRadius: "2px",
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${progress}%`,
          background: isActive
            ? `linear-gradient(90deg, var(--accent) 0%, var(--accent-hover) 50%, var(--accent) 100%)`
            : "var(--accent)",
          backgroundSize: isActive ? "200% 100%" : "100% 100%",
          animation: isActive ? "shimmer 1.6s linear infinite" : "none",
          borderRadius: "2px",
          transition: "width 0.2s ease",
        }} />
      </div>
      <span style={{ fontSize: "12px", color: "var(--text-secondary)", textAlign: "center" }}>{eta}</span>
    </div>
  );
}
