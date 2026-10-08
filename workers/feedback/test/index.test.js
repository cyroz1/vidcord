import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const MAX_BODY_BYTES = 256 * 1024;
const headers = {
  "content-type": "application/json",
  "x-vidcord-feedback": "test-token",
};

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

  const response = await worker.fetch(request, { FEEDBACK_TOKEN: "test-token" });
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
    { FEEDBACK_TOKEN: "test-token", RESEND_API_KEY: "test-key" }
  );
  assert.equal(oversized.status, 413);

  const accepted = await worker.fetch(
    new Request("https://vidcord.app/api/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify({ subject: "feedback", body: "small report" }),
    }),
    { FEEDBACK_TOKEN: "test-token", RESEND_API_KEY: "test-key" }
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

  const response = await worker.fetch(request, { FEEDBACK_TOKEN: "test-token" });
  assert.equal(response.status, 413);
  assert.equal(pulls, 0);
});
