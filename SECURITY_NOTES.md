# Security notes

Last reviewed 2026-09-29.

## Rotating the APNs key (the `.p8` committed to this repo)

`AuthKey_8JSPR5Q2XB.p8` is in the repo and its git history, so treat it as
leaked. The server now reads the key from an env var first and only falls back
to a file path when that env var is unset, so rotating needs no code change.

1. **Create a new key.** Apple Developer → Certificates, Identifiers & Profiles
   → Keys → "+" → enable Apple Push Notifications service (APNs). Download the
   `.p8` (Apple only lets you download it once) and note the new **Key ID**.
   Don't put the file in this repo.
2. **Put it in Railway** (weekbelow-server → Variables):
   - `APNS_KEY_P8` = the full file contents, including the
     `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines.
     Pasting with real newlines works; so does `\n`-escaped text or the whole
     file base64-encoded (`base64 -i AuthKey_NEW.p8 | pbcopy`).
   - `APNS_KEY_ID` = the new Key ID.
   - Leave `APNS_TEAM_ID` (G3F945D68H) and the bundle/production vars as they are.
   - Delete `APNS_KEY_PATH` / `APN_KEY_PATH` if set (the env key wins anyway).
   The `APN_` prefix works too, but don't set both prefixes to different values.
3. **Deploy.** The boot log should say `APNs: configured ✓`, and
   `GET /push/status` (now needs a bearer token) should report
   `keySource: "env-var"` and the new `keyId`. Send a test push from the app.
4. **Revoke the old key** (`8JSPR5Q2XB`) in Apple Developer → Keys once the new
   one works.
5. **Remove it from the repo and its history:**
   ```sh
   git rm --cached AuthKey_8JSPR5Q2XB.p8
   echo '*.p8' >> .gitignore
   git commit -m "Remove APNs key from the repo"
   # rewrite history (needs `brew install git-filter-repo`), on a fresh clone:
   git filter-repo --invert-paths --path AuthKey_8JSPR5Q2XB.p8
   git push --force --all && git push --force --tags
   ```
   Everyone with a clone must re-clone after the force push.
6. **GitHub caches.** Rewritten history can still be reachable through cached
   views, forks and PR refs. Ask GitHub Support to purge cached views of the
   removed commits (github.com/taylor779/weekbelow-server). Revoking the key in
   step 4 is what actually protects you; the purge is only cleanup.

## Route protection

Studio routes need `Authorization: Bearer <Supabase access token>`. The server
checks the token with Supabase Auth, then checks that the caller is an active
member (or admin) of the agency named in the request. The route table in
`server.js` notes the rule next to each route.

Routes that are public by design, and what protects them:

| Route | Why public | Protection |
|---|---|---|
| `GET /` | health check | none needed |
| `GET /project-share/:token`, `POST /project-share/:token/edit` | client share links | 144-bit share token; edit needs the edit token; per-IP rate limit |
| `GET /quote/:token`, `POST /quote/:token/accept` | client quote e-sign page | quote accept token; per-IP rate limit |
| `GET /project-report/:agencyId/:projectId` | printable report | `?token=` must be the project's share token, or a member's bearer token |
| `POST /notify/new-brief` | `brief.html` has no login | only emails when a matching `client_briefs` row exists (same agency, `submitted_at` within 5 s, saved in the last 10 min); content comes from the saved row; each brief is emailed once; per-IP rate limit |
| `GET /agency-brand/:agencyId` | brief form branding | returns studio name + accent colour only |
| `GET/POST /push/prefs` | legacy stub | stores nothing |
| `GET /xero/connect`, `GET /xero/callback` | browser / Xero redirects | only accept an HMAC-signed, 15-minute `state` ticket issued by `POST /xero/connect-url` (auth + member) |
| `POST /stripe-webhook` | Stripe | archived: returns 200 and does nothing while `BILLING_ENABLED` is not `true` |

`POST /submit-brief` is retired (410). It was an open email relay and nothing
calls it.

## Leaving a studio

`POST /studio/leave { agencyId }` (bearer + member) deactivates the caller's own
`agency_members` row, never anyone else's. The only admin of a studio that still
has other active members gets 409 `transfer_admin_first`. The row is kept
(`active: false`), so an admin can re-enable it from Team; studio data is untouched.

## Who gets studio emails

- **New client brief:** active admins of the studio with an email address.
  Managers, deactivated or removed members and guests are left out. To choose
  recipients yourself, set `app_state.brand.briefNotifyMemberIds` to an array of
  `agency_members.id`; those members still have to be active in that studio.
- **Quote accepted:** `brand.quoteDetails.email` (set by the studio).
- **Weekly recap:** each active member whose `emailWeekly` preference is on.
- **Assignment emails:** the assigned member, only if they're an active member
  of the studio and their `emailAssign` preference isn't off.
- **Feedback:** `ADMIN_EMAIL` only.
- **Bulk email:** active admins of every studio. Only the platform owner can
  send it (checked on the verified token).

## WebSocket

A socket must authenticate before the server processes anything else. It does
that by sending `{type:'auth', token}` as its first message, or by passing
`?token=` on the URL. The server no longer sends app state on connect. It only
broadcasts to sockets that belong to the payload's agency, and it closes sockets
that haven't authenticated after 30 s.

## Rate limits

Limits are in memory and apply per IP (global and public routes) or per user
(AI, email, push, writes). To switch them all off, set `RATE_LIMITS=off` in
Railway.

## Config

- `ADMIN_EMAIL` sets the platform owner email (default `taylor@below.co.nz`,
  which must be a confirmed email).
- `PLATFORM_ADMIN_UID` is optional. It's the owner's Supabase auth id, and when
  set it's used instead of the email.
- `XERO_STATE_SECRET` is optional. It's the key used to sign Xero OAuth state
  and defaults to a hash of `XERO_CLIENT_SECRET`.

## Claude connector (`mcp-connector.js`, added 2026-10-13)

Remote MCP server so Claude can create projects and fill in shot lists, run sheets and
storyboards. Off unless `MCP_OAUTH_SECRET`, `SUPABASE_ANON_KEY` and `PUBLIC_URL` are set.

- **Auth.** OAuth 2.1 with PKCE (S256). The sign-in page uses Supabase Auth (email/password
  or Google). The tokens Claude holds are the user's own Supabase access/refresh tokens, so the
  connector can do no more than that user can. Every MCP call is verified with
  `userFromToken`, and every tool checks studio membership; writes also need
  `can_manage_projects` (or admin/manager), budgets need `can_edit_budgets` (or admin).
- **Clients.** Dynamic registration is stateless: `client_id` is HMAC-signed with
  `MCP_OAUTH_SECRET` and carries its redirect URIs. Only Claude's callbacks
  (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`),
  loopback URIs and `MCP_REDIRECT_URIS` are accepted. Rotating the secret makes everyone
  reconnect.
- **PUBLIC routes.** `/.well-known/oauth-*`, `/oauth/*` (rate-limited), and
  `/mcp/upload/:token`: a one-time 144-bit link, 2 h TTL, PDF only, 60 MB cap, max 4 uploads
  in flight, checked before the body is read. Uploads stay in memory and are bound to the
  user and studio that made the link.
- **PDF parsing** runs in a worker thread (768 MB heap cap, 45 s timeout) with bounded
  inflation, a pixel cap and a draw cap (`mcp-pdf-frames.js`).
- **Data.** Writes use `casUpdateAppState` + `state_update`. Free text is stripped of `<` and `>`.
  Project-doc imports only read paths under the caller's own studio folder.
- **Single instance.** OAuth codes and uploads are in memory; a restart just means reconnect /
  new upload link.

### AI connector: Grok (2026-11-20)
- Grok (grok.com custom connector) uses the same OAuth + MCP endpoint as Claude. Allowed redirect URIs: Claude's two callbacks, loopback, `MCP_REDIRECT_URIS`, and any `https://` URL on `grok.com` / `x.ai` or their subdomains (no userinfo). PKCE S256 is still required and the user signs in on our page.
- New read tool `bsmnt_read_studio_data` reads with the service key, always filtered by the caller's own `agency_id` (membership checked first). Team rates and `business_costs` only for role `admin`; time logs for others only with reports permission.
- New writes (tasks, time, clients, client requests) go through `casUpdateAppState` + `state_update` like the other connector writes. There are no delete tools.
- Everything an assistant reads is sent to that AI provider (Anthropic or xAI).

