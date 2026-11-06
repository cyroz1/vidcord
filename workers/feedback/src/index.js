/**
 * vidcord-feedback worker.
 *
 * Receives bug reports POSTed by the Vidcord desktop app and forwards them
 * to owner@vidcord.app via Resend. The app never sends email directly and
 * holds no credentials; all secrets live here as worker secrets.
 *
 * The public-repo token is not authentication. The Worker enforces a
 * per-source-IP, per-Cloudflare-location request limit before forwarding reports
 * to Resend; a Cloudflare WAF rule can add another layer at the route.
 * That per-IP budget is keyed by an attacker-controlled dimension, so the
 * FeedbackQuota Durable Object below additionally enforces a global send
 * ceiling across all sources before any Resend call: rotating source IPs or
 * Cloudflare locations cannot multiply the aggregate number of emails.
 */

const MAX_BODY_BYTES = 256 * 1024;
const MAX_SUBJECT_CHARS = 120;
const MAX_EMAIL_BODY_CHARS = 100_000;
const RATE_LIMIT_REQUESTS_PER_MINUTE = 5;
// Aggregate ceilings for the whole service, enforced by FeedbackQuota.
// Legitimate report volume is a handful per day; these bounds exist to cap
// Resend spend and inbox flooding under a distributed abuse attempt, not to
// throttle real users. A refused report still leaves the desktop dialog's
// user-selected email fallback available.
const GLOBAL_SENDS_PER_HOUR = 30;
const GLOBAL_SENDS_PER_DAY = 100;

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

/**
 * Global send quota, backed by a single Durable Object instance so the
 * counters are strongly consistent across every source IP and Cloudflare
 * location. Each POST atomically reserves one send slot against the current
 * UTC hour and day buckets; the reservation is consumed even if the Resend
 * call afterwards fails, which keeps the cap fail-closed. The previous
 * hour/day buckets are deleted on each reservation so storage stays flat.
 */
export class FeedbackQuota {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const now = Date.now();
    const hourKey = `hour:${new Date(now).toISOString().slice(0, 13)}`;
    const dayKey = `day:${new Date(now).toISOString().slice(0, 10)}`;
    const staleKeys = [
      `hour:${new Date(now - 3_600_000).toISOString().slice(0, 13)}`,
      `hour:${new Date(now - 7_200_000).toISOString().slice(0, 13)}`,
      `day:${new Date(now - 86_400_000).toISOString().slice(0, 10)}`,
    ];
    let outcome;
    this.state.storage.transactionSync((txn) => {
      const hourCount = txn.get(hourKey) ?? 0;
      const dayCount = txn.get(dayKey) ?? 0;
      if (hourCount >= GLOBAL_SENDS_PER_HOUR || dayCount >= GLOBAL_SENDS_PER_DAY) {
        outcome = { allowed: false, hourCount, dayCount };
        return;
      }
      txn.put(hourKey, hourCount + 1);
      txn.put(dayKey, dayCount + 1);
      for (const key of staleKeys) {
        if (key !== hourKey && key !== dayKey) txn.delete(key);
      }
      outcome = { allowed: true, hourCount: hourCount + 1, dayCount: dayCount + 1 };
    });
    return new Response(JSON.stringify(outcome), {
      headers: { "content-type": "application/json" },
    });
  }
}

// Reserves one slot of the aggregate send quota. Returns "unconfigured"
// when the binding is absent (deployments predating the quota wiring keep
// the per-IP limiter only), "unavailable" when a configured binding cannot
// be consulted, and "allowed"/"exceeded" for its verdict.
async function reserveGlobalSend(env) {
  if (typeof env.FEEDBACK_QUOTA?.getByName !== "function") {
    return "unconfigured";
  }
  let response;
  try {
    const stub = env.FEEDBACK_QUOTA.getByName("global-feedback-quota");
    response = await stub.fetch("https://feedback-quota.invalid/reserve", {
      method: "POST",
    });
  } catch {
    return "unavailable";
  }
  if (!response.ok) return "unavailable";
  const outcome = await response.json().catch(() => null);
  if (!outcome || typeof outcome.allowed !== "boolean") return "unavailable";
  return outcome.allowed ? "allowed" : "exceeded";
}

async function readBodyWithinLimit(body, maxBytes) {
  if (!body) return { raw: "", tooLarge: false };

  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return { raw: null, tooLarge: true };
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already have released its reader while being canceled.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { raw: new TextDecoder().decode(bytes), tooLarge: false };
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

    if (!env.FEEDBACK_RATE_LIMITER?.limit) {
      return json({ error: "feedback service unavailable" }, 503);
    }

    let rateLimit;
    try {
      rateLimit = await env.FEEDBACK_RATE_LIMITER.limit({
        key: request.headers.get("cf-connecting-ip") || "unknown",
      });
    } catch {
      return json({ error: "feedback service unavailable" }, 503);
    }
    if (!rateLimit?.success) {
      return json({ error: "too many reports; try again later" }, 429);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return json({ error: "expected application/json" }, 415);
    }

    const contentLength = request.headers.get("content-length");
    if (/^\d+$/.test(contentLength || "") && Number(contentLength) > MAX_BODY_BYTES) {
      return json({ error: "report too large" }, 413);
    }

    let bodyRead;
    try {
      bodyRead = await readBodyWithinLimit(request.body, MAX_BODY_BYTES);
    } catch {
      return json({ error: "could not read body" }, 400);
    }
    if (bodyRead.tooLarge) {
      return json({ error: "report too large" }, 413);
    }

    let data;
    try {
      data = JSON.parse(bodyRead.raw);
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

    // Only well-formed reports reach this point, so a quota reservation is
    // spent on requests that would actually send. A configured quota that
    // cannot be consulted fails closed, like the per-IP limiter above.
    const quota = await reserveGlobalSend(env);
    if (quota === "unavailable") {
      return json({ error: "feedback service unavailable" }, 503);
    }
    if (quota === "exceeded") {
      return json({ error: "too many reports; try again later" }, 429);
    }
    if (quota === "unconfigured") {
      console.warn("FEEDBACK_QUOTA binding missing; aggregate send cap disabled");
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
