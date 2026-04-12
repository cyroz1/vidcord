type ToastProps = {
  id: number;
  type: "success" | "error" | "warning" | "info";
  title: string;
  message: string;
  onClose: () => void;
};

const COLORS: Record<string, string> = {
  success: "var(--success)",
  error: "var(--error)",
  warning: "var(--warning)",
  info: "var(--accent)",
};

export default function Toast({ type, title, message, onClose }: ToastProps) {
  const color = COLORS[type] ?? COLORS.info;
  return (
    <div style={{
      background: "var(--surface)",
      border: "1px solid var(--border-subtle)",
      borderLeft: `3px solid ${color}`,
      borderRadius: "var(--radius)",
      padding: "10px 12px",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      boxShadow: "var(--shadow-overlay)",
      animation: "toast-in 0.18s ease",
      maxWidth: "340px",
      wordBreak: "break-word",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
        <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--text)" }}>{title}</span>
        <button
          onClick={onClose}
          style={{
            background: "none", border: "none",
            color: "var(--text-secondary)", padding: "0 2px",
            fontSize: "13px", cursor: "pointer", lineHeight: 1,
            borderRadius: "var(--radius-xs)",
          }}
        >✕</button>
      </div>
      {message && <span style={{ fontSize: "12px", color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>{message}</span>}
      <style>{`@keyframes toast-in { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
