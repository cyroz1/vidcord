# vidcord-feedback Worker

Receives explicit bug reports from the desktop dialog and website form at
`POST https://vidcord.app/api/feedback`, then forwards them through Resend to
`owner@vidcord.app`. The Worker is a separate deployment from the static site.
The frontends contain a public shared token; only the Worker holds the Resend
credential. Source: [index.js](src/index.js), [wrangler.jsonc](wrangler.jsonc),
and [shared frontend submission](../../src/feedback.ts).

## Configuration and deployment

Use Wrangler 4.36.0 or newer for the configured rate-limit binding. Commands
below run from this directory; `cfw` is an optional local wrapper, not a
repository-provided command.

1. Create a Resend API key and verify `vidcord.app` in Resend so the sender
   `Vidcord Bug Reports <bugs@vidcord.app>` is allowed.
2. Configure both secrets. `FEEDBACK_TOKEN` must match the value compiled
   into `src/feedback.ts`; it is not authentication or a private API key.
3. Deploy the Worker to the route declared in its configuration.

```sh
cd workers/feedback
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put FEEDBACK_TOKEN
npx wrangler deploy
```

`workers_dev` is disabled. The route is `vidcord.app/api/feedback*`; publishing
static assets through the root site config does not deploy this Worker.
Missing Resend configuration returns `503 email not configured` after earlier
request validation succeeds. The desktop dialog then offers a user-selected
email fallback; the website displays an error. No email client opens automatically.

## Request and response contract

`OPTIONS` returns 204 with CORS headers. Only `POST` accepts reports; other
methods return 405. CORS permits all origins and the `content-type` and
`x-vidcord-feedback` headers.

POST requests must use `application/json`, supply the matching
`X-Vidcord-Feedback` header, and include nonempty string `subject` and `body`
fields. The Worker bounds the streamed request body to 256 KiB even without a
Content-Length header. Forwarded subjects are truncated to 120 characters and
email text to 100,000 characters. It sends text only and does not attach the
local desktop report file or video.

| Result                                                | HTTP status            |
| ----------------------------------------------------- | ---------------------- |
| Forwarded successfully                                | 200 with `{"ok":true}` |
| Missing or mismatched public token                    | 401                    |
| Rate limit exceeded                                   | 429                    |
| Missing/unavailable limiter, or missing Resend key    | 503                    |
| Unsupported content type                              | 415                    |
| Body too large                                        | 413                    |
| Invalid JSON, unreadable body, or missing text fields | 400                    |
| Resend network error or rejection                     | 502                    |

The Cloudflare binding allows five accepted token-bearing attempts per minute
per source IP per Cloudflare location. It runs before body validation and
fails closed if the binding is missing or unavailable. The public token cannot
stop determined clients; a Cloudflare WAF rate-limit rule can add protection.
Rotate an abused token in both the secret and `src/feedback.ts`, then rebuild
the clients; older clients otherwise stop matching it.

## Diagnostics and retention

Desktop report collection includes app/system details and up to 100 log lines
in the submitted email body. A private local copy includes up to 500 log lines;
it is deleted best-effort after confirmed endpoint success, retained for the
manual email fallback on failure, and swept after seven days when another
report is collected. Website reports include the description, page URL, browser
user agent, and language. See [the architecture guide](../../docs/ARCHITECTURE.md)
for the corresponding frontend and backend source paths.

## Local verification

From the repository root:

```sh
node --check workers/feedback/src/index.js
node --test workers/feedback/test/index.test.js
```

These tests mock forwarding and do not send real email. They are separate from
`npm test`, whose Vitest include is limited to `src/`; no dedicated Worker CI
job currently invokes this suite. For an intentional live smoke test, use the
site's Report a bug form with an identifiable test description; successful
submission sends an actual email to the developer.
