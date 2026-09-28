# Native AI proxy and request auth

> ## ⚠️ Security: `AuthKey_8JSPR5Q2XB.p8` is committed to this public repo
>
> The APNs signing key `AuthKey_8JSPR5Q2XB.p8` is checked into git in a **public**
> repository. Treat it as compromised. This branch does **not** touch it. You need to:
>
> 1. **Revoke** key `8JSPR5Q2XB` in Apple Developer → Certificates, IDs & Profiles → Keys.
> 2. **Create a new APNs key** and give it to the server via Railway secrets/env
>    (for example the key contents in an env var, written to a temp file at boot or
>    passed straight to node-apn), not via a file in the repo. Add `*.p8` to `.gitignore`.
> 3. **Purge it from git history** (`git filter-repo --path AuthKey_8JSPR5Q2XB.p8 --invert-paths`
>    or BFG), force-push, and ask anyone with a clone to re-clone. Revoking comes first:
>    rewriting history does not un-leak a key that is already public.

## What changed (branch `native-ai-proxy`)

| File | Change |
|---|---|
| `auth.js` (new) | `requireUser(req)`, `requireMember(userId, agencyId)`, `softAuth` and `requireAuth` middleware. |
| `ai-proxy.js` (new) | `POST /ai/claude` handler: Anthropic Messages proxy with auth, membership check, key selection, studio-token billing, model/tool whitelist, rate limit and usage logging. |
| `server.js` | `supabaseAdmin.auth.getUser(token)` added to the REST shim (calls `GET /auth/v1/user` with the service key). Auth helpers wired in. `/ai/claude` mounted with `requireAuth`. `/generate-image` now goes through `softAuth`. CORS exposes the `X-Studio-*` / `X-AI-Key-Source` headers. |

### Auth helpers (`auth.js`)

- **`requireUser(req)`** reads `Authorization: Bearer <supabase access token>` and verifies it with
  Supabase Auth using the service-role key. It returns the user, or `null` when there is no token or
  the token is invalid. Valid results are cached in memory for 60 s per token.
- **`requireMember(userId, agencyId)`** returns the `agency_members` row where `user_id` and
  `agency_id` match and `active != false`, or `null` when there is none. Results are cached for 60 s.
- **`softAuth`** is opt-in middleware. It sets `req.authUser` when a valid token is present and
  **never rejects**, so the web app, which sends no token, keeps working.
- **`requireAuth`** is strict middleware. It returns 401 unless a valid token is present. Use it for
  new endpoints.

### `/generate-image`

- **Valid bearer token present:** the caller must be an active member of `body.agencyId`, otherwise
  the endpoint returns 403.
- **No token, or an invalid token:** behaviour is unchanged. This keeps the web app working until
  it sends tokens.

## `POST /ai/claude` contract

**Headers:** `Authorization: Bearer <supabase access token>` (required) and `Content-Type: application/json`.

**Body:**

```json
{
  "agencyId": "string (required)",
  "model": "claude-sonnet-4-6",
  "system": "string | [content blocks]  (optional)",
  "messages": [{ "role": "user", "content": "..." }],
  "max_tokens": 4096,
  "tools": [{ "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }]
}
```

- **`model`:** `claude-sonnet-4-6` or any newer Sonnet, and `claude-haiku-4-5` or any newer Haiku.
  An optional `-YYYYMMDD` suffix is allowed. Opus and older models return 400.
- **`max_tokens`:** capped at **8000**. A missing or invalid value becomes 4096.
- **`messages`:** a non-empty array of at most 200 items. It is passed through in Anthropic format,
  so image and document blocks work.
- **`tools`:** allowed tools are the `web_search_YYYYMMDD` server tool, with `max_uses` capped at 5,
  and plain client-defined tools (`name` + `input_schema`). Any other server tool returns 400.
- **Dropped fields:** anything else in the body is dropped, including `stream`, `temperature` and
  `tool_choice`. Streaming is not supported.

**Success (200):** the Anthropic Messages API JSON, returned exactly as Anthropic sent it
(`id`, `content`, `stop_reason`, `usage`, ...). The server does not run a `pause_turn` from web
search again. The client continues it.

Response headers:
- `X-AI-Key-Source: own | platform`
- `X-Studio-Tokens-Charged: <n>` (platform key only)
- `X-Studio-Token-Balance: <n>` (platform key only)

**Errors:** every error has the body `{ "error": "message" }`.

| Status | When |
|---|---|
| 400 | Bad body: missing `agencyId`, disallowed model or tool, bad `messages` or `system`. Also Anthropic 400s such as an invalid message shape. |
| 401 | The bearer token is missing or invalid. |
| 402 | The platform key is in use and `token_balance < 1`. The body also includes `tokenBalance`. |
| 403 | The user is not an active member of `agencyId`. |
| 404 / 413 | Passed through from Anthropic (unknown model, request too large). |
| 429 | The per-user rate limit is hit (a `Retry-After` header is set), or Anthropic returned 429. |
| 500 | Server misconfiguration (`ANTHROPIC_API_KEY` unset, Supabase unavailable). |
| 502 | Upstream error or auth failure. If the agency's own key was rejected, the message says so. |
| 503 | Anthropic is overloaded (529 or 503). |
| 504 | The upstream call timed out (180 s). |

Studio tokens are refunded on every non-200 response that happens after the charge.

### Key selection
1. If `agency_settings.use_own_key === true` and `anthropic_key` is non-empty, the server uses the
   agency's key. The key never leaves the server and **no studio tokens are charged**.
2. Otherwise the server uses the platform key from env `ANTHROPIC_API_KEY` and charges studio tokens.

### Studio token cost (platform key)
- `tokens = max(1, ceil(estimated_usd / $0.10))`
- $0.10 is the cheapest price a studio token is ever sold at (400 tokens for $40), so a call is never
  billed below cost.
- The estimate uses list prices:
  - Sonnet: $3 per million input tokens, $15 per million output tokens.
  - Haiku: $1 per million input tokens, $5 per million output tokens.
  - Cache writes cost 1.25× the input price. Cache reads cost 0.1×.
  - Web search costs $0.01 per search.
- **Typical calls cost 1 token**, the same as one `/generate-image`. For example, 5k tokens in and
  1k out comes to about $0.03.
- A heavy call costs more. For example, 100k tokens in, 8k out and 5 searches comes to about $0.47,
  which is 5 tokens.
- **How the charge is taken:**
  1. One token is reserved up front. If the balance is below 1, the call returns 402.
  2. Any extra is deducted after the response, and the balance never goes below 0.
  3. If the call fails, the reserved token is refunded.
- Balance writes use compare-and-set on the previous value (`PATCH ... token_balance=eq.<old>`), so
  concurrent calls cannot double-spend.
- To change pricing, edit `STUDIO_TOKEN_USD`, `MIN_CHARGE` and `PRICING` in `ai-proxy.js`.

### Limits and logging
- **Rate limit:** 20 requests per minute and 300 per hour per user. It is kept in memory, so it
  resets on redeploy and is enforced per instance.
- **Usage log line:** records the user id prefix, agency, model, key source, input, output and cache
  token counts, search count, tokens charged, balance and latency.
- **Never logged:** prompt and completion contents.

## Env vars

| Var | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | **New.** The platform Anthropic key for `/ai/claude`. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Already set. Now also used to verify user JWTs. |
| `GEMINI_API_KEY` | Already set (`/generate-image`). |

## Deploy
1. Add `ANTHROPIC_API_KEY` in Railway → the service → Variables.
2. Merge `native-ai-proxy` into `main`. Railway auto-deploys `main`. No new npm dependencies are
   needed: Node 20 has global `fetch`.
3. Smoke test:
   ```sh
   curl -s -X POST "$RAILWAY_URL/ai/claude" \
     -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'Content-Type: application/json' \
     -d '{"agencyId":"<id>","model":"claude-sonnet-4-6","max_tokens":64,"messages":[{"role":"user","content":"Say hi"}]}' -i
   ```
   Expect 200, an `X-AI-Key-Source` header, and a one-token charge on platform-key agencies. Without
   the header, expect 401.

## Follow-up plan

**Step 1: switch the web app's AI calls to the server.**
- Replace every client-side `fetch('https://api.anthropic.com/...')` with
  `POST /ai/claude` and the header `Authorization: Bearer ${session.access_token}`.
- Add a Gemini text proxy, for example `/ai/gemini`, using the same pattern if the web still calls
  Gemini directly for text.
- Route any OpenAI usage the same way.
- The web app then sends the Supabase token on **all** Railway requests.

**Step 2: take the keys out of client reach.**
- Once no client reads `anthropic_key`, `gemini_key` or `openai_key`, lock down `agency_settings`
  with RLS. Clients may read and write only non-secret columns. The secret columns move to a separate
  table with no client policies, readable only with the service role.
- Add a server endpoint to set or clear the agency's own key. It is write-only and never returns the
  key.
- **Rotate** every key that was ever stored in `agency_settings`, because clients could read them.

**Step 3: move existing endpoints to `requireAuth`.**
- Once the web sends tokens, add `requireAuth` plus membership checks to the endpoints that are still
  unauthenticated, starting with the ones that spend money or change data:
  - `/generate-image`
  - `/briefing` and `/ai-brainstorm`
  - `/invite-member`
  - `/set-member-active`
  - `/append-time-log`
  - `/push/*`
  - `/bulk-email` and `/gift-tokens-email`
  - `/send-*`
  - `/save-user-pref`
  - `/notify/*`
- Keep public, token-based share endpoints open (`/quote/:token`, `/project-share/:token`,
  `/submit-brief`, `/agency-brand/:agencyId`).
- For `/generate-image`, switch `softAuth` to `requireAuth` once the web sends tokens.

**Step 4: purge the prospect hunter's key use.** `prospect-hunter.js` reads `agency_settings.anthropic_key`
server-side. That is safe, but it should follow the same `use_own_key` and platform-key-plus-tokens
rule for consistency.

## Known pre-existing issue (not changed here)
In `supaRest` (`server.js`), `'Prefer': 'return=representation'` comes after `...extraHeaders`, so it
overwrites the `resolution=merge-duplicates` header that the fluent `.upsert()` sets.

As a result, `.upsert()` calls, and the raw `supaRest('POST', 'agency_settings', …)` calls in
`/generate-image`, behave as plain INSERTs. They will likely fail with 409 on an existing row. That
would break image token charging and refunds, and Stripe token top-ups.

`/ai/claude` does not depend on this: it uses PATCH with compare-and-set. The issue is worth checking
and fixing separately.
