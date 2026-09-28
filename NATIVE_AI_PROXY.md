# Native + server fixes: AI proxy, request auth and server bug fixes

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

## Server fixes (branch `native-ai-proxy`)

Each fix is its own commit. None of them needs a web change unless it says so.

### 1. `supaRest` Prefer header merge (upserts)

**Bug:** `supaRest` set `Prefer: return=representation` after `...extraHeaders`, so it overwrote the
`resolution=merge-duplicates` value that `.upsert()` passes. Every upsert ran as a plain INSERT and
failed with 409 on an existing row. Since `supaRest` now rejects non-2xx responses, `/generate-image`
returned 500 for every agency that already had an `agency_settings` row.

**Fix:**
- `supaRest` merges Prefer values into one comma-separated header and adds `return=representation`
  only when no `return=` value was passed.
- `.upsert(..., { ignoreDuplicates: true })` sends `resolution=ignore-duplicates`.
- An empty `onConflict` no longer sends `on_conflict=`, so PostgREST falls back to the primary key.
- If PostgREST answers `42P10` (no unique constraint matches `on_conflict`), the builder logs a
  warning and retries as a plain INSERT. That is the old behaviour, so a table that lacks the
  constraint does not start failing every write.

**Upsert call sites audited:**

| Call site | Conflict target | Notes |
|---|---|---|
| `/generate-image` charge and refunds | `agency_settings.agency_id` | Was a raw `supaRest('POST')` with no `on_conflict`. Now `_setAgencyTokenBalance()`, a fluent upsert. |
| `/gift-tokens-email` | `agency_settings.agency_id` | Already correct. It works now that the Prefer value survives. |
| `_patchBrand` (Stripe plan and status) | `agency_settings.agency_id` | Already correct. |
| Stripe token purchase and monthly allowance | `agency_settings.agency_id` | **These were not upserts.** They credited only `app_state.brand.tokenBalance`, which no client or endpoint reads: the web and `/generate-image` / `/ai/claude` read `agency_settings.token_balance`. They now also credit `agency_settings.token_balance` through `_creditAgencyTokens()`. |
| `/push/register-token` → `device_tokens` | `token` | Was `user_id,token`. The schema (`01_supabase_schema.sql`) declares `token TEXT NOT NULL UNIQUE` and no `(user_id, token)` constraint. On `token`, a device that signs in as another user is re-pointed instead of hitting 23505. |
| `/invite-member` → `invites` | `agency_id,email` | Unchanged. It needs a unique constraint on `(agency_id, email)`; without one it falls back to INSERT. |
| `/accept-project-invite` → `shared_projects`, `shared_project_data` | `project_id,guest_agency_id` and `project_id,owner_agency_id` | Unchanged. The same fallback applies. |
| `notification_prefs` | — | The server never writes it. `/push/prefs` is a stub. |
| `xero-routes.js` `xero_connections` | `agency_id` | Uses its own `fetch` with a correct Prefer header. Unaffected. |

**Verify:**
1. On an agency that already has an `agency_settings` row, `POST /generate-image` should return 200
   (or a Gemini error), not a 500 with "duplicate key".
2. Afterwards `token_balance` has dropped by 1, and it is refunded on a Gemini failure.
3. Register the same push token twice through `/push/register-token`. The second call returns
   `{ok:true}` and `last_seen_at` updates.
4. In Railway logs, `falling back to INSERT` means a table is missing its unique constraint. Add
   the constraint.

### 2. `POST /account/delete` (new)

**Callers:**
- The web (`deleteAccountConfirmed`, app.html around L33170) sends `POST /account/delete` with the
  body `{ "token": "<supabase access token>" }` and **no** Authorization header. It treats any 2xx as
  success, shows `resp.text()` on failure, then signs out.
- The native app (`MyAccountView.swift`) sends the same body **and** `Authorization: Bearer`.

**Auth:** `requireAuth`. Identity comes only from a verified Supabase access token, never from a user
id in the body.
- For the web, `_bodyTokenToBearer` copies `body.token` into the Authorization header when no header
  is present. The token is still verified with Supabase Auth, so this is not weaker than the header,
  and the web works today with no change.
- **Web should change** to send `Authorization: Bearer <access_token>`. Once it does, the body
  fallback can be removed.

**Behaviour:**
1. Loads the caller's `agency_members` rows.
2. Returns **409** `{ error, code: "transfer_admin_first", agencyId }` if the caller is the only active
   admin of a studio that has other active members. Nothing is changed when this happens.
3. Sets every membership row to `active = false`. It then tries to set `user_id = null` on those
   rows, so a foreign key to `auth.users` can neither block nor cascade the delete.
   - If `user_id` is NOT NULL, that second step is skipped with a warning.
   - Studio data (`app_state`, `agency_settings`, projects) is **not** deleted, even when the caller
     was the only member.
4. Deletes the caller's `device_tokens`, `notification_prefs` and `notifications_sent` rows.
   `notification_prefs` and `notifications_sent` are best effort.
5. Calls `DELETE /auth/v1/admin/users/{id}` with the service key. A 404 counts as already deleted.
6. Clears the auth and membership caches for the user, then returns `{ ok: true }`.
7. Logs only an 8-character user id prefix. No email or name is logged.

**Verify:**
1. Without a token, expect `401`:
   ```sh
   curl -si -X POST $RAILWAY_URL/account/delete -H 'Content-Type: application/json' -d '{}'
   ```
2. With a token from a throwaway user, expect `200 {"ok":true}`:
   ```sh
   curl -si -X POST $RAILWAY_URL/account/delete -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}"
   ```
   Afterwards the user is gone from Auth → Users, and their `agency_members` rows have
   `active = false`.
3. As the sole admin of a studio that has another active member, expect `409`.

### 3. Weekly recap recipients now come from `agency_members`

**Bug:**
- `POST /send-recap` and the websocket `send_recap_now` message, the manual recaps, read
  `app_state.users`. That column does not exist, so they always sent 0 emails.
- The Friday 3pm recap cron already read `agency_members`, but it ignored the `emailWeekly` opt-out.
- It also never passed `to` to `sendEmail`, because `weeklyEmail()` returns only `{subject, html}`,
  so no recap was ever delivered.
- `_buildUserRecap` returned shapes the template could not render: an array for "tasks done",
  projects without `client` or `budgetPct`, and due items without labels.

**Fix:**
- `_recapRecipients(agencyId)` selects `agency_members` for the agency and keeps rows that are
  active, have an email, and have the weekly email switched on. The weekly check uses
  `preferences.emailWeekly`, then the legacy `email_weekly` column, and defaults to on, which is the
  same order the web uses.
- The Friday cron, `/send-recap` and `send_recap_now` all use it, and they send through
  `_sendMemberRecap`, which sets `to`.
- `_buildUserRecap` now matches projects by `assigned` (member ids) as well as the legacy `wbState`.
  It computes the budget % from member `charge_rate` and returns template-ready rows.
- Cron logs now carry a member id prefix, not the email.

**Other crons checked:**
- The 8:45am "track your time" push (`pushForgotToTrack`) and the 2h long-timer push already read
  `agency_members`, so they are fine.
- There is **no server-side "daily summary at 5pm" cron**. The web shows a `pushDailySummary`
  toggle, but nothing sends it.
- The Monday `sendWeeklyRecaps`/`scheduleWeeklyRecap` still reads the in-memory legacy `appState.users`.
  It is dead code: `scheduleWeeklyRecap()` is never called. It was left alone.

**Verify:**
1. Call `/send-recap` as the admin:
   ```sh
   curl -s -X POST $RAILWAY_URL/send-recap -H 'Content-Type: application/json' -d '{"agencyId":"<id>","adminEmail":"<ADMIN_EMAIL>"}'
   ```
   Expect `{"ok":true,"sent":N}` with N > 0, and the email arrives.
2. Set `preferences.emailWeekly=false` on one member, call it again, and expect N to drop by one.

### 4. Focus mode suppresses pushes

The native app writes `preferences.focusModeOn` and `preferences.focusModeUntil` (ISO) to the user's
`agency_members` row while a focus session runs (see `ExtrasFocusMode.swift`).

`_pushPrefOn()` now returns false, so no push is sent, when `focusModeOn === true` and either
`focusModeUntil` is missing or `Date.parse(focusModeUntil) > Date.now()`. An expired
`focusModeUntil` lets pushes resume even if the app never cleared the flag.

This covers every preference-gated push: admin, assignment, comment and brief notifications, the
2h timer check and the 8:45am reminder. `/push/send`, the diagnostic "send test", is not
preference-gated and still sends.

**Verify:** set `preferences = {"focusModeOn": true, "focusModeUntil": "<now + 10 min>"}` on a
member, then trigger `/notify/project-assigned` for them. No push arrives, and `sendPushToUser` is
never reached for them. Set `focusModeUntil` in the past and repeat. The push arrives.

