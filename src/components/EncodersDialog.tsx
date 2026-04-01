type Props = { text: string; onClose: () => void };

export default function EncodersDialog({ text, onClose }: Props) {
  return (
    <div
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0, 0, 0, 0.44)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 2000,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        width: "min(720px, 95vw)",
        height: "min(520px, 85vh)",
        display: "flex", flexDirection: "column",
        boxShadow: "var(--shadow-overlay)",
      }}>
        {/* Title bar */}
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 600, fontSize: "14px", color: "var(--text)" }}>FFmpeg Video Encoders</span>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "none",
              color: "var(--text-secondary)", fontSize: "13px",
              cursor: "pointer", padding: "2px 6px",
              borderRadius: "var(--radius-xs)",
              lineHeight: 1,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-subtle)")}
            onMouseLeave={e => (e.currentTarget.style.background = "none")}
          >✕</button>
        </div>

        {/* Scrollable content */}
        <pre style={{
          flex: 1,
          overflow: "auto",
          margin: 0,
          padding: "12px 16px",
          fontFamily: "'Cascadia Code', 'Consolas', monospace",
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
          borderTop: "1px solid var(--border-subtle)",
          display: "flex", justifyContent: "flex-end",
          flexShrink: 0,
        }}>
          <button
            onClick={onClose}
            style={{
              background: "var(--surface2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-xs)",
              color: "var(--text)",
              padding: "6px 20px",
              fontSize: "13px",
              cursor: "pointer",
              transition: "filter 0.1s",
            }}
            onMouseEnter={e => (e.currentTarget.style.filter = "brightness(1.1)")}
            onMouseLeave={e => (e.currentTarget.style.filter = "")}
            onMouseDown={e => (e.currentTarget.style.filter = "brightness(0.9)")}
            onMouseUp={e => (e.currentTarget.style.filter = "brightness(1.1)")}
          >Close</button>
        </div>
      </div>
    </div>
  );
}
