/**
 * vidcord-feedback worker.
 *
 * Receives bug reports POSTed by the Vidcord desktop app and forwards them
 * to owner@vidcord.app via Resend. The app never sends email directly and
 * holds no credentials; all secrets live here as worker secrets.
 *
 * Abuse protection is layered:
 *  1. A shared `X-Vidcord-Feedback` token (in the public repo, so this only
 *     stops drive-by curl spam — not real auth).
 *  2. A Cloudflare WAF rate-limiting rule on vidcord.app/api/feedback*
 *     (see README) — this is the real protection.
 */

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SUBJECT_CHARS = 120;
const MAX_EMAIL_BODY_CHARS = 100_000;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-vidcord-feedback",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }

    const token = request.headers.get("x-vidcord-feedback");
    if (!env.FEEDBACK_TOKEN || token !== env.FEEDBACK_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return json({ error: "expected application/json" }, 415);
    }

    let raw;
    try {
      raw = await request.text();
    } catch {
      return json({ error: "could not read body" }, 400);
    }
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: "report too large" }, 413);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    const { subject, body } = data;
    if (typeof subject !== "string" || typeof body !== "string" || !subject || !body) {
      return json({ error: "subject and body are required" }, 400);
    }

    if (!env.RESEND_API_KEY) {
      return json({ error: "email not configured" }, 503);
    }

    let emailRes;
    try {
      emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Vidcord Bug Reports <bugs@vidcord.app>",
          to: ["owner@vidcord.app"],
          subject: subject.slice(0, MAX_SUBJECT_CHARS),
          text: body.slice(0, MAX_EMAIL_BODY_CHARS),
        }),
      });
    } catch (err) {
      console.error("resend request failed", err?.message || err);
      return json({ error: "could not send email" }, 502);
    }

    if (!emailRes.ok) {
      const detail = await emailRes.text().catch(() => "");
      console.error("resend rejected", emailRes.status, detail.slice(0, 500));
      return json({ error: "could not send email" }, 502);
    }

    return json({ ok: true });
  },
};
