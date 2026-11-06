import assert from "node:assert/strict";
import test from "node:test";
import worker, { FeedbackQuota } from "../src/index.js";

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

test("rejects valid JSON that is not a report object without forwarding it", async (t) => {
  const originalFetch = globalThis.fetch;
  let emailRequests = 0;
  globalThis.fetch = async () => {
    emailRequests += 1;
    return new Response(null, { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const value of [null, [], "report", 42, false, { subject: "feedback" }]) {
    const response = await worker.fetch(
      new Request("https://vidcord.app/api/feedback", {
        method: "POST",
        headers,
        body: JSON.stringify(value),
      }),
      makeEnv({ RESEND_API_KEY: "test-key" })
    );
    assert.equal(response.status, 400, `expected rejection for ${JSON.stringify(value)}`);
    assert.deepEqual(await response.json(), { error: "subject and body are required" });
  }
  assert.equal(emailRequests, 0);
});

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

function makeQuotaNamespace(outcome) {
  return {
    getByName: () => ({
      fetch: async () => {
        if (outcome instanceof Error) throw outcome;
        return new Response(JSON.stringify(outcome), { status: 200 });
      },
    }),
  };
}

test("enforces the aggregate send cap before forwarding to Resend", async (t) => {
  const originalFetch = globalThis.fetch;
  let emailRequests = 0;
  globalThis.fetch = async () => {
    emailRequests += 1;
    return new Response(null, { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const request = () =>
    new Request("https://vidcord.app/api/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify({ subject: "feedback", body: "small report" }),
    });

  const exceeded = await worker.fetch(
    request(),
    makeEnv({
      FEEDBACK_QUOTA: makeQuotaNamespace({ allowed: false }),
      RESEND_API_KEY: "test-key",
    })
  );
  assert.equal(exceeded.status, 429);
  assert.equal(emailRequests, 0);

  const allowed = await worker.fetch(
    request(),
    makeEnv({
      FEEDBACK_QUOTA: makeQuotaNamespace({ allowed: true }),
      RESEND_API_KEY: "test-key",
    })
  );
  assert.equal(allowed.status, 200);
  assert.equal(emailRequests, 1);
});

test("fails closed when a configured aggregate quota cannot be consulted", async (t) => {
  const originalFetch = globalThis.fetch;
  let emailRequests = 0;
  globalThis.fetch = async () => {
    emailRequests += 1;
    return new Response(null, { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await worker.fetch(
    new Request("https://vidcord.app/api/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify({ subject: "feedback", body: "small report" }),
    }),
    makeEnv({
      FEEDBACK_QUOTA: makeQuotaNamespace(new Error("quota down")),
      RESEND_API_KEY: "test-key",
    })
  );
  assert.equal(response.status, 503);
  assert.equal(emailRequests, 0);
});

test("FeedbackQuota admits sends up to the hourly ceiling, then refuses", async () => {
  const store = new Map();
  const state = {
    storage: {
      transactionSync(callback) {
        callback({
          get: (key) => store.get(key),
          put: (key, value) => store.set(key, value),
          delete: (key) => store.delete(key),
        });
      },
    },
  };
  const quota = new FeedbackQuota(state);
  const reserve = async () =>
    (await quota.fetch(new Request("https://quota/reserve", { method: "POST" }))).json();

  // The hourly ceiling is 30: the first 30 reservations pass, the next is
  // refused, and a refused reservation does not consume a slot.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    assert.equal((await reserve()).allowed, true);
  }
  assert.equal((await reserve()).allowed, false);
  assert.equal((await reserve()).allowed, false);
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
