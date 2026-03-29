type Props = { text: string; onClose: () => void };

export default function EncodersDialog({ text, onClose }: Props) {
  return (
    <div
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 2000,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        width: "min(720px, 95vw)",
        height: "min(520px, 85vh)",
        display: "flex", flexDirection: "column",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      }}>
        {/* Title bar */}
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 600, fontSize: "14px" }}>FFmpeg Video Encoders</span>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "none",
              color: "var(--text-secondary)", fontSize: "16px",
              cursor: "pointer", padding: "2px 6px",
            }}
          >✕</button>
        </div>

        {/* Scrollable content */}
        <pre style={{
          flex: 1,
          overflow: "auto",
          margin: 0,
          padding: "12px 16px",
          fontFamily: "monospace",
          fontSize: "12px",
          color: "var(--text)",
          whiteSpace: "pre",
          lineHeight: "1.6",
        }}>
          {text}
        </pre>

        {/* Footer */}
        <div style={{
          padding: "10px 16px",
          borderTop: "1px solid var(--border)",
          display: "flex", justifyContent: "flex-end",
          flexShrink: 0,
        }}>
          <button
            onClick={onClose}
            style={{
              background: "var(--surface2)", border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)", color: "var(--text)",
              padding: "6px 20px", fontSize: "13px", cursor: "pointer",
            }}
          >Close</button>
        </div>
      </div>
    </div>
  );
}
