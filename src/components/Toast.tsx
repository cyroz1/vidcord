import { memo } from "react";

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

// Hoisted to module scope so re-renders (e.g. parent App re-rendering during
// trim-slider scrubs) don't allocate fresh style objects per toast.
const wrapperBaseStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  boxShadow: "var(--shadow-overlay)",
  animation: "toast-in 0.18s ease",
  maxWidth: "340px",
  wordBreak: "break-word",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "8px",
};

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: "13px",
  color: "var(--text)",
};

const closeBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text-secondary)",
  padding: "0 2px",
  fontSize: "13px",
  cursor: "pointer",
  lineHeight: 1,
  borderRadius: "var(--radius-xs)",
};

const messageStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--text-secondary)",
  whiteSpace: "pre-wrap",
};

const KEYFRAMES = `@keyframes toast-in { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }`;

function Toast({ type, title, message, onClose }: ToastProps) {
  const color = COLORS[type] ?? COLORS.info;
  // Only the left-border accent varies with type, so shallow-merge once.
  const wrapperStyle: React.CSSProperties = {
    ...wrapperBaseStyle,
    borderLeft: `3px solid ${color}`,
  };
  return (
    <div style={wrapperStyle}>
      <div style={headerStyle}>
        <span style={titleStyle}>{title}</span>
        <button onClick={onClose} style={closeBtnStyle}>✕</button>
      </div>
      {message && <span style={messageStyle}>{message}</span>}
      <style>{KEYFRAMES}</style>
    </div>
  );
}

export default memo(Toast);
