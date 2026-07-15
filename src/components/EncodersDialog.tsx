import { useCallback, useEffect, useRef, type CSSProperties } from "react";

type Props = { text: string; onClose: () => void };

const FOCUSABLE_SELECTOR =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), " +
  "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.44)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2000,
};

const dialogStyle: CSSProperties = {
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  width: "min(720px, 95vw)",
  height: "min(520px, 85vh)",
  display: "flex",
  flexDirection: "column",
  boxShadow: "var(--shadow-overlay)",
};

const titleBarStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border-subtle)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexShrink: 0,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontWeight: 600,
  fontSize: "14px",
  color: "var(--text)",
};

const titleCloseStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text-secondary)",
  fontSize: "13px",
  cursor: "pointer",
  padding: "2px 6px",
  borderRadius: "var(--radius-xs)",
  lineHeight: 1,
};

const contentStyle: CSSProperties = {
  flex: 1,
  overflow: "auto",
  margin: 0,
  padding: "12px 16px",
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  fontSize: "12px",
  color: "var(--text)",
  whiteSpace: "pre",
  lineHeight: "1.6",
};

const footerStyle: CSSProperties = {
  padding: "10px 16px",
  borderTop: "1px solid var(--border-subtle)",
  display: "flex",
  justifyContent: "flex-end",
  flexShrink: 0,
};

const footerCloseStyle: CSSProperties = {
  background: "var(--surface2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-xs)",
  color: "var(--text)",
  padding: "6px 20px",
  fontSize: "13px",
  cursor: "pointer",
  transition: "filter 0.1s",
};

export default function EncodersDialog({ text, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closingRef = useRef(false);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusFrame = window.requestAnimationFrame(() => {
      (initialFocusRef.current ?? dialogRef.current)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.getClientRects().length > 0
      );

      event.preventDefault();
      event.stopPropagation();
      if (focusable.length === 0) {
        dialog.focus();
        return;
      }

      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? activeIndex <= 0
          ? focusable.length - 1
          : activeIndex - 1
        : activeIndex < 0 || activeIndex === focusable.length - 1
          ? 0
          : activeIndex + 1;
      focusable[nextIndex].focus();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);

      const focusTarget = previousFocusRef.current;
      previousFocusRef.current = null;
      if (focusTarget?.isConnected) {
        window.requestAnimationFrame(() => focusTarget.focus());
      }
    };
  }, [requestClose]);

  return (
    <div
      style={backdropStyle}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="encoders-dialog"
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="encoders-dialog-title"
        tabIndex={-1}
      >
        <div style={titleBarStyle}>
          <h2 id="encoders-dialog-title" style={titleStyle}>
            FFmpeg Video Encoders
          </h2>
          <button
            ref={initialFocusRef}
            type="button"
            aria-label="Close FFmpeg video encoders"
            onClick={requestClose}
            style={titleCloseStyle}
            onMouseEnter={(event) =>
              (event.currentTarget.style.background = "var(--surface-subtle)")
            }
            onMouseLeave={(event) => (event.currentTarget.style.background = "none")}
          >
            ×
          </button>
        </div>

        <pre style={contentStyle} tabIndex={0} aria-label="Available FFmpeg video encoders">
          {text}
        </pre>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={requestClose}
            style={footerCloseStyle}
            onMouseEnter={(event) => (event.currentTarget.style.filter = "brightness(1.1)")}
            onMouseLeave={(event) => (event.currentTarget.style.filter = "")}
            onMouseDown={(event) => (event.currentTarget.style.filter = "brightness(0.9)")}
            onMouseUp={(event) => (event.currentTarget.style.filter = "brightness(1.1)")}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
