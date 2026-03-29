type ToastProps = {
  id: number;
  type: "success" | "error" | "warning" | "info";
  title: string;
  message: string;
  onClose: () => void;
};

const COLORS: Record<string, string> = {
  success: "#30d158",
  error: "#ff453a",
  warning: "#ffd60a",
  info: "#0a84ff",
};

export default function Toast({ type, title, message, onClose }: ToastProps) {
  const color = COLORS[type] ?? COLORS.info;
  return (
    <div style={{
      background: "var(--surface)",
      border: `1px solid var(--border)`,
      borderLeft: `3px solid ${color}`,
      borderRadius: "var(--radius)",
      padding: "10px 12px",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
      animation: "toast-in 0.2s ease",
      maxWidth: "340px",
      wordBreak: "break-word",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
        <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--text)" }}>{title}</span>
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", padding: "0 2px", fontSize: "14px", cursor: "pointer" }}
        >✕</button>
      </div>
      {message && <span style={{ fontSize: "12px", color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>{message}</span>}
      <style>{`@keyframes toast-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
