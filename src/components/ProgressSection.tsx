type Props = { progress: number; eta: string };

export default function ProgressSection({ progress, eta }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <div style={{
        width: "100%",
        height: "6px",
        background: "var(--surface)",
        borderRadius: "3px",
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${progress}%`,
          background: "var(--accent)",
          borderRadius: "3px",
          transition: "width 0.2s ease",
        }} />
      </div>
      <span style={{ fontSize: "12px", color: "var(--text-secondary)", textAlign: "center" }}>{eta}</span>
    </div>
  );
}
