import type { BugReport } from "./ipc";

export const FEEDBACK_ENDPOINT = "https://vidcord.app/api/feedback";
export const FEEDBACK_EMAIL = "owner@vidcord.app";
// Public-repo token: stops casual drive-by spam only. Real abuse protection
// is the Cloudflare WAF rate-limiting rule on the endpoint (see
// workers/feedback/README.md). Rotate it via `cfw secret put FEEDBACK_TOKEN`
// and update this file if it is ever abused.
const FEEDBACK_TOKEN = "f22f96ae239e38e444762f18c399cec9e74ee5302a9f4300998639b0364a277a";

export async function sendBugReport(report: BugReport): Promise<void> {
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
