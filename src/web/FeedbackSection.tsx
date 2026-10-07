import { useCallback, useState } from "react";
import { sendBugReport } from "../feedback";

const MAX_DESCRIPTION_CHARS = 5000;

export default function FeedbackSection() {
  const [description, setDescription] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSend = useCallback(async () => {
    const text = description.trim();
    if (text === "" || sending) return;
    setSending(true);
    setError(null);
    try {
      const context = [
        `Page: ${window.location.href}`,
        `Browser: ${navigator.userAgent}`,
        `Language: ${navigator.language}`,
      ].join("\n");
      await sendBugReport({
        subject: "Vidcord website feedback",
        body: `${text.slice(0, MAX_DESCRIPTION_CHARS)}\n\n---\n${context}`,
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [description, sending]);

  return (
    <section className="feedback-section" id="feedback" aria-labelledby="feedback-title">
      <div className="feedback-copy">
        <h2 id="feedback-title">Report a bug</h2>
        <p>
          Found something broken on the site or in the app? Send a note straight to the developer.
          Your message goes out with basic browser info so the issue can be reproduced.
        </p>
      </div>
      <div className="feedback-form">
        {sent ? (
          <p className="feedback-success" role="status">
            Thanks — your report is on its way.
          </p>
        ) : (
          <>
            <label className="feedback-label" htmlFor="site-feedback-description">
              What happened?
            </label>
            <textarea
              id="site-feedback-description"
              className="feedback-textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="e.g. The web demo froze when I dropped a 4K file in Firefox…"
              maxLength={MAX_DESCRIPTION_CHARS}
              rows={4}
              disabled={sending}
            />
            {error !== null && (
              <p className="feedback-error" role="alert">
                Couldn't send the report: {error}
              </p>
            )}
            <button
              type="button"
              className="button button-primary feedback-send"
              onClick={() => void handleSend()}
              disabled={sending || description.trim() === ""}
            >
              {sending ? "Sending…" : "Send report"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
