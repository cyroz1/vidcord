import { memo } from "react";
import type { ToastAction } from "../hooks/useToasts";

type ToastType = "success" | "error" | "warning" | "info";

type ToastProps = {
  id: number;
  type: ToastType;
  title: string;
  message: string;
  actions?: ToastAction[];
  onClose: (id: number) => void;
};

const COLORS: Record<ToastType, string> = {
  success: "var(--success)",
  error: "var(--error)",
  warning: "var(--warning)",
  info: "var(--accent)",
};

// Hoisted to module scope so re-renders (e.g. parent App re-rendering during
// trim-slider scrubs) don't allocate fresh style objects per toast.
const wrapperBaseStyle: React.CSSProperties = {
  background: "var(--toast-bg)",
  backdropFilter: "var(--blur)",
  WebkitBackdropFilter: "var(--blur)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  boxShadow: "var(--shadow-overlay), var(--card-top)",
  maxWidth: "340px",
  wordBreak: "break-word",
};

// The type set is closed, so precompute every wrapper variant once instead
// of spreading the base style on every render.
const wrapperStyles: Record<ToastType, React.CSSProperties> = {
  success: { ...wrapperBaseStyle, borderLeft: `3px solid ${COLORS.success}` },
  error: { ...wrapperBaseStyle, borderLeft: `3px solid ${COLORS.error}` },
  warning: { ...wrapperBaseStyle, borderLeft: `3px solid ${COLORS.warning}` },
  info: { ...wrapperBaseStyle, borderLeft: `3px solid ${COLORS.info}` },
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

const actionsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
  marginTop: "4px",
};

const actionButtonStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-xs)",
  background: "var(--control-bg)",
  color: "var(--text)",
  padding: "5px 8px",
  fontSize: "11px",
  fontWeight: 600,
  cursor: "pointer",
};

function Toast({ id, type, title, message, actions, onClose }: ToastProps) {
  const wrapperStyle = wrapperStyles[type] ?? wrapperStyles.info;
  return (
    <div
      className="toast"
      style={wrapperStyle}
      role={type === "error" ? "alert" : "status"}
      aria-atomic="true"
    >
      <div style={headerStyle}>
        <span style={titleStyle}>{title}</span>
        <button
          type="button"
          onClick={() => onClose(id)}
          style={closeBtnStyle}
          aria-label={`Dismiss ${title} notification`}
        >
          ✕
        </button>
      </div>
      {message && <span style={messageStyle}>{message}</span>}
      {actions && actions.length > 0 && (
        <div style={actionsStyle}>
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              style={actionButtonStyle}
              onClick={() => {
                onClose(id);
                action.onClick();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(Toast);
