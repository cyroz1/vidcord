import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const MAX_BODY_BYTES = 256 * 1024;
const headers = {
  "content-type": "application/json",
  "x-vidcord-feedback": "test-token",
  "cf-connecting-ip": "203.0.113.20",
};

function makeRateLimiter(success = true) {
  return {
    limit: async () => ({ success }),
  };
}

function makeEnv(overrides = {}) {
  return {
    FEEDBACK_TOKEN: "test-token",
    FEEDBACK_RATE_LIMITER: makeRateLimiter(),
    ...overrides,
  };
}

test("streams an oversized body only until the byte limit is crossed", async () => {
  let pulls = 0;
  let canceled = false;
  const stream = new ReadableStream(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1));
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 }
  );
  const request = new Request("https://vidcord.app/api/feedback", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  });

  const response = await worker.fetch(request, makeEnv());
  assert.equal(response.status, 413);
  assert.equal(pulls, 1);
  assert.equal(canceled, true);
});

test("enforces the cap in UTF-8 bytes and accepts valid reports within it", async (t) => {
  const originalFetch = globalThis.fetch;
  let emailRequests = 0;
  globalThis.fetch = async () => {
    emailRequests += 1;
    return new Response(null, { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const oversizedJson = JSON.stringify({ subject: "feedback", body: "é".repeat(131_100) });
  assert.ok(oversizedJson.length < MAX_BODY_BYTES);
  assert.ok(new TextEncoder().encode(oversizedJson).byteLength > MAX_BODY_BYTES);
  const oversized = await worker.fetch(
    new Request("https://vidcord.app/api/feedback", {
      method: "POST",
      headers,
      body: oversizedJson,
    }),
    makeEnv({ RESEND_API_KEY: "test-key" })
  );
  assert.equal(oversized.status, 413);

  const accepted = await worker.fetch(
    new Request("https://vidcord.app/api/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify({ subject: "feedback", body: "small report" }),
    }),
    makeEnv({ RESEND_API_KEY: "test-key" })
  );
  assert.equal(accepted.status, 200);
  assert.equal(emailRequests, 1);
});

test("rejects an oversized declared body before reading it", async () => {
  let pulls = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("{}"));
      },
    },
    { highWaterMark: 0 }
  );
  const request = new Request("https://vidcord.app/api/feedback", {
    method: "POST",
    headers: { ...headers, "content-length": String(MAX_BODY_BYTES + 1) },
    body: stream,
    duplex: "half",
  });

  const response = await worker.fetch(request, makeEnv());
  assert.equal(response.status, 413);
  assert.equal(pulls, 0);
});

test("rate limits valid reports before forwarding them to Resend", async (t) => {
  const originalFetch = globalThis.fetch;
  let emailRequests = 0;
  let rateLimitKey;
  globalThis.fetch = async () => {
    emailRequests += 1;
    return new Response(null, { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const rateLimiter = {
    limit: async ({ key }) => {
      rateLimitKey = key;
      return { success: false };
    },
  };
  const response = await worker.fetch(
    new Request("https://vidcord.app/api/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify({ subject: "feedback", body: "small report" }),
    }),
    makeEnv({ FEEDBACK_RATE_LIMITER: rateLimiter, RESEND_API_KEY: "test-key" })
  );

  assert.equal(response.status, 429);
  assert.equal(rateLimitKey, "203.0.113.20");
  assert.equal(emailRequests, 0);
});

test("fails closed when the rate limit binding is missing or unavailable", async () => {
  const noBinding = await worker.fetch(
    new Request("https://vidcord.app/api/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify({ subject: "feedback", body: "small report" }),
    }),
    makeEnv({ FEEDBACK_RATE_LIMITER: undefined })
  );
  assert.equal(noBinding.status, 503);

  const unavailable = await worker.fetch(
    new Request("https://vidcord.app/api/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify({ subject: "feedback", body: "small report" }),
    }),
    makeEnv({
      FEEDBACK_RATE_LIMITER: {
        limit: async () => {
          throw new Error("unavailable");
        },
      },
    })
  );
  assert.equal(unavailable.status, 503);
});
