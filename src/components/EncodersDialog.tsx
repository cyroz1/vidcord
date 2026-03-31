type Props = { text: string; onClose: () => void };

export default function EncodersDialog({ text, onClose }: Props) {
  return (
    <div
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.40)",
        backdropFilter: "blur(12px) saturate(160%)",
        WebkitBackdropFilter: "blur(12px) saturate(160%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 2000,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "rgba(40, 40, 44, 0.82)",
        backdropFilter: "blur(24px) saturate(160%)",
        WebkitBackdropFilter: "blur(24px) saturate(160%)",
        border: "1px solid rgba(255,255,255,0.18)",
        borderRadius: "16px",
        width: "min(720px, 95vw)",
        height: "min(520px, 85vh)",
        display: "flex", flexDirection: "column",
        boxShadow: "0 16px 48px rgba(0,0,0,0.50), inset 0 1px 0 rgba(255,255,255,0.18)",
      }}>
        {/* Title bar */}
        <div style={{
          padding: "12px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.10)",
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
              transition: "color 0.15s, transform 0.08s",
            }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--text-secondary)")}
            onMouseDown={e => (e.currentTarget.style.transform = "scale(0.88)")}
            onMouseUp={e => (e.currentTarget.style.transform = "")}
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
          borderTop: "1px solid rgba(255,255,255,0.10)",
          display: "flex", justifyContent: "flex-end",
          flexShrink: 0,
        }}>
          <button
            onClick={onClose}
            style={{
              background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.16)",
              borderRadius: "8px", color: "var(--text)",
              padding: "6px 20px", fontSize: "13px", cursor: "pointer",
              transition: "background 0.15s, transform 0.08s",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.16)")}
            onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.10)")}
            onMouseDown={e => (e.currentTarget.style.transform = "scale(0.97)")}
            onMouseUp={e => (e.currentTarget.style.transform = "")}
          >Close</button>
        </div>
      </div>
    </div>
  );
}
