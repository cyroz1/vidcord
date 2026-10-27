import { useCallback, useRef, useState, type CSSProperties } from "react";
import {
  dialogBackdropStyle as backdropStyle,
  dialogTitleBarStyle as titleBarStyle,
  dialogTitleCloseStyle as titleCloseStyle,
  dialogTitleStyle as titleStyle,
  useDialogFocusTrap,
} from "./useDialogFocusTrap";
import { useTightWindow } from "../hooks/useTightWindow";

type Props = { text: string; onClose: () => void };

const dialogStyle: CSSProperties = {
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  width: "min(720px, 95vw)",
  display: "flex",
  flexDirection: "column",
  boxShadow: "var(--shadow-overlay)",
};

const contentStyle: CSSProperties = {
  margin: 0,
  padding: "12px 16px",
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  fontSize: "12px",
  color: "var(--text)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  lineHeight: "1.6",
};

const emptyStyle: CSSProperties = {
  flex: 1,
  margin: 0,
  padding: "12px 16px",
  fontSize: "13px",
  color: "var(--text-secondary)",
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
  const closingRef = useRef(false);
  const tightWindow = useTightWindow(dialogRef);
  const [page, setPage] = useState(0);
  const lines = text.split("\n");
  const pageSize = tightWindow ? 6 : 10;
  const pageCount = Math.max(1, Math.ceil(lines.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleText = lines.slice(currentPage * pageSize, (currentPage + 1) * pageSize).join("\n");

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    onClose();
  }, [onClose]);

  useDialogFocusTrap(dialogRef, initialFocusRef, requestClose);

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

        {text.trim() ? (
          <pre style={contentStyle} tabIndex={0} aria-label="Available FFmpeg video encoders">
            {visibleText}
          </pre>
        ) : (
          <p style={emptyStyle} role="status">
            No encoder information available.
          </p>
        )}

        {pageCount > 1 && (
          <div className="pagination" style={{ padding: "0 16px 10px" }} aria-label="Encoder pages">
            <button
              type="button"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage === 0}
            >
              Previous
            </button>
            <span aria-live="polite">
              Page {currentPage + 1} of {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage === pageCount - 1}
            >
              Next
            </button>
          </div>
        )}
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
