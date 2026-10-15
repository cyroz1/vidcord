import { useCallback, useRef, useState, type CSSProperties } from "react";
import {
  dialogBackdropStyle as backdropStyle,
  dialogTitleBarStyle as titleBarStyle,
  dialogTitleCloseStyle as titleCloseStyle,
  dialogTitleStyle as titleStyle,
  useDialogFocusTrap,
} from "./useDialogFocusTrap";
import { buildMailto, FEEDBACK_EMAIL, sendBugReport } from "../feedback";
import { collectBugReport, deleteBugReport, type BugReport } from "../ipc";

type Props = { onClose: () => void };

const dialogStyle: CSSProperties = {
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  width: "min(560px, 95vw)",
  display: "flex",
  flexDirection: "column",
  boxShadow: "var(--shadow-overlay)",
};

const contentStyle: CSSProperties = {
  padding: "12px 16px",
  display: "flex",
  flexDirection: "column",
  gap: "10px",
};

const textareaStyle: CSSProperties = {
  width: "100%",
  minHeight: "110px",
  resize: "vertical",
  background: "var(--surface2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-xs)",
  color: "var(--text)",
  padding: "8px 10px",
  fontSize: "13px",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const noteStyle: CSSProperties = {
  margin: 0,
  fontSize: "12px",
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};

const footerStyle: CSSProperties = {
  padding: "10px 16px",
  borderTop: "1px solid var(--border-subtle)",
  display: "flex",
  justifyContent: "flex-end",
  gap: "8px",
  flexShrink: 0,
};

const buttonStyle: CSSProperties = {
  background: "var(--surface2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-xs)",
  color: "var(--text)",
  padding: "6px 20px",
  fontSize: "13px",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "#fff",
};

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: "12px",
  color: "var(--danger, #e5484d)",
};

const pathStyle: CSSProperties = {
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  fontSize: "11px",
  wordBreak: "break-all",
};

export default function FeedbackDialog({ onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLTextAreaElement>(null);
  const closingRef = useRef(false);
  const sendingRef = useRef(false);

  const [description, setDescription] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [report, setReport] = useState<BugReport | null>(null);
  const [mailed, setMailed] = useState(false);

  // Every close path (Escape, backdrop, title button, Cancel) funnels through
  // here, and Cancel is disabled while sending, so this must be too: closing
  // mid-send would unmount the dialog while the send completes invisibly.
  const requestClose = useCallback(() => {
    if (closingRef.current || sendingRef.current) return;
    closingRef.current = true;
    onClose();
  }, [onClose]);

  useDialogFocusTrap(dialogRef, initialFocusRef, requestClose);

  const handleSend = useCallback(async () => {
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const collected = await collectBugReport(description.trim() === "" ? null : description);
      setReport(collected);
      await sendBugReport(collected);
      // The endpoint send is confirmed, so the on-disk full report copy can
      // go; the mailto fallback path keeps it. Best effort: a failed delete
      // must not turn a successful send into an error (the copy is also
      // swept after 7 days).
      try {
        await deleteBugReport(collected.reportPath);
      } catch {
        // ignored
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [description]);

  const handleMailtoFallback = useCallback(async () => {
    if (!report) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(buildMailto(report));
      setMailed(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [report]);

  return (
    <div
      style={backdropStyle}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="feedback-dialog"
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-dialog-title"
        tabIndex={-1}
      >
        <div style={titleBarStyle}>
          <h2 id="feedback-dialog-title" style={titleStyle}>
            Report a bug
          </h2>
          <button
            type="button"
            aria-label="Close bug report dialog"
            disabled={sending}
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

        <div style={contentStyle}>
          {!sent && !mailed ? (
            <>
              <label
                htmlFor="feedback-description"
                style={{ fontSize: "13px", color: "var(--text)" }}
              >
                What happened? <span style={{ color: "var(--text-secondary)" }}>(optional)</span>
              </label>
              <textarea
                id="feedback-description"
                ref={initialFocusRef}
                style={textareaStyle}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="e.g. Export failed at 80% with 'encoder error' on a 4K HEVC file…"
                disabled={sending}
              />
              <p style={noteStyle}>
                Sends directly to the developer. The report includes your Vidcord version, operating
                system, and the last 100 lines of the app log. A full copy is also saved on your
                disk.
              </p>
              {error !== null && (
                <>
                  <p style={errorStyle} role="alert">
                    Couldn't send the report: {error}
                  </p>
                  {report !== null && (
                    <p style={noteStyle}>
                      You can still send it through your mail app instead — everything is already
                      filled in, addressed to {FEEDBACK_EMAIL}.
                    </p>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <p style={{ ...noteStyle, fontSize: "13px", color: "var(--text)" }}>
                {sent
                  ? "Report sent — thanks for helping improve Vidcord."
                  : "Your mail app should now have the report ready — review it and hit send there."}
              </p>
              {report !== null && (
                <p style={noteStyle}>
                  A full copy was saved to:
                  <br />
                  <span style={pathStyle}>{report.reportPath}</span>
                </p>
              )}
            </>
          )}
        </div>

        <div style={footerStyle}>
          {sent || mailed ? (
            <button type="button" onClick={requestClose} style={buttonStyle}>
              Done
            </button>
          ) : (
            <>
              <button type="button" onClick={requestClose} style={buttonStyle} disabled={sending}>
                Cancel
              </button>
              {error !== null && report !== null && (
                <button
                  type="button"
                  onClick={() => void handleMailtoFallback()}
                  style={buttonStyle}
                  disabled={sending}
                >
                  Open in mail app instead
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleSend()}
                style={primaryButtonStyle}
                disabled={sending}
              >
                {sending ? "Sending…" : "Send report"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
