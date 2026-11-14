import type { BugReport } from "./ipc";

export const FEEDBACK_ENDPOINT = "https://vidcord.app/api/feedback";
export const FEEDBACK_EMAIL = "owner@vidcord.app";
// Public-repo token: obfuscation, not authentication. The Worker rate-limits
// requests before forwarding reports to Resend (see workers/feedback/README.md).
// Rotate it via `cfw secret put FEEDBACK_TOKEN` if it is ever abused.
const FEEDBACK_TOKEN = "f22f96ae239e38e444762f18c399cec9e74ee5302a9f4300998639b0364a277a";

export async function sendBugReport(report: Pick<BugReport, "subject" | "body">): Promise<void> {
  // The desktop webview's network stack is inconsistent across platforms
  // (WebKitGTK can reject a valid cross-origin response as "Load failed").
  // Send native reports through Tauri's HTTP client instead, which also
  // avoids requiring browser CORS for a desktop-only request.
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<void>("send_bug_report", {
      subject: report.subject,
      body: report.body,
      token: FEEDBACK_TOKEN,
    });
    return;
  }

  const res = await fetch(FEEDBACK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vidcord-Feedback": FEEDBACK_TOKEN,
    },
    body: JSON.stringify({ subject: report.subject, body: report.body }),
  });
  if (!res.ok) {
    throw new Error(`report server returned ${res.status}`);
  }
}

export function buildMailto(report: BugReport): string {
  return (
    `mailto:${FEEDBACK_EMAIL}` +
    `?subject=${encodeURIComponent(report.subject)}` +
    `&body=${encodeURIComponent(report.body)}`
  );
}
