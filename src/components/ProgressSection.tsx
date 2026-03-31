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
        height: "5px",
        background: "rgba(255,255,255,0.10)",
        borderRadius: "3px",
        overflow: "hidden",
        boxShadow: "inset 0 1px 2px rgba(0,0,0,0.20)",
      }}>
        <div style={{
          height: "100%",
          width: `${progress}%`,
          background: isActive
            ? "linear-gradient(90deg, #0a84ff 0%, #409cff 50%, #0a84ff 100%)"
            : "var(--accent)",
          backgroundSize: isActive ? "200% 100%" : "100% 100%",
          animation: isActive ? "shimmer 1.6s linear infinite" : "none",
          borderRadius: "3px",
          transition: "width 0.2s ease",
        }} />
      </div>
      <span style={{ fontSize: "12px", color: "var(--text-secondary)", textAlign: "center" }}>{eta}</span>
    </div>
  );
}
