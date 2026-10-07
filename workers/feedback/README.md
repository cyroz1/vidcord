# vidcord-feedback worker

Receives bug reports POSTed by the Vidcord desktop app (`POST vidcord.app/api/feedback`)
and forwards them to `owner@vidcord.app` via Resend. The app holds no credentials —
all secrets live here as worker secrets.

## Secrets

| Name             | Value                                                        | Set by |
|------------------|--------------------------------------------------------------|--------|
| `RESEND_API_KEY` | Resend API key (create at resend.com/api-keys)               | owner  |
| `FEEDBACK_TOKEN` | Random shared token, also compiled into the app (`src/feedback.ts`) | deploy |

Set them with:

```
cd workers/feedback
cfw secret put RESEND_API_KEY
cfw secret put FEEDBACK_TOKEN
```

## Prereqs (owner, one time)

1. Create a Resend account and API key.
2. Verify `vidcord.app` in Resend (add their DNS records) so the
   `bugs@vidcord.app` sender address is allowed.
3. Add the `RESEND_API_KEY` secret (above).

Until the key is set, the endpoint returns `503 email not configured` and the
app falls back to opening the user's mail app.

## Deploy

```
cd workers/feedback
cfw deploy
```

The `routes` in `wrangler.jsonc` attach it to `vidcord.app/api/feedback*`.

## Abuse protection

- The `X-Vidcord-Feedback` token stops drive-by curl spam. It ships in the
  public repo, so it is obfuscation, not auth — rotate it with
  `cfw secret put FEEDBACK_TOKEN` and update `src/feedback.ts` if it leaks.
- Real protection is a WAF rate-limiting rule on `vidcord.app/api/feedback*`
  (e.g. 10 requests/minute per IP). Manage it in the Cloudflare dashboard
  under Security → WAF → Rate limiting rules.

## Test

```
curl -X POST https://vidcord.app/api/feedback \
  -H 'content-type: application/json' \
  -H 'x-vidcord-feedback: <token>' \
  -d '{"subject":"test","body":"hello"}'
```

Expect `{"ok":true}` and an email at `owner@vidcord.app`.
Omit the token header to expect `401`.
