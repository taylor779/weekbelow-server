/**
 * BSMNT — Live Sync WebSocket Server + Token Payment API
 * ────────────────────────────────────────────────────────
 * Requirements:  Node.js 20+
 * Install:       npm install ws stripe @supabase/supabase-js
 * Run:           node server.js
 *
 * Railway env vars:
 *   RESEND_API_KEY        — Resend API key
 *   BILLING_ENABLED       — 'true' re-enables the archived Stripe billing routes (default off)
 *   STRIPE_SECRET_KEY     — Stripe secret key (only used when BILLING_ENABLED=true)
 *   STRIPE_WEBHOOK_SECRET — Stripe webhook signing secret (only used when BILLING_ENABLED=true)
 *   GEMINI_API_KEY        — Platform Gemini key (never sent to client)
 *   ANTHROPIC_API_KEY     — Platform Anthropic key for /ai/claude (never sent to client)
 *   SUPABASE_URL          — https://fdjnzzrrodrjkngqzewy.supabase.co
 *   SUPABASE_SERVICE_KEY  — Supabase service_role key (bypasses RLS)
 *   ADMIN_EMAIL           — taylor@below.co.nz (platform owner; matched on the verified token)
 *   PLATFORM_ADMIN_UID    — optional Supabase auth id of the platform owner (overrides ADMIN_EMAIL match)
 *   APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID — push; see SECURITY_NOTES.md
 *   RATE_LIMITS           — 'off' disables the in-memory rate limiters
 *
 * Auth model and public routes: SECURITY_NOTES.md.
 */

const { WebSocketServer, WebSocket } = require('ws');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── APNs (push notifications) ────────────────────────────────────────────────
// Uses @parse/node-apn (the maintained fork of node-apn). Speaks HTTP/2 to
// Apple's APNs as required since the legacy binary protocol was retired.
// Provider is lazy-initialized on first push so server can boot without APNs.
let apn = null;
try { apn = require('@parse/node-apn'); }
catch(e) { /* package not installed — push will be a no-op until npm i @parse/node-apn */ }

// ── Stripe (token payments) — ARCHIVED ───────────────────────────────────────
// Billing (Stripe checkout, subscriptions, token purchases, plan tiers) is
// archived: the product is no longer subscription-gated. Every billing route
// is still registered and all the code below is intact, but while
// BILLING_ENABLED is not 'true' the routes answer 410 { error: 'Billing is archived' }
// (the Stripe webhook answers 200 and does nothing, so Stripe stops retrying).
//
// To re-enable billing:
//   1. Set BILLING_ENABLED=true plus STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and
//      STRIPE_PRICE_SOLO / _STUDIO / _AGENCY in Railway.
//   2. Re-enable the webhook endpoint in the Stripe dashboard.
//   3. Token/plan gating on /generate-image and /ai/claude was removed separately
//      (see git history for the commit that archived billing) and would need
//      restoring if tokens should be charged again.
const BILLING_ENABLED = process.env.BILLING_ENABLED === 'true';
const Stripe = require('stripe');

const stripe = BILLING_ENABLED && process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Gate for archived billing routes.
function billingGate(req, res, next) {
  if (BILLING_ENABLED) return next();
  return res.status(410).json({ error: 'Billing is archived' });
}
// Webhook variant: acknowledge with 200 so Stripe doesn't retry for days and
// then flag the endpoint as failing. Nothing is verified or processed.
function billingWebhookGate(req, res, next) {
  if (BILLING_ENABLED) return next();
  return res.status(200).json({ received: true, archived: true });
}

// ── Supabase REST helper (no SDK — works on any Node version) ─────────────────
const SUPA_URL = process.env.SUPABASE_URL || '';
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || '';

function supaRest(method, table, params, body, extraHeaders) {
  // params: query string e.g. 'agency_id=eq.123'
  // body: object for POST/PATCH, or null
  return new Promise((resolve, reject) => {
    const path = `/rest/v1/${table}${params ? '?' + params : ''}`;
    const url = new URL(SUPA_URL);
    const bodyStr = body ? JSON.stringify(body) : null;
    // Merge Prefer values instead of letting one overwrite the other: the
    // fluent .upsert() passes `resolution=merge-duplicates`, and every call
    // wants `return=representation`. Previously the generic value came last and
    // clobbered the upsert's, so upserts ran as plain INSERTs (409 on an
    // existing row). PostgREST accepts a comma-separated Prefer list.
    const extra = { ...(extraHeaders || {}) };
    let extraPrefer = '';
    for (const k of Object.keys(extra)) {
      if (k.toLowerCase() === 'prefer') { extraPrefer = String(extra[k] || ''); delete extra[k]; }
    }
    const preferParts = extraPrefer.split(',').map(x => x.trim()).filter(Boolean);
    if (!preferParts.some(x => /^return=/i.test(x))) preferParts.push('return=representation');
    const headers = {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      ...extra,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': preferParts.join(','),
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({
      hostname: url.hostname,
      path,
      method,
      headers,
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
        // Surface PostgREST/HTTP errors instead of resolving them as data.
        // Previously any non-2xx (RLS violation, missing on-conflict constraint,
        // unknown column) was resolved as the response body with error=null, so
        // callers like handleRegisterPushToken saw a silent success and wrote
        // nothing. Now a non-2xx rejects, so the fluent .then() reports a real error.
        if (res.statusCode && res.statusCode >= 300) {
          const msg = (parsed && (parsed.message || parsed.error || parsed.msg)) || ('HTTP ' + res.statusCode);
          const err = new Error(msg);
          err.status = res.statusCode;
          if (parsed && parsed.code) err.code = parsed.code;
          if (parsed && parsed.details) err.details = parsed.details;
          err.body = parsed;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Supabase Admin — fluent query builder ───────────────────────────────────
function _makeSupaQuery(table) {
  const s = { table, filters: [], cols: '*', limitN: null, orderBy: null, body: null, method: 'GET', upsertConflict: null };
  const q = {
    // After insert/update/upsert, .select() (supabase-js style) must keep the
    // write: rows come back via Prefer return=representation.
    select(cols) { s.cols = cols || '*'; if (s.body == null && s.method !== 'DELETE') s.method = 'GET'; return q; },
    eq(col, val) { s.filters.push(`${col}=eq.${encodeURIComponent(val)}`); return q; },
    in(col, vals) { s.filters.push(`${col}=in.(${vals.map(v => encodeURIComponent(v)).join(',')})`); return q; },
    order(col, opts) { s.orderBy = `${col}.${(opts && opts.ascending === false) ? 'desc' : 'asc'}`; return q; },
    limit(n) { s.limitN = n; return q; },
    range(from, to) { s.limitN = (to - from + 1); return q; },
    update(body) { s.method = 'PATCH'; s.body = body; return q; },
    insert(body) { s.method = 'POST'; s.body = body; return q; },
    upsert(body, opts) { s.method = 'POST'; s.body = body; s.upsertConflict = (opts && opts.onConflict) ? opts.onConflict : ''; s.ignoreDuplicates = !!(opts && opts.ignoreDuplicates); return q; },
    delete() { s.method = 'DELETE'; return q; },
    then(resolve, reject) {
      return q._exec()
        .then(r => resolve({ data: r, error: null }))
        .catch(e => resolve({ data: null, error: e }));
    },
    async maybeSingle() {
      try { s.limitN = 1; const r = await q._exec(); return { data: Array.isArray(r) ? (r[0] || null) : r, error: null }; }
      catch(e) { return { data: null, error: e }; }
    },
    async single() {
      try { s.limitN = 1; const r = await q._exec(); return { data: Array.isArray(r) ? (r[0] || null) : r, error: null }; }
      catch(e) { return { data: null, error: e }; }
    },
    _qs() {
      const parts = [...s.filters];
      if (s.cols && s.method === 'GET') parts.push(`select=${s.cols.replace(/\s/g, '')}`);
      if (s.orderBy) parts.push(`order=${s.orderBy}`);
      if (s.limitN != null) parts.push(`limit=${s.limitN}`);
      // Empty onConflict -> omit the param so PostgREST uses the primary key.
      if (s.upsertConflict) parts.push(`on_conflict=${encodeURIComponent(s.upsertConflict)}`);
      return parts.join('&') || null;
    },
    async _exec() {
      const extraH = {};
      if (s.upsertConflict != null) {
        extraH['Prefer'] = (s.ignoreDuplicates ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates') + ',return=representation';
      }
      try {
        return await supaRest(s.method, s.table, q._qs(), s.body, extraH);
      } catch (e) {
        // 42P10 = no unique constraint matches on_conflict. Before the Prefer fix
        // upserts silently ran as plain INSERTs, so a table missing the expected
        // constraint used to "work" for new rows. Keep that behaviour (and say so
        // in the log) rather than failing every write outright.
        if (s.upsertConflict && e && e.code === '42P10') {
          log('⚠', `upsert ${s.table}: no unique constraint on (${s.upsertConflict}); falling back to INSERT`);
          const qs = (q._qs() || '').split('&').filter(x => x && !x.startsWith('on_conflict=')).join('&') || null;
          return supaRest(s.method, s.table, qs, s.body, {});
        }
        throw e;
      }
    },
  };
  return q;
}
// Verify a user's access token (JWT) with Supabase Auth using the service key.
// Mirrors supabase-js `supabaseAdmin.auth.getUser(token)` -> { data: { user }, error }.
async function _supaGetUser(token) {
  try {
    const r = await fetch(SUPA_URL.replace(/\/$/, '') + '/auth/v1/user', {
      headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + token },
    });
    if (!r.ok) return { data: { user: null }, error: new Error('auth ' + r.status) };
    const user = await r.json();
    return { data: { user: (user && user.id) ? user : null }, error: null };
  } catch (e) {
    return { data: { user: null }, error: e };
  }
}
const supabaseAdmin = SUPA_URL && SUPA_KEY
  ? { from: (table) => _makeSupaQuery(table), auth: { getUser: _supaGetUser } }
  : null;

// ── Conditional (compare-and-swap) write to one app_state row ────────────────
// The web (supaSync) and native (flush) set local_version = Date.now() on every
// write. A server read-modify-write used to PATCH the whole column blind, so a
// client write landing between our read and our write was silently reverted.
// Now the PATCH only matches while local_version is still the value we read;
// on 0 rows we re-read and re-apply `mutate`. mutate(row) returns the columns
// to write, or null to write nothing (idempotent no-op / not found); it may
// throw to abort. updated_by/local_version are set like a client write.
const APP_STATE_CAS_TRIES = 6;
async function casUpdateAppState(agencyId, cols, mutate, updatedBy) {
  const aid = encodeURIComponent(String(agencyId));
  for (let attempt = 0; attempt < APP_STATE_CAS_TRIES; attempt++) {
    const rows = await supaRest('GET', 'app_state', `agency_id=eq.${aid}&select=${cols},local_version&limit=1`, null);
    const row = Array.isArray(rows) ? (rows[0] || null) : null;
    if (!row) return { row: null, written: false };
    const readVersion = row.local_version;
    const patch = await mutate(row);
    if (!patch) return { row, written: false };
    const body = Object.assign({}, patch, {
      updated_by: String(updatedBy || 'server'),
      local_version: Math.max(Date.now(), (Number(readVersion) || 0) + 1),
    });
    const guard = readVersion == null ? 'local_version=is.null' : `local_version=eq.${encodeURIComponent(readVersion)}`;
    const out = await supaRest('PATCH', 'app_state', `agency_id=eq.${aid}&${guard}&select=agency_id`, body);
    if (Array.isArray(out) && out.length) return { row, written: true, local_version: body.local_version };
    // Someone wrote in between: back off a little and redo from a fresh read.
    await new Promise(r => setTimeout(r, 40 * (attempt + 1) + Math.floor(Math.random() * 60)));
  }
  const e = new Error('Studio data is busy (concurrent edits). Please try again.');
  e.status = 409;
  throw e;
}

// Tell open apps (web + native) to refetch the row: the same event they send
// after their own writes, on the per-agency Supabase Realtime channel.
async function broadcastStateUpdate(agencyId, updatedBy, extra) {
  try {
    await fetch(SUPA_URL + '/realtime/v1/api/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPA_KEY, 'apikey': SUPA_KEY },
      body: JSON.stringify({ messages: [{
        topic: 'realtime:app-state-' + agencyId,
        event: 'state_update',
        payload: Object.assign({ updated_by: String(updatedBy), agency_id: agencyId, ts: Date.now() }, extra || {}),
      }] }),
    });
  } catch (e) {
    console.warn('[state_update] Realtime broadcast failed:', e.message);
  }
}

// ── Request auth (bearer Supabase access token) ──────────────────────────────
// Every studio route uses requireAuth (401 without a valid Supabase access
// token) plus a membership check against the agency named in the request.
// Public routes (share links, quote e-sign, client brief notify, health,
// webhooks) are listed and explained in SECURITY_NOTES.md.
const makeAuth = require('./auth');
const { requireAuth, requireUser, userFromToken, requireMember, memberships, forgetUser } = makeAuth(supabaseAdmin);
const { rateLimit, overLimit, clientIp, safeFetchText, escapeHtml, maskEmail } = require('./security');

// Platform owner (bulk email, cross-studio recap trigger). Matched on the
// verified token, never on a body field. PLATFORM_ADMIN_UID (Supabase auth id)
// is optional and takes precedence when set.
const PLATFORM_ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'taylor@below.co.nz').toLowerCase().trim();
const PLATFORM_ADMIN_UID = String(process.env.PLATFORM_ADMIN_UID || '').trim();
function isPlatformAdmin(user) {
  if (!user || !user.id) return false;
  if (PLATFORM_ADMIN_UID) return String(user.id) === PLATFORM_ADMIN_UID;
  const email = String(user.email || '').toLowerCase().trim();
  const confirmed = !!(user.email_confirmed_at || user.confirmed_at);
  return confirmed && !!email && email === PLATFORM_ADMIN_EMAIL;
}
function requirePlatformAdmin(req, res, next) {
  if (!isPlatformAdmin(req.authUser)) return res.status(403).json({ error: 'Unauthorized' });
  next();
}

// Agency id named by a request (body, route param or query), in that order.
function _agencyOf(req) {
  const b = req.body || {};
  return b.agencyId || b.agency_id || (req.params && req.params.agencyId) || (req.query && (req.query.agencyId || req.query.agency)) || null;
}

/**
 * needMember({ get, admin, optional, collaborator })
 *   get(req)      -> agency id (default _agencyOf)
 *   admin         -> caller's membership must have role 'admin'
 *   optional      -> no agency id given: caller must belong to at least one studio
 *   collaborator  -> also accept a caller whose studio collaborates on a project
 *                    owned by this agency (shared_projects), e.g. storyboard
 *                    generation inside a shared project
 * Sets req.member (the caller's agency_members row) when an agency id is given.
 */
function needMember(opts = {}) {
  return async function (req, res, next) {
    try {
      const uid = req.authUser && req.authUser.id;
      if (!uid) return res.status(401).json({ error: 'Unauthorized' });
      const agencyId = opts.get ? opts.get(req) : _agencyOf(req);
      if (!agencyId) {
        if (!opts.optional) return res.status(400).json({ error: 'agencyId required' });
        const mine = await memberships(uid);
        if (!mine.length) return res.status(403).json({ error: 'Not a member of any studio' });
        return next();
      }
      const m = await requireMember(uid, String(agencyId));
      if (!m) {
        if (opts.collaborator && await _collaboratesWith(uid, String(agencyId))) return next();
        return res.status(403).json({ error: 'Not a member of this agency' });
      }
      if (opts.admin && m.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
      req.member = m;
      next();
    } catch (e) {
      log('⚠', 'membership check failed: ' + e.message);
      res.status(500).json({ error: 'Membership check failed' });
    }
  };
}

// True when one of the caller's studios is a guest on a project owned by agencyId.
async function _collaboratesWith(userId, ownerAgencyId) {
  if (!supabaseAdmin) return false;
  const mine = (await memberships(userId)).map(m => String(m.agency_id));
  if (!mine.length) return false;
  const { data, error } = await supabaseAdmin.from('shared_projects')
    .select('guest_agency_id').eq('owner_agency_id', ownerAgencyId).in('guest_agency_id', mine).limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

// Rate limits (in-memory, per process). RATE_LIMITS=off disables them.
const MIN = 60 * 1000, HOUR = 60 * MIN;
const limitGlobalIp   = rateLimit({ name: 'global', windowMs: MIN, max: 600, by: 'ip' });
const limitAI         = [rateLimit({ name: 'ai-m', windowMs: MIN, max: 20, by: 'user' }),
                         rateLimit({ name: 'ai-h', windowMs: HOUR, max: 300, by: 'user' })];
const limitEmail      = [rateLimit({ name: 'mail-m', windowMs: MIN, max: 10, by: 'user' }),
                         rateLimit({ name: 'mail-h', windowMs: HOUR, max: 100, by: 'user' })];
const limitBulkEmail  = rateLimit({ name: 'bulk', windowMs: HOUR, max: 5, by: 'user' });
const limitUserWrites = rateLimit({ name: 'writes', windowMs: MIN, max: 240, by: 'user' });
const limitLinks      = rateLimit({ name: 'links', windowMs: MIN, max: 30, by: 'user' });
const limitPush       = rateLimit({ name: 'push', windowMs: MIN, max: 30, by: 'user' });
const limitPublicRead = rateLimit({ name: 'pub-r', windowMs: MIN, max: 120, by: 'ip' });
const limitPublicWrite= rateLimit({ name: 'pub-w', windowMs: MIN, max: 20, by: 'ip' });
const limitBriefNotify= rateLimit({ name: 'brief', windowMs: 10 * MIN, max: 20, by: 'ip' });
const limitAuthFail   = rateLimit({ name: 'lookup', windowMs: MIN, max: 60, by: 'ip' });

const TOKEN_PACKAGES = {
  tokens_5:   { tokens: 20,  priceUsd: 5,  name: '20 Tokens — $5 USD'  },
  tokens_10:  { tokens: 60,  priceUsd: 10, name: '60 Tokens — $10 USD' },
  tokens_18:  { tokens: 150, priceUsd: 18, name: '150 Tokens — $18 USD' },
  tokens_40:  { tokens: 400, priceUsd: 40, name: '400 Tokens — $40 USD' },
};

// ── Core config ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || process.env.WB_PORT || '8080', 10);
const DATA_DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname);
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = 'BSMNT <noreply@bsmnt.co.nz>';

// ── Persistence ───────────────────────────────────────────────────────────────
let saveTimer = null;

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      log('💾', `Loaded state from ${DATA_FILE}`);
      return { ...defaultAppState(), ...parsed, seeded: true };
    }
  } catch (e) { console.error('Failed to load state:', e.message); }
  return defaultAppState();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(appState, null, 2));
    } catch (e) { console.error('Failed to save state:', e.message); }
  }, 2000);
}

function defaultAppState() {
  return { projects:[], clients:[], users:[], archived:[], tasks:[],
    wbState:{}, templates:[], taskTemplates:{'Pre-Production':[],'Production':[],'Post Production':[]},
    brand:{}, retainers:[], seeded:false };
}

const activeTimers = {};
const _runningTimers = {}; // memberId -> {agencyId, projectName, startedAt(ms)} - fed by /notify/timer-event (client routes timers over Supabase Realtime, not this ws, so activeTimers stays empty); used by the 2h idle check
let appState = loadState();
const clients = new Set();

function log(icon, msg) {
  console.log(`[${new Date().toTimeString().slice(0,8)}] ${icon}  ${msg}`);
}

// ── Express + HTTP server ─────────────────────────────────────────────────────
const express = require('express');
const app = express();

// Stripe webhook MUST use raw body — register BEFORE express.json()
app.post('/stripe-webhook', billingWebhookGate, express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '20mb' }));

// CORS — must be first middleware so preflight OPTIONS always gets headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Max-Age', '86400'); // cache preflight 24h
  res.header('Access-Control-Expose-Headers', 'X-Studio-Tokens-Charged, X-Studio-Token-Balance, X-AI-Key-Source');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(limitGlobalIp);

// ── Route table ──────────────────────────────────────────────────────────────
// auth   = requireAuth (valid Supabase access token)
// member = caller is an active member of the agency in the request
// admin  = caller is an admin of that agency
// PUBLIC = no login by design; each one is noted with what protects it.
app.get('/', (req, res) => res.send('BSMNT OK'));                                     // PUBLIC health check
// Billing routes are archived (410 unless BILLING_ENABLED=true) — see top of file.
app.post('/create-checkout',      billingGate, requireAuth, needMember({ admin: true }), handleCreateCheckout);
app.post('/create-subscription',  billingGate, requireAuth, needMember({ admin: true }), handleCreateSubscription);
app.get('/customer-portal',       billingGate, requireAuth, needMember({ admin: true }), handleCustomerPortal);
app.post('/cancel-subscription',  billingGate, requireAuth, needMember({ admin: true }), handleCancelSubscription);
app.post('/generate-image',       requireAuth, ...limitAI, needMember({ collaborator: true }), handleGenerateImage);
app.post('/briefing',             requireAuth, ...limitAI, needMember({ optional: true }), handleBriefing);
app.get('/agency-brand/:agencyId', limitPublicRead, handleAgencyBrand);                // PUBLIC: studio name + accent only
app.post('/submit-brief',          handleSubmitBrief);                                   // retired (410): brief.html uses /notify/new-brief
app.post('/ai-brainstorm',        requireAuth, ...limitAI, needMember({ optional: true }), handleAIBrainstorm);
app.post('/send-project-invite',  requireAuth, ...limitEmail, needMember({ get: r => (r.body || {}).inviterAgencyId }), handleSendProjectInvite);
app.post('/invite-member',        requireAuth, ...limitEmail, needMember({ admin: true }), handleInviteMember);
app.post('/accept-project-invite',requireAuth, limitUserWrites, needMember({ get: r => (r.body || {}).guestAgencyId }), handleAcceptProjectInvite);
app.get('/project-invites/:email', requireAuth, handleGetProjectInvites);              // own email only
app.get('/project-invites/id/:inviteId', requireAuth, handleGetInviteById);            // invitee or owner-studio member
app.get('/check-member-invite/:email', limitAuthFail, requireAuth, handleCheckMemberInvite); // own email only
app.post('/gift-tokens-email',    billingGate, requireAuth, requirePlatformAdmin, handleGiftTokensEmail); // archived with billing (token economy)
app.post('/bulk-email',           requireAuth, requirePlatformAdmin, limitBulkEmail, handleBulkEmail);
app.post('/save-user-pref',       requireAuth, limitUserWrites, needMember(), handleSaveUserPref);
app.post('/link-preview',         requireAuth, limitLinks, handleLinkPreview);
app.post('/set-member-active',    requireAuth, limitUserWrites, handleSetMemberActive); // admin, or invitee re-activating their own row
app.post('/append-time-log',      requireAuth, limitUserWrites, needMember(), handleAppendTimeLog);
app.post('/notify-deliverable-comment', requireAuth, limitPush, needMember(), handleNotifyDeliverableComment);
app.post('/notify/project-created',  requireAuth, limitPush, needMember(), handleNotifyProjectCreated);
app.post('/notify/new-brief',        limitBriefNotify, handleNotifyNewBrief);           // PUBLIC: only fires for a brief saved in client_briefs
app.post('/notify/project-assigned', requireAuth, limitPush, needMember(), handleNotifyProjectAssigned);
app.post('/notify/timer-event',     requireAuth, limitUserWrites, needMember(), handleNotifyTimerEvent);
app.post('/push/register-token',  requireAuth, limitUserWrites, handleRegisterPushToken);
app.post('/push/send',            requireAuth, limitPush, handlePushSend);
app.post('/push/prefs',           handlePushPrefs);                                     // PUBLIC no-op stub (stores nothing)
app.get('/push/prefs',            handlePushPrefs);                                     // PUBLIC no-op stub
app.get('/push/status',           requireAuth, handlePushStatus);
app.post('/send-recap',           requireAuth, ...limitEmail, handleSendRecapNow);     // agency admin or platform admin
app.post('/send-runsheet',        requireAuth, ...limitEmail, needMember(), handleSendRunsheet);
app.get('/project-report/:agencyId/:projectId', limitPublicRead, handleProjectReport); // share token (?token=) or bearer + member
app.get('/project-share/:token',        limitPublicRead, handleGetProjectShare);        // PUBLIC: 144-bit share token
app.post('/project-share/:token/edit',  limitPublicWrite, handleEditProjectShare);      // PUBLIC: edit-link token only
app.get('/quote/:token',          limitPublicRead, handleGetQuote);                      // PUBLIC: quote accept token
app.post('/quote/:token/accept',  limitPublicWrite, handleAcceptQuote);                  // PUBLIC: quote accept token
app.post('/send-quote',           requireAuth, ...limitEmail, handleSendQuote);          // member of the quote's studio
app.post('/account/delete',       _bodyTokenToBearer, requireAuth, handleAccountDelete);
app.post('/studio/leave',         requireAuth, limitUserWrites, needMember(), handleLeaveStudio); // the caller's own membership only

// ── Native/web AI proxy (strict auth) ────────────────────────────────────────
// See NATIVE_AI_PROXY.md. Keys never leave the server.
const makeAiProxy = require('./ai-proxy');
const { handleClaude } = makeAiProxy({ supabaseAdmin, requireMember, log });
app.post('/ai/claude', requireAuth, ...limitAI, handleClaude);

// ── POST /account/delete (App Store 5.1.1(v)) ────────────────────────────────
// Deletes the *authenticated* user's account. Identity comes only from a
// verified Supabase access token (requireAuth); nothing in the body names the
// user. The web app currently sends the token in the JSON body ({ token })
// instead of the Authorization header; _bodyTokenToBearer promotes it to the
// header when no header is present. It is still verified with Supabase Auth,
// so this is as strong as the header. The web should move to the header.
function _bodyTokenToBearer(req, res, next) {
  const h = req.headers && req.headers.authorization;
  const t = req.body && typeof req.body.token === 'string' ? req.body.token.trim() : '';
  if (!h && t && t.split('.').length === 3) req.headers.authorization = 'Bearer ' + t;
  next();
}

async function _supaAdminDeleteUser(userId) {
  const r = await fetch(SUPA_URL.replace(/\/$/, '') + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
    method: 'DELETE',
    headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY },
  });
  if (!r.ok && r.status !== 404) {
    const t = await r.text().catch(() => '');
    const err = new Error('auth admin delete ' + r.status + (t ? ': ' + t.slice(0, 160) : ''));
    err.status = r.status;
    throw err;
  }
}

async function handleAccountDelete(req, res) {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  const userId = String(req.authUser.id);
  const uidLog = userId.slice(0, 8) + '…';
  try {
    // 1. The user's memberships (all studios).
    const { data: mine, error: mErr } = await supabaseAdmin.from('agency_members')
      .select('id,agency_id,role,active').eq('user_id', userId);
    if (mErr) throw mErr;
    const memberships = (mine || []).filter(m => m && m.active !== false);

    // 2. Refuse if they're the only active admin of a studio that still has
    //    other active members. Checked for every studio before changing anything.
    for (const m of memberships) {
      if (m.role !== 'admin') continue;
      const { data: rows, error } = await supabaseAdmin.from('agency_members')
        .select('id,user_id,role,active').eq('agency_id', String(m.agency_id));
      if (error) throw error;
      const others = (rows || []).filter(r => r && r.active !== false && String(r.user_id || '') !== userId);
      if (others.length && !others.some(r => r.role === 'admin')) {
        log('🗑', `account/delete refused for ${uidLog}: sole admin of a studio with other members`);
        return res.status(409).json({
          error: 'You are the only admin of a studio that has other members. Transfer admin to another member first, then delete your account.',
          code: 'transfer_admin_first',
          agencyId: m.agency_id,
        });
      }
    }

    // 3. Deactivate every membership row. Studio data (app_state, projects,
    //    agency_settings) is left intact, even if they were the sole member.
    const { error: uErr } = await supabaseAdmin.from('agency_members')
      .update({ active: false }).eq('user_id', userId);
    if (uErr) throw uErr;
    // Detach the rows from the auth user so the auth delete can't be blocked by
    // (or cascade through) a foreign key. Best effort: user_id may be NOT NULL.
    const { error: dErr } = await supabaseAdmin.from('agency_members')
      .update({ user_id: null }).eq('user_id', userId);
    if (dErr) log('⚠', `account/delete: could not detach member rows (${dErr.code || dErr.status || 'err'})`);

    // 4. Personal push data.
    const { error: tErr } = await supabaseAdmin.from('device_tokens').delete().eq('user_id', userId);
    if (tErr) throw tErr;
    const { error: pErr } = await supabaseAdmin.from('notification_prefs').delete().eq('user_id', userId);
    if (pErr && pErr.status !== 404) log('⚠', `account/delete: notification_prefs (${pErr.code || pErr.status || 'err'})`);
    const { error: sErr } = await supabaseAdmin.from('notifications_sent').delete().eq('user_id', userId);
    if (sErr && sErr.status !== 404) log('⚠', `account/delete: notifications_sent (${sErr.code || sErr.status || 'err'})`);

    // 5. The auth user itself.
    await _supaAdminDeleteUser(userId);
    forgetUser(userId);
    log('🗑', `Account deleted: ${uidLog} (${memberships.length} membership(s) deactivated)`);
    res.json({ ok: true });
  } catch (e) {
    log('❌', `account/delete failed for ${uidLog}: ${e && (e.code || e.status || '')} ${e && e.message ? e.message.slice(0, 120) : ''}`);
    res.status(500).json({ error: 'Account deletion failed. Please try again or email support@below.co.nz.' });
  }
}

// ── POST /studio/leave { agencyId } ─────────────────────────────────────────
// The caller leaves one studio. Identity comes from the verified token and the
// row is the caller's own active membership (needMember), so nobody can remove
// someone else. Same rule as account deletion: the only admin of a studio that
// still has other active members must hand admin over first. The row is
// deactivated, not deleted, so an admin can re-enable it from Team; studio data
// is untouched.
async function handleLeaveStudio(req, res) {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  const userId = String(req.authUser.id);
  const me = req.member;
  const agencyId = String(me.agency_id);
  try {
    const { data: rows, error } = await supabaseAdmin.from('agency_members')
      .select('id,user_id,role,active').eq('agency_id', agencyId);
    if (error) throw error;
    const others = (rows || []).filter(r => r && r.active !== false && String(r.id) !== String(me.id));
    if (me.role === 'admin' && others.length && !others.some(r => r.role === 'admin')) {
      return res.status(409).json({
        error: 'You are the only admin of this studio. Make another member an admin first, then leave.',
        code: 'transfer_admin_first',
      });
    }
    const { error: uErr } = await supabaseAdmin.from('agency_members')
      .update({ active: false }).eq('id', me.id).eq('user_id', userId);
    if (uErr) throw uErr;
    forgetUser(userId);
    log('👋', `Left studio ${agencyId.slice(0, 8)}… (${userId.slice(0, 8)}…)${others.length ? '' : ', was its last member'}`);
    res.json({ ok: true, lastMember: others.length === 0 });
  } catch (e) {
    log('⚠', 'studio/leave failed: ' + e.message);
    res.status(500).json({ error: 'Could not leave the studio' });
  }
}

// ── Overnight prospect hunter (opt-in) ───────────────────────────────────────
// Off unless PROSPECT_HUNTER=on, so a deploy never starts paid Claude calls by
// surprise. Uses this server's service-key REST client (no supabase-js dep).
if (String(process.env.PROSPECT_HUNTER || '').toLowerCase() === 'on') {
  if (!supabaseAdmin) log('⚠', 'PROSPECT_HUNTER=on but Supabase is not configured; hunter not started');
  else {
    try { require('./prospect-hunter').start({ db: supabaseAdmin }); }
    catch (e) { log('⚠', 'prospect hunter failed to start: ' + e.message); }
  }
} else {
  log('🔎', 'Prospect hunter off (set PROSPECT_HUNTER=on to enable)');
}

// ── BSMNT public quote / e-sign page ──────────────────────────────────────────
// The client opens a share link (?quote=<token>) with no auth and no agency id,
// so we locate the quote by token across every agency's app_state.brand._quotes
// (quotes live in brand._quotes, like the equipment library). Mirrors the
// findProjectByToken / project-share pattern.
function _quoteEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function findQuoteByToken(token) {
  if (!token || String(token).length < 6) return null;
  try {
    const { data: rows, error } = await supabaseAdmin.from('app_state').select('agency_id,brand');
    if (error || !rows || !rows.length) return null;
    for (const row of rows) {
      let brand = row.brand;
      if (typeof brand === 'string') { try { brand = JSON.parse(brand); } catch(e) { continue; } }
      if (!brand || !Array.isArray(brand._quotes)) continue;
      const quote = brand._quotes.find(q => q && q.acceptToken === token);
      if (quote) return { quote, agencyId: row.agency_id, brand };
    }
  } catch(e) { console.error('[quote] findQuoteByToken error:', e.message); }
  return null;
}

// Build the exact client-view shape _renderQuotePage expects. Studio branding
// mirrors the in-app _quoteStudio() (quoteDetails.fromName, brand.logo, accent).
function buildQuoteClientView(q, brand) {
  brand = brand || {};
  const qd = brand.quoteDetails || {};
  const gstRate = (typeof q.gstRate === 'number') ? q.gstRate : (parseFloat(q.gstRate) || 0);
  let subtotal = 0;
  const stages = (q.stages || []).map(st => ({
    name: st.name || '',
    lines: (st.lines || []).map(l => {
      const qty = parseFloat(l.qty) || 0;
      const unitPrice = parseFloat(l.unitPrice) || 0;
      const lineTotal = qty * unitPrice;
      subtotal += lineTotal;
      return { desc: l.desc || '', qty: qty, unitPrice: unitPrice, lineTotal: lineTotal };
    })
  }));
  const gst = subtotal * gstRate;
  return {
    number: q.number || '', title: q.title || '', date: q.date || '', validUntil: q.validUntil || '',
    status: q.status || 'sent',
    client: q.client ? { name: q.client.name || '', company: q.client.company || '' } : {},
    brand: {
      name: qd.fromName || brand.appName || 'Studio',
      logo: brand.logo || '',
      accent: brand.accentColor || '#7c6fff'
    },
    stages: stages,
    subtotal: subtotal, gst: gst, gstRate: gstRate, total: subtotal + gst,
    deliverables: Array.isArray(q.deliverables) ? q.deliverables.map(d => ({ name: (d && d.name) || String(d || '') })) : [],
    deposit: q.deposit || '', paymentTerms: q.paymentTerms || '', terms: q.terms || '', notes: q.notes || '',
    acceptance: q.acceptance || null
  };
}

// GET /quote/:token — public quote view payload.
async function handleGetQuote(req, res) {
  try {
    const found = await findQuoteByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Quote not found' });
    res.json(buildQuoteClientView(found.quote, found.brand));
  } catch(e) {
    console.error('[quote] GET error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
}

// POST /quote/:token/accept — record the client's signature on the quote.
async function handleAcceptQuote(req, res) {
  const { name, agree } = req.body || {};
  try {
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Please type your full name.' });
    if (!agree) return res.status(400).json({ error: 'Please tick the box to accept.' });
    const found = await findQuoteByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Quote not found' });
    // Re-read the current brand fresh, modify only the matching quote, write back
    // conditionally on local_version (casUpdateAppState), so a studio save that
    // lands in between is re-read and kept instead of being reverted.
    const acceptance = {
      name: String(name).trim(),
      acceptedAt: new Date().toISOString(),
      ip: ((req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() || null
    };
    let q = null, already = null;
    const result = await casUpdateAppState(found.agencyId, 'brand', function(row) {
      q = null; already = null;
      let brand = row.brand;
      if (typeof brand === 'string') { try { brand = JSON.parse(brand); } catch(e) { brand = null; } }
      if (!brand || !Array.isArray(brand._quotes)) return null;
      const idx = brand._quotes.findIndex(x => x && x.acceptToken === req.params.token);
      if (idx === -1) return null;
      if (brand._quotes[idx].status === 'accepted' && brand._quotes[idx].acceptance) {
        already = brand._quotes[idx].acceptance;
        return null;
      }
      const quotes = brand._quotes.slice();
      quotes[idx] = Object.assign({}, quotes[idx], { status: 'accepted', acceptance });
      q = quotes[idx];
      return { brand: Object.assign({}, brand, { _quotes: quotes }) };
    }, 'share:quote');
    if (already) return res.json({ ok: true, status: 'accepted', acceptance: already });
    if (!result.written || !q) return res.status(404).json({ error: 'Quote not found' });
    const brand = found.brand || {};
    // Supabase Realtime signal too: native apps (and web tabs without the Railway
    // socket) refetch brand, so their next save doesn't write the old quote back.
    broadcastStateUpdate(found.agencyId, 'share:quote', { op: 'quote_accept' }).catch(function(){});
    // 1) Live-update any open studio app (broadcast is global, so tag the agency
    //    and let each client filter on agencyId).
    try {
      broadcast({ type: 'quote_accepted', agencyId: found.agencyId, quoteId: q.id,
        acceptToken: req.params.token, number: q.number || '', title: q.title || '',
        clientName: acceptance.name, acceptedAt: acceptance.acceptedAt });
    } catch(e) {}
    // 2) Push the studio's admins (app notification).
    try {
      pushToAdmins(found.agencyId, 'pushQuoteAccepted', 'Quote accepted \u2713',
        acceptance.name + ' approved quote ' + (q.number || ''),
        { kind: 'quote_accepted', quoteId: q.id }).catch(function(){});
    } catch(e) {}
    // 3) Email the studio (best-effort).
    try {
      const studioEmail = (brand.quoteDetails && brand.quoteDetails.email) || '';
      if (studioEmail && RESEND_KEY) {
        sendEmail({ to: studioEmail,
          subject: 'Quote ' + (q.number || '') + ' accepted by ' + acceptance.name,
          html: '<p><strong>' + _quoteEsc(acceptance.name) + '</strong> has approved and signed quote <strong>' + _quoteEsc(q.number || '') + '</strong>' + (q.title ? (' (' + _quoteEsc(q.title) + ')') : '') + '.</p><p style="color:#666;font-size:13px;">Signed ' + new Date(acceptance.acceptedAt).toLocaleString() + '.</p>' });
      }
    } catch(e) {}
    res.json({ ok: true, status: 'accepted', acceptance });
  } catch(e) {
    console.error('[quote] accept error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
}

// POST /send-quote — email the share link to the client on the quote.
async function handleSendQuote(req, res) {
  const { token, link } = req.body || {};
  try {
    if (!token || !link) return res.status(400).json({ error: 'token and link required' });
    const found = await findQuoteByToken(token);
    if (!found) return res.status(404).json({ error: 'Quote not found' });
    // Only the studio that owns the quote may email it (requireAuth ran).
    if (!(await requireMember(req.authUser.id, String(found.agencyId)))) return res.status(404).json({ error: 'Quote not found' });
    if (typeof link !== 'string' || !/^https?:\/\//i.test(link) || link.length > 2048) return res.status(400).json({ error: 'Invalid link' });
    const q = found.quote;
    const email = ((q.client && q.client.email) || '').trim();
    if (!email || email.indexOf('@') < 0) return res.status(400).json({ error: 'No client email on this quote.' });
    if (!RESEND_KEY) return res.status(200).json({ ok: false, error: 'Email not configured on the server.' });
    const qd = found.brand.quoteDetails || {};
    const studio = qd.fromName || found.brand.appName || 'Your studio';
    const accent = found.brand.accentColor || '#7c6fff';
    const clientName = (q.client && (q.client.name || q.client.company)) || 'there';
    const safeLink = _quoteEsc(link);
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>'
      + '<body style="margin:0;padding:0;background:#f4f4f6;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;">'
      + '<div style="max-width:540px;margin:32px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 14px rgba(0,0,0,0.08);">'
      + '<div style="background:' + accent + ';padding:22px 28px;color:#fff;font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">' + _quoteEsc(studio) + '</div>'
      + '<div style="padding:28px;">'
      + '<p style="font-size:15px;color:#222;margin:0 0 14px;">Hi ' + _quoteEsc(clientName) + ',</p>'
      + '<p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 22px;">' + _quoteEsc(studio) + ' has sent you a quote' + (q.number ? (' (<strong>' + _quoteEsc(q.number) + '</strong>)') : '') + ' to review and approve.</p>'
      + '<a href="' + safeLink + '" style="display:inline-block;background:' + accent + ';color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:13px 26px;border-radius:9px;">View &amp; approve quote</a>'
      + '<p style="font-size:12px;color:#999;line-height:1.6;margin:22px 0 0;">Or paste this link into your browser:<br/>' + safeLink + '</p>'
      + '</div></div></body></html>';
    const sent = await sendEmail({ to: email, subject: studio + ' sent you a quote' + (q.number ? (' (' + q.number + ')') : ''), html });
    if (sent && sent.ok === false) {
      const detail = sent.detail ? (' · ' + String(sent.detail).replace(/\s+/g, ' ').slice(0, 200)) : '';
      return res.status(200).json({ ok: false, error: 'Resend rejected the email (' + (sent.error || 'unknown') + ')' + detail });
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('[quote] send error:', e.message);
    res.status(500).json({ error: 'Could not send the email.' });
  }
}

// ── BSMNT Xero integration (one-click "Send to Xero") ──
// Adds /xero/connect, /xero/callback, /xero/status, /xero/invoice.
// Relies on the global express.json() + CORS registered above.
const xeroRoutes = require('./xero-routes');
// Guards run first and fall through (next()) to the router's handlers.
// /xero/connect (browser redirect) and /xero/callback (Xero redirect) stay
// public but only accept a signed state ticket issued by /xero/connect-url.
const _xeroAgency = r => (r.body && r.body.agency) || (r.query && r.query.agency) || null;
app.post('/xero/connect-url', requireAuth, limitUserWrites, needMember({ get: _xeroAgency }));
app.get('/xero/status',       requireAuth, needMember({ get: _xeroAgency }));
app.post('/xero/invoice',     requireAuth, limitUserWrites, needMember({ get: _xeroAgency }));
app.use(xeroRoutes);

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, maxPayload: 5 * 1024 * 1024 });

// Deliver only to authenticated sockets whose user belongs to payload.agencyId.
// Payloads without an agencyId go nowhere (the old global fan-out leaked one
// studio's data to every connected client).
function broadcast(payload, excludeSocket = null) {
  const agencyId = payload && payload.agencyId != null ? String(payload.agencyId) : null;
  if (!agencyId) return;
  const msg = JSON.stringify(payload);
  for (const c of clients) {
    if (c === excludeSocket || c.readyState !== WebSocket.OPEN) continue;
    if (!c.user || !c.agencies || !c.agencies.has(agencyId)) continue;
    c.send(msg);
  }
}

// Sent after a socket authenticates: running timers for the caller's studios
// only. No app state (the web and native apps read data from Supabase).
function sendSnapshot(socket) {
  if (!socket.user) return;
  const timers = Object.values(activeTimers).filter(t => t && t.agencyId && socket.agencies.has(String(t.agencyId)));
  try { socket.send(JSON.stringify({ type:'snapshot', timers, appState: {} })); } catch (e) {}
}

// ── Token / Payment handlers ──────────────────────────────────────────────────



// ── Send Runsheet to Crew ──────────────────────────────────────────────────────
async function handleSendRunsheet(req, res) {
  try {
    const { agencyId, projectId, recipients, message, runsheetUrl } = req.body || {};
    if (!agencyId || !Array.isArray(recipients) || !recipients.length) {
      return res.status(400).json({ error: 'agencyId and recipients required' });
    }
    if (recipients.length > 50) return res.status(400).json({ error: 'Too many recipients (max 50)' });

    const { data: stateRow } = await supabaseAdmin
      .from('app_state').select('projects,brand').eq('agency_id', agencyId).maybeSingle();
    if (!stateRow) return res.status(404).json({ error: 'Agency not found' });

    const projects = Array.isArray(stateRow.projects) ? stateRow.projects : [];
    const proj = projects.find(p => String(p.id) === String(projectId));
    const brand = stateRow.brand || {};
    // Everything below lands in an email: escape it (message/url come from the
    // request body, names from studio data).
    const studioName = escapeHtml(brand.appName || brand.name || 'BSMNT');
    const projectNameRaw = proj ? String(proj.name || 'Project') : 'Project';
    const projectName = escapeHtml(projectNameRaw);
    const accent = /^#[0-9a-f]{3,8}$/i.test(String(brand.accentColor || '')) ? brand.accentColor : '#7c6fff';
    const safeMessage = message ? escapeHtml(String(message).slice(0, 4000)).replace(/\n/g, '<br/>') : '';
    const safeUrl = (typeof runsheetUrl === 'string' && /^https:\/\//i.test(runsheetUrl)) ? escapeHtml(runsheetUrl) : '';

    const emailBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;">
<div style="max-width:540px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <div style="background:${accent};padding:24px 28px;">
    <div style="color:#fff;font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;opacity:0.8;">${studioName}</div>
    <div style="color:#fff;font-size:22px;font-weight:700;margin-top:6px;">Run Sheet: ${projectName}</div>
  </div>
  <div style="padding:24px 28px;">
    ${safeMessage ? `<p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 20px;">${safeMessage}</p>` : ''}
    <p style="color:#666;font-size:14px;line-height:1.6;margin:0 0 20px;">
      You've been sent the run sheet for <strong>${projectName}</strong>. Click below to view the full schedule.
    </p>
    ${safeUrl ? `
    <a href="${safeUrl}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;">
      View Run Sheet →
    </a>` : ''}
  </div>
  <div style="padding:16px 28px;border-top:1px solid #f0f0f0;color:#aaa;font-size:11px;">
    Sent via ${studioName}
  </div>
</div>
</body>
</html>`;

    const results = await Promise.allSettled(recipients.map(async (r) => {
      const email = typeof r === 'string' ? r : r.email;
      const name  = typeof r === 'string' ? '' : (r.name || '');
      if (!email || !email.includes('@')) return;
      await sendEmail({
        to: email,
        subject: `Run Sheet: ${projectNameRaw}`,
        html: emailBody,
      });
      log('📋', `Runsheet sent to ${maskEmail(email)}`);
    }));

    const sent = results.filter(r => r.status === 'fulfilled').length;
    res.json({ ok: true, sent });
  } catch(e) {
    console.error('handleSendRunsheet error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Friday 3PM recap scheduler ────────────────────────────────────────
const _sentThisWeek = new Set();
// Persist recap-sent markers so a restart/redeploy doesn't re-send or skip a week.
// (Survives restarts when a Railway volume is mounted at RAILWAY_VOLUME_MOUNT_PATH.)
const RECAP_LOG_FILE = path.join(DATA_DIR, 'recap-sent.json');
try {
  if (fs.existsSync(RECAP_LOG_FILE)) {
    const arr = JSON.parse(fs.readFileSync(RECAP_LOG_FILE, 'utf8'));
    if (Array.isArray(arr)) arr.forEach(k => _sentThisWeek.add(k));
    log('💾', `Loaded ${_sentThisWeek.size} recap marker(s)`);
  }
} catch (e) { console.error('recap log load failed:', e.message); }
function _markRecapSent(key) {
  _sentThisWeek.add(key);
  try {
    let keys = Array.from(_sentThisWeek);
    if (keys.length > 200) { keys = keys.slice(-200); _sentThisWeek.clear(); keys.forEach(k => _sentThisWeek.add(k)); }
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RECAP_LOG_FILE, JSON.stringify(keys));
  } catch (e) { console.error('recap log save failed:', e.message); }
}

function _getWeekKey() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  return now.getFullYear() + '_w' + Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
}

// Weekly-recap recipients for an agency, read from agency_members (app_state has
// no `users` column; the old code read app_state.users and sent nothing).
// Active members with an email whose weekly-email preference is on. Preference
// precedence matches the web: preferences.emailWeekly, then the legacy
// email_weekly column, default on.
async function _recapRecipients(agencyId) {
  if (!supabaseAdmin || !agencyId) return [];
  const { data, error } = await supabaseAdmin.from('agency_members')
    .select('*').eq('agency_id', String(agencyId));
  if (error) { log('⚠', 'recap recipients: ' + error.message); return []; }
  return (data || []).filter(m => {
    if (!m || m.active === false) return false;
    if (!m.email || !String(m.email).includes('@')) return false;
    const p = m.preferences || {};
    const weekly = (p.emailWeekly !== undefined && p.emailWeekly !== null) ? p.emailWeekly
                 : (m.email_weekly !== undefined && m.email_weekly !== null) ? m.email_weekly : true;
    return weekly !== false;
  });
}

function _buildUserRecap(user, state, members) {
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const clients = Array.isArray(state.clients) ? state.clients : [];
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const now = new Date();
  const weekAgo = new Date(now - 7 * 86400000);
  const nextWeek = new Date(now.getTime() + 7 * 86400000);
  const uid = String(user.id);
  const rateOf = (id) => {
    const m = (members || []).find(x => String(x.id) === String(id));
    return m ? (Number(m.charge_rate != null ? m.charge_rate : m.chargeRate) || 0) : 0;
  };
  const budgetPct = (p) => {
    const entries = (p.budgetEntries || []).reduce((s, e) => s + (e.amount || 0), 0);
    const billed = (p.timeLog || []).reduce((s, l) => s + (l.hours || 0) * rateOf(l.user), 0);
    const total = billed + (p.hardCosts || 0) + entries;
    return p.budget > 0 ? Math.round(total / p.budget * 100) : 0;
  };
  const mine = projects.filter(p => {
    if (p.status === 'done') return false;
    if ((p.assigned || []).map(String).includes(uid)) return true;
    const ws = (state.wbState || {})[p.id] || {};
    return String(ws.userId) === uid || (ws.split || []).map(String).includes(uid);
  });
  const myProjects = mine.map(p => {
    const cl = clients.find(c => String(c.id) === String(p.clientId));
    return { name: p.name, client: cl ? cl.name : (p.client || ''), endDate: p.endDate, budgetPct: budgetPct(p) };
  });
  const completedThisWeek = tasks.filter(t => t.done && t.completedAt && new Date(t.completedAt) >= weekAgo).length;
  const hoursLastWeek = projects.flatMap(p => p.timeLog || [])
    .filter(l => String(l.user) === uid && new Date(l.date) >= weekAgo)
    .reduce((s, l) => s + (l.hours || 0), 0);
  const dueItems = [], overdueItems = [];
  mine.forEach(p => {
    if (!p.endDate) return;
    const d = new Date(p.endDate + 'T23:59:59');
    if (d < now) overdueItems.push({ name: p.name, type: 'project', overdue: true, dueLabel: p.endDate });
    else if (d <= nextWeek) {
      const diff = Math.ceil((d - now) / 86400000);
      dueItems.push({ name: p.name, type: 'project', overdue: false, dueLabel: diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : `in ${diff} days` });
    }
  });
  return { myProjects, completedThisWeek, hoursLastWeek, dueItems, overdueItems };
}

// Build + send one member's recap. weeklyEmail() returns { subject, html } only,
// so the recipient must be added here (it was missing, so nothing was sent).
async function _sendMemberRecap(user, agData, members, agencyId) {
  const recap = _buildUserRecap(user, agData, members);
  const mail = await weeklyEmail(user, { ...recap, agencyId });
  return sendEmail({ ...mail, to: user.email });
}

function scheduleFridayRecaps() {
  setInterval(async function() {
    try {
      const { data: states } = await supabaseAdmin.from('app_state').select('agency_id,brand');
      if (!states || !Array.isArray(states)) return;
      for (const state of states) {
        const users = await _recapRecipients(state.agency_id);
        for (const user of users) {
          const tz = state.brand?.timezone || 'Pacific/Auckland';
          const userNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
          const dayOfWeek = userNow.getDay();
          const hour = userNow.getHours();
          // Fire any time from 3PM Friday onward, so a restart/redeploy near 3PM
          // still catches the week. The persisted marker prevents a re-send.
          if (dayOfWeek === 5 && hour >= 15) {
            const weekKey = 'recap_' + state.agency_id + '_' + user.id + '_' + _getWeekKey();
            if (_sentThisWeek.has(weekKey)) continue;
            const { data: agData } = await supabaseAdmin.from('app_state').select('*').eq('agency_id', state.agency_id).maybeSingle();
            if (agData) {
              const r = await _sendMemberRecap(user, agData, users, state.agency_id);
              _markRecapSent(weekKey);
              log('📬', `Friday recap → member ${String(user.id).slice(0, 8)} (${tz})${r && r.ok === false ? ' [FAILED: ' + (r.error || '') + ']' : ''}`);
            }
          }
        }
      }
    } catch(e) { log('⚠', 'Friday scheduler: ' + e.message); }
  }, 5 * 60 * 1000);
}
scheduleFridayRecaps();

// ── 2-hour "timer still running?" check (in-memory activeTimers) ──────────────
const _longTimerReminded = new Set();
function scheduleLongTimerCheck() {
  setInterval(async function() {
    try {
      if (!supabaseAdmin) return;
      const now = Date.now();
      const TWO_H = 2 * 60 * 60 * 1000;
      for (const uid of Object.keys(_runningTimers)) {
        const t = _runningTimers[uid];
        if (!t || !t.startedAt) continue;
        const elapsed = now - t.startedAt;
        if (elapsed < TWO_H) continue;
        const key = uid + '|' + t.startedAt;
        if (_longTimerReminded.has(key)) continue;
        _longTimerReminded.add(key);
        const { data: m } = await supabaseAdmin.from('agency_members')
          .select('user_id,active,preferences').eq('id', String(uid)).maybeSingle();
        if (!m || m.active === false || !m.user_id) continue;
        if (!_pushPrefOn(m, 'pushTimerLongRunning')) continue;
        // Restarts reset _longTimerReminded: don't nudge the same session twice.
        if (await _sentRecently(String(m.user_id), 'timer_long_running', Math.max(elapsed - TWO_H, 0) + 10 * 60 * 1000)) continue;
        await _recordSent(String(m.user_id), 'timer_long_running', 'Timer still running');
        const hrs = Math.floor(elapsed / 3600000);
        await sendPushToUser(String(m.user_id), 'Timer still running',
          'Your timer on ' + (t.projectName || 'a project') + ' has been going ' + hrs + 'h+. Still on it, or left running?',
          { kind: 'timer_long_running' }).catch(function(){});
        log('🔔', 'long-timer nudge -> ' + String(m.user_id).slice(0, 8));
      }
      for (const key of Array.from(_longTimerReminded)) {
        const uid = key.split('|')[0];
        const t = _runningTimers[uid];
        if (!t || (uid + '|' + t.startedAt) !== key) _longTimerReminded.delete(key);
      }
    } catch(e) { log('⚠', 'long-timer check: ' + e.message); }
  }, 5 * 60 * 1000);
}
scheduleLongTimerCheck();

// Durable "already sent" check for scheduled pushes, backed by notifications_sent
// (the in-memory sets reset on every deploy/restart). Fails open (sends) on DB errors.
async function _sentRecently(userId, kind, withinMs) {
  try {
    const since = new Date(Date.now() - withinMs).toISOString();
    const { data, error } = await supabaseAdmin.from('notifications_sent')
      .select('id').eq('user_id', userId).eq('kind', kind).gte('sent_at', since).limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch (e) { return false; }
}
async function _recordSent(userId, kind, title, body, data) {
  try {
    await supabaseAdmin.from('notifications_sent').insert({
      user_id: userId, kind: kind, title: title || '', body: body || '', data: data || null, delivered: true,
    });
  } catch (e) { /* best effort */ }
}

// ── 8:45am daily "track your time" reminder (per agency timezone) ─────────────
const _morningReminded = new Set();
function scheduleMorningTrackReminder() {
  setInterval(async function() {
    try {
      if (!supabaseAdmin) return;
      const { data: states } = await supabaseAdmin.from('app_state').select('agency_id,brand');
      if (!states || !Array.isArray(states)) return;
      for (const state of states) {
        const tz = (state.brand && state.brand.timezone) || 'Pacific/Auckland';
        const userNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
        const hour = userNow.getHours(), minute = userNow.getMinutes();
        if (!(hour === 8 && minute >= 45 && minute < 50)) continue;
        const dateStr = userNow.getFullYear() + '-' + (userNow.getMonth() + 1) + '-' + userNow.getDate();
        const members = await _agencyActiveMembers(state.agency_id);
        for (const m of members) {
          if (!m.user_id) continue;
          // One reminder per PERSON per day: someone in two studios used to get one per membership.
          const key = String(m.user_id) + '|' + dateStr;
          if (_morningReminded.has(key)) continue;
          _morningReminded.add(key);
          if (!_pushPrefOn(m, 'pushForgotToTrack')) continue;
          // Durable guard too (survives restarts and a second server instance): skip if already sent
          // in the last 12 hours.
          if (await _sentRecently(String(m.user_id), 'morning_reminder', 12 * 3600 * 1000)) continue;
          await _recordSent(String(m.user_id), 'morning_reminder', 'Track your time');
          await sendPushToUser(String(m.user_id), 'Track your time',
            'Morning! Start your timer so today\'s hours land on the right project.',
            { kind: 'morning_reminder' }).catch(function(){});
        }
      }
    } catch(e) { log('⚠', 'morning reminder: ' + e.message); }
  }, 5 * 60 * 1000);
}
scheduleMorningTrackReminder();

async function handleGiftTokensEmail(req, res) {
  const { agencyId, tokens, message } = req.body || {};
  if (!agencyId || !tokens) return res.status(400).json({ error: 'agencyId and tokens required' });

  res.json({ ok: true }); // respond immediately, send email async

  try {
    // Write tokens to agency_settings using service key (bypasses RLS)
    const { data: current } = await supabaseAdmin
      .from('agency_settings').select('token_balance').eq('agency_id', agencyId).maybeSingle();
    const newBalance = ((current?.token_balance) || 0) + tokens;
    await supabaseAdmin.from('agency_settings').upsert({
      agency_id: agencyId,
      token_balance: newBalance,
      pending_gift_tokens: tokens,
      pending_gift_message: message || null,
    }, { onConflict: 'agency_id' });
    log('🎁', `Tokens written: ${agencyId} now has ${newBalance} tokens`);

    // Look up the agency's admin email from agency_members
    const { data: members } = await supabaseAdmin
      .from('agency_members')
      .select('email,name')
      .eq('agency_id', agencyId)
      .eq('role', 'admin')
      .eq('active', true)
      .limit(1);

    const recipient = members?.[0];
    if (!recipient?.email) return log('🎁', `No admin email found for ${agencyId}`);

    const firstName = (recipient.name || 'there').split(' ')[0];
    const msgLine = message ? `<p style="font-style:italic;color:#9898aa;margin:0 0 16px;">"${message}"</p>` : '';

    const _giftLogo = await getAgencyLogoHtml(agencyId, '32px');
    const _giftLogoBlock = _giftLogo ? `<div style="margin-bottom:16px;">${_giftLogo}</div>` : '';
    await sendEmail({
      to: recipient.email,
      subject: `🎁 You've been gifted ${tokens} tokens on BSMNT`,
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="background:#0c0c0e;margin:0;padding:0;font-family:'DM Sans',system-ui,sans-serif;">
        <div style="max-width:500px;margin:40px auto;background:#131316;border:1px solid #2c2c36;border-radius:16px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,rgba(124,111,255,0.3),rgba(192,132,252,0.15));padding:32px;text-align:center;border-bottom:1px solid #2c2c36;">
            ${_giftLogoBlock}<div style="font-size:48px;margin-bottom:12px;">🎁</div>
            <h1 style="color:#eeeef2;font-size:22px;margin:0 0 4px;font-weight:700;">You've got tokens!</h1>
            <p style="color:#9898aa;font-size:13px;margin:0;">From the BSMNT team</p>
          </div>
          <div style="padding:28px 32px;">
            <p style="color:#c8c8d8;font-size:15px;margin:0 0 16px;">Hey ${firstName},</p>
            <p style="color:#c8c8d8;font-size:15px;margin:0 0 20px;">We've just added <strong style="color:#c084fc;font-size:18px;">+${tokens} storyboard tokens</strong> to your account.</p>
            ${msgLine}
            <p style="color:#9898aa;font-size:13px;margin:0 0 24px;">Tokens are used to generate AI storyboard panels and character references. They roll over month to month so nothing goes to waste.</p>
            <div style="background:#0c0c0e;border:1px solid #2c2c36;border-radius:10px;padding:16px;text-align:center;margin-bottom:24px;">
              <div style="font-size:32px;font-weight:700;color:#7c6fff;font-family:monospace;">+${tokens}</div>
              <div style="font-size:11px;color:#55556a;text-transform:uppercase;letter-spacing:1px;">tokens added to your balance</div>
            </div>
            <a href="https://bsmnt.co.nz" style="display:block;background:#7c6fff;color:#fff;text-decoration:none;padding:12px;border-radius:8px;text-align:center;font-weight:600;font-size:14px;">Open Week Below →</a>
          </div>
          <div style="padding:16px 32px;border-top:1px solid #2c2c36;text-align:center;">
            <p style="color:#55556a;font-size:11px;margin:0;">BSMNT &middot; bsmnt.co.nz</p>
          </div>
        </div>
      </body></html>`,
    });
    log('🎁', `Gift email sent to ${maskEmail(recipient.email)} (${tokens} tokens)`);
  } catch(e) {
    log('⚠', 'Gift email error: ' + e.message);
  }
}




async function handleCreateCheckout(req, res) {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured — add STRIPE_SECRET_KEY' });
  try {
    const { packageId, agencyId, returnUrl } = req.body;
    if (!packageId || !agencyId) return res.status(400).json({ error: 'packageId and agencyId required' });
    const pkg = TOKEN_PACKAGES[packageId];
    if (!pkg) return res.status(400).json({ error: 'Unknown package' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: {
        currency: 'usd',
        product_data: { name: pkg.name, description: pkg.tokens + ' AI storyboard image credits' },
        unit_amount: pkg.priceUsd * 100,
      }, quantity: 1 }],
      mode: 'payment',
      success_url: (returnUrl || 'https://bsmnt.co.nz') + '?payment=success',
      cancel_url:  (returnUrl || 'https://bsmnt.co.nz') + '?payment=cancelled',
      metadata: { agencyId, packageId, tokens: String(pkg.tokens) },
    });

    log('💳', `Checkout created for agency ${agencyId} — ${pkg.name}`);
    res.json({ url: session.url });
  } catch (e) {
    console.error('create-checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Subscription price IDs (set these in Railway env vars) ───────────────────
// STRIPE_PRICE_SOLO   — price_xxx from Stripe Dashboard
// STRIPE_PRICE_STUDIO — price_xxx from Stripe Dashboard
// STRIPE_PRICE_AGENCY — price_xxx from Stripe Dashboard
const PLAN_PRICES = {
  solo:   process.env.STRIPE_PRICE_SOLO,
  studio: process.env.STRIPE_PRICE_STUDIO,
  agency: process.env.STRIPE_PRICE_AGENCY,
};

async function handleCreateSubscription(req, res) {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  try {
    const { planId, agencyId, returnUrl, email } = req.body;
    if (!planId || !agencyId) return res.status(400).json({ error: 'planId and agencyId required' });
    const priceId = PLAN_PRICES[planId];
    if (!priceId) return res.status(400).json({ error: `No price configured for plan "${planId}". Set STRIPE_PRICE_${planId.toUpperCase()} in Railway env vars.` });

    // Look up or create Stripe customer for this agency
    let customerId = null;
    try {
      const { data: settings } = await supabaseAdmin
        .from('app_state').select('brand').eq('agency_id', agencyId).maybeSingle();
      customerId = settings?.brand?.stripeCustomerId || null;
    } catch(e) { /* ignore */ }

    const sessionParams = {
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: (returnUrl || 'https://bsmnt.co.nz') + '?subscription=success&plan=' + planId,
      cancel_url:  (returnUrl || 'https://bsmnt.co.nz') + '?subscription=cancelled',
      metadata: { agencyId, planId },
      subscription_data: { metadata: { agencyId, planId } },
    };

    if (customerId) sessionParams.customer = customerId;
    else if (email) sessionParams.customer_email = email;

    const session = await stripe.checkout.sessions.create(sessionParams);
    log('💳', `Subscription checkout for agency ${agencyId} — plan: ${planId}`);
    res.json({ url: session.url });
  } catch (e) {
    console.error('create-subscription error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function handleCustomerPortal(req, res) {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  try {
    const { agencyId, returnUrl } = req.query;
    if (!agencyId) return res.status(400).json({ error: 'agencyId required' });

    // Get Stripe customer ID from app_state
    const { data: settings } = await supabaseAdmin
      .from('app_state').select('brand').eq('agency_id', agencyId).maybeSingle();
    const customerId = settings?.brand?.stripeCustomerId;
    if (!customerId) return res.status(404).json({ error: 'No billing account found. Please subscribe first.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || 'https://bsmnt.co.nz',
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('customer-portal error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function handleCancelSubscription(req, res) {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  try {
    const { agencyId } = req.body;
    const { data: settings } = await supabaseAdmin
      .from('app_state').select('brand').eq('agency_id', agencyId).maybeSingle();
    const subId = settings?.brand?.stripeSubscriptionId;
    if (!subId) return res.status(404).json({ error: 'No active subscription found' });

    // Cancel at period end (not immediately)
    await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    log('❌', `Subscription cancelled at period end for agency ${agencyId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('cancel-subscription error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Manual recap trigger (admin only) ────────────────────────────────────────
async function handleSendRecapNow(req, res) {
  try {
    const { agencyId } = req.body || {};
    if (!agencyId) return res.status(400).json({ error: 'agencyId required' });
    // Identity from the verified token (the old body `adminEmail` check was
    // spoofable): an admin of this agency, or the platform owner.
    if (!isPlatformAdmin(req.authUser)) {
      const m = await requireMember(req.authUser.id, String(agencyId));
      if (!m || m.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    }

    const { data: agData } = await supabaseAdmin
      .from('app_state').select('*').eq('agency_id', agencyId).maybeSingle();
    if (!agData) return res.status(404).json({ error: 'Agency not found' });

    const users = await _recapRecipients(agencyId);
    let sent = 0;
    for (const user of users) {
      const r = await _sendMemberRecap(user, agData, users, agencyId);
      if (!(r && r.ok === false)) sent++;
    }
    log('📬', `Manual recap sent to ${sent} users in agency ${agencyId}`);
    res.json({ ok: true, sent });
  } catch (e) {
    console.error('send-recap error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(500).send('Stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature failed:', e.message);
    return res.status(400).send('Webhook Error: ' + e.message);
  }

  try {
    // ── Token purchase completed ──────────────────────────────────────────────
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { agencyId, tokens, planId } = session.metadata || {};

      // Token purchase
      if (agencyId && tokens && !planId) {
        const tokensToAdd = parseInt(tokens, 10);
        const { data: current } = await supabaseAdmin
          .from('app_state').select('agency_id,brand').eq('agency_id', agencyId).maybeSingle();
        const brand = current?.brand || {};
        const newBalance = ((brand.tokenBalance) || 0) + tokensToAdd;
        await supabaseAdmin.from('app_state').update({
          brand: { ...brand, tokenBalance: newBalance }
        }).eq('agency_id', agencyId);
        // The clients and /generate-image, /ai/claude read agency_settings.token_balance,
        // not brand.tokenBalance, so credit that too (upsert creates the row if missing).
        const settingsBal = await _creditAgencyTokens(agencyId, tokensToAdd);
        log('🪙', `Credited ${tokensToAdd} tokens to ${agencyId} (balance ${settingsBal})`);
      }

      // Subscription started via checkout — store customer + subscription IDs
      if (agencyId && planId && session.subscription) {
        await _applySubscription(agencyId, session.customer, session.subscription, planId, 'active');
      }
    }

    // ── Subscription activated / updated ─────────────────────────────────────
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const agencyId = sub.metadata?.agencyId;
      if (agencyId) {
        const planId = _planFromSubscription(sub);
        const status  = sub.status; // active, trialing, past_due, canceled, etc.
        const periodEnd = sub.current_period_end;
        await _applySubscription(agencyId, sub.customer, sub.id, planId, status, periodEnd);
        log('📋', `Subscription ${event.type} for agency ${agencyId} — plan: ${planId}, status: ${status}`);
      }
    }

    // ── Subscription cancelled / expired ─────────────────────────────────────
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const agencyId = sub.metadata?.agencyId;
      if (agencyId) {
        await _applySubscription(agencyId, sub.customer, null, 'free', 'cancelled', null);
        log('❌', `Subscription cancelled for agency ${agencyId} — reverted to free`);
      }
    }

    // ── Payment failed ────────────────────────────────────────────────────────
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const sub = invoice.subscription ? await stripe.subscriptions.retrieve(invoice.subscription) : null;
      const agencyId = sub?.metadata?.agencyId;
      if (agencyId) {
        await _patchBrand(agencyId, { planStatus: 'past_due' });
        log('⚠', `Payment failed for agency ${agencyId}`);
      }
    }

    // ── Payment succeeded (renewing subscription) ─────────────────────────────
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      if (invoice.billing_reason === 'subscription_cycle' && invoice.subscription) {
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const agencyId = sub?.metadata?.agencyId;
        if (agencyId) {
          const planId = _planFromSubscription(sub);
          await _applySubscription(agencyId, sub.customer, sub.id, planId, 'active', sub.current_period_end);

          // Add monthly token allowance
          const monthlyTokens = { solo: 0, studio: 20, agency: 100 };
          const bonus = monthlyTokens[planId] || 0;
          if (bonus > 0) {
            const { data: current } = await supabaseAdmin
              .from('app_state').select('brand').eq('agency_id', agencyId).maybeSingle();
            const brand = current?.brand || {};
            await supabaseAdmin.from('app_state').update({
              brand: { ...brand, tokenBalance: ((brand.tokenBalance) || 0) + bonus }
            }).eq('agency_id', agencyId);
            await _creditAgencyTokens(agencyId, bonus);
            log('🪙', `Monthly ${bonus} tokens added for agency ${agencyId} (${planId})`);
          }
        }
      }
    }

  } catch (e) {
    console.error('Webhook handler error:', e.message);
  }

  res.json({ received: true });
}

// ── Subscription helpers ──────────────────────────────────────────────────────
function _planFromSubscription(sub) {
  // Map price ID back to plan name
  const priceId = sub.items?.data?.[0]?.price?.id;
  if (priceId === process.env.STRIPE_PRICE_AGENCY) return 'agency';
  if (priceId === process.env.STRIPE_PRICE_STUDIO) return 'studio';
  if (priceId === process.env.STRIPE_PRICE_SOLO)   return 'solo';
  return sub.metadata?.planId || 'solo';
}

async function _patchBrand(agencyId, patch) {
  // Write to app_state.brand (for UI sync)
  const { data: current } = await supabaseAdmin
    .from('app_state').select('brand').eq('agency_id', agencyId).maybeSingle();
  const brand = current?.brand || {};
  await supabaseAdmin.from('app_state')
    .update({ brand: { ...brand, ...patch } }).eq('agency_id', agencyId);
  // Also write billing fields to agency_settings so the postgres_changes listener fires
  // This is the authoritative source — app always reads billing from here on load
  const billingPatch = {};
  if (patch.plan        !== undefined) billingPatch.plan         = patch.plan;
  if (patch.planStatus  !== undefined) billingPatch.plan_status  = patch.planStatus;
  if (patch.planPeriodEnd !== undefined) billingPatch.plan_period_end = patch.planPeriodEnd;
  if (Object.keys(billingPatch).length) {
    await supabaseAdmin.from('agency_settings')
      .upsert({ agency_id: agencyId, ...billingPatch }, { onConflict: 'agency_id' });
  }
}

async function _applySubscription(agencyId, customerId, subscriptionId, planId, status, periodEnd) {
  await _patchBrand(agencyId, {
    plan: planId,
    planStatus: status,
    stripeCustomerId: customerId || undefined,
    stripeSubscriptionId: subscriptionId || undefined,
    planPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : undefined,
  });
}

// Add n tokens to agency_settings.token_balance (the balance every client and
// the image/AI endpoints read). Returns the new balance.
async function _creditAgencyTokens(agencyId, n) {
  const { data: cur, error } = await supabaseAdmin.from('agency_settings')
    .select('token_balance').eq('agency_id', agencyId).maybeSingle();
  if (error) throw error;
  const next = ((cur && typeof cur.token_balance === 'number') ? cur.token_balance : 0) + (n || 0);
  await _setAgencyTokenBalance(agencyId, next);
  return next;
}

// Write agency_settings.token_balance, creating the row if it doesn't exist.
// Upsert on agency_id (the column every agency_settings lookup keys on).
async function _setAgencyTokenBalance(agencyId, balance) {
  const { error } = await supabaseAdmin.from('agency_settings')
    .upsert({ agency_id: agencyId, token_balance: balance }, { onConflict: 'agency_id' });
  if (error) throw error;
}

async function handleGenerateImage(req, res) {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const { prompt, agencyId, refImages, refImageData } = req.body;
    if (!prompt || !agencyId) return res.status(400).json({ error: 'prompt and agencyId required' });
    // requireAuth + needMember({collaborator}) already ran (route table): the
    // caller is a member of the agency, or collaborates on one of its projects.
    // Billing is archived, so nobody is charged studio tokens.
    // Support both single refImageData (legacy) and refImages array
    const imageRefs = (refImages ? (Array.isArray(refImages) ? refImages : [refImages])
                     : refImageData ? [refImageData] : []).slice(0, 8);

    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + process.env.GEMINI_API_KEY,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              // Include all reference images (scene ref, character refs)
              ...imageRefs.filter(function(r){ return r && r.data; }).map(function(r) {
                return { inlineData: { mimeType: r.mimeType || 'image/jpeg', data: r.data } };
              }),
              { text: prompt }
            ]
          }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], aspectRatio: '16:9' }
        }) }
    );

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      console.error('Gemini API error', geminiRes.status, errBody.slice(0, 400));
      // Handle rate limiting specifically
      if (geminiRes.status === 429) {
        return res.status(429).json({ error: 'Rate limit hit — please wait a few seconds and try again.' });
      }
      return res.status(500).json({ error: 'Gemini error ' + geminiRes.status + ': ' + errBody.slice(0,200) });
    }

    const geminiData = await geminiRes.json();
    const imgPart = (geminiData?.candidates?.[0]?.content?.parts || [])
      .find(p => p.inlineData?.mimeType?.startsWith('image/'));

    if (!imgPart) {
      // Log full response to understand why no image was returned
      console.error('No image part in Gemini response:', JSON.stringify(geminiData).slice(0, 400));
      const reason = geminiData?.candidates?.[0]?.finishReason || 'unknown';
      return res.status(500).json({ error: 'No image returned from Gemini (finish reason: ' + reason + ')' });
    }

    log('🎬', `Generated image for ${agencyId} (user ${String(req.authUser.id).slice(0, 8)})`);
    res.json({ imageUrl: 'data:' + imgPart.inlineData.mimeType + ';base64,' + imgPart.inlineData.data });
  } catch (e) {
    console.error('generate-image error:', e.message);
    res.status(500).json({ error: e.message });
  }
}


// ── AI Briefing (text-only, for dashboard insight) ───────────────────────────

// ── GET /agency-brand/:agencyId — public brand info for brief form ────────────
async function handleAgencyBrand(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { agencyId } = req.params;
  if (!agencyId) return res.status(400).json({ error: 'agencyId required' });
  try {
    const { data: state } = await supabaseAdmin.from('app_state')
      .select('brand').eq('agency_id', agencyId).maybeSingle();
    const b = state?.brand || {};
    res.json({
      name: b.appName || b.name || 'BSMNT',
      accentColor: b.accentColor || '',
      // Don't send logoBase64 publicly — too large
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

// ── POST /submit-brief — RETIRED ──────────────────────────────────────────────
// Unauthenticated, and it emailed a confirmation to any address in the body with
// unescaped body fields (an open relay). Nothing calls it: brief.html saves to
// client_briefs and then calls /notify/new-brief. The old implementation is
// kept below (_legacySubmitBrief, unrouted) for reference.
async function handleSubmitBrief(req, res) {
  return res.status(410).json({ error: 'This endpoint has been retired. Use the brief form.' });
}
async function _legacySubmitBrief(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { agencyId, client, project } = req.body || {};
  if (!agencyId || !client?.email || !client?.name) {
    return res.status(400).json({ error: 'agencyId, client name and email required' });
  }
  try {
    // Get agency admin emails + brand
    const [{ data: members }, { data: state }] = await Promise.all([
      supabaseAdmin.from('agency_members').select('name,email,role,active').eq('agency_id', agencyId),
      supabaseAdmin.from('app_state').select('brand').eq('agency_id', agencyId).maybeSingle(),
    ]);
    const admins = (members || []).filter(m => m && m.role === 'admin' && m.active !== false && m.email); // unrouted legacy
    if (!admins.length) return res.status(404).json({ error: 'No admin found for this studio' });

    const b = state?.brand || {};
    const studioName = b.appName || b.name || 'BSMNT';
    const accent = b.accentColor || '#7c6fff';

    // Build email HTML
    const row = (label, val) => val ? `<tr><td style="padding:5px 0;font-size:11px;font-family:monospace;letter-spacing:1px;text-transform:uppercase;color:#666;width:130px;vertical-align:top;">${label}</td><td style="padding:5px 0;font-size:13px;color:#111;">${val}</td></tr>` : '';
    const moods = Array.isArray(project?.mood) ? project.mood.join(', ') : project?.mood || '';

    const html = `
      <div style="background:#f5f5f3;padding:32px 16px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
        <div style="max-width:560px;margin:0 auto;">
          <div style="background:#111;border-radius:10px 10px 0 0;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;">
            <span style="font-family:monospace;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.4);">${studioName}</span>
            <span style="font-family:monospace;font-size:9px;color:rgba(255,255,255,0.3);">NEW CLIENT BRIEF</span>
          </div>
          <div style="background:#fff;border-radius:0 0 10px 10px;overflow:hidden;">
            <div style="padding:24px;border-bottom:1px solid #eee;">
              <div style="font-size:10px;font-family:monospace;letter-spacing:2px;text-transform:uppercase;color:${accent};margin-bottom:8px;">New Brief Received</div>
              <div style="font-size:22px;font-weight:700;color:#111;letter-spacing:-0.3px;">${client.name}${client.company ? ' · '+client.company : ''}</div>
              <div style="font-size:13px;color:#888;margin-top:4px;"><a href="mailto:${client.email}" style="color:${accent};">${client.email}</a>${client.phone ? ' · '+client.phone : ''}</div>
            </div>
            <div style="padding:24px;border-bottom:1px solid #eee;">
              <div style="font-size:10px;font-family:monospace;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:14px;">Project Details</div>
              <table style="width:100%;border-collapse:collapse;">
                ${row('Project type', project?.type)}
                ${row('Description', project?.desc)}
                ${row('Success looks like', project?.success)}
                ${row('Mood / tone', moods)}
                ${row('References', project?.refs)}
                ${row('Shoot date', project?.shootDate)}
                ${row('Deadline', project?.deadline)}
                ${row('Location', project?.location)}
                ${row('Budget', project?.budget)}
                ${row('Extra notes', project?.notes)}
                ${row('Heard about us', project?.referral)}
              </table>
            </div>
            <div style="padding:20px 24px;background:#fafafa;text-align:center;">
              <a href="https://bsmnt.co.nz/app" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;">Open BSMNT →</a>
            </div>
          </div>
          <div style="text-align:center;margin-top:16px;font-size:11px;color:#aaa;font-family:monospace;">Sent via BSMNT · bsmnt.co.nz</div>
        </div>
      </div>`;

    // Send to all admins
    const subject = `New brief from ${client.name}${client.company ? ' ('+client.company+')' : ''} — ${project?.type || 'Video Project'}`;
    await Promise.all(admins.map(admin => sendEmail({ to: admin.email, subject, html })));

    // Also send confirmation to client
    const confirmHtml = `
      <div style="background:#f5f5f3;padding:32px 16px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
        <div style="max-width:480px;margin:0 auto;">
          <div style="background:#111;border-radius:10px 10px 0 0;padding:18px 24px;">
            <span style="font-family:monospace;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.4);">${studioName}</span>
          </div>
          <div style="background:#fff;border-radius:0 0 10px 10px;padding:28px;">
            <div style="font-size:10px;font-family:monospace;letter-spacing:2px;text-transform:uppercase;color:${accent};margin-bottom:12px;">Brief received</div>
            <div style="font-size:20px;font-weight:700;color:#111;margin-bottom:12px;">Thanks, ${client.name.split(' ')[0]}!</div>
            <p style="font-size:14px;color:#555;line-height:1.7;margin-bottom:16px;">We've received your brief for <strong>${project?.type || 'your video project'}</strong> and will be in touch within 1–2 business days to discuss next steps.</p>
            <p style="font-size:13px;color:#888;line-height:1.7;">In the meantime, feel free to reply to this email if you have any questions or want to add anything.</p>
          </div>
          <div style="text-align:center;margin-top:16px;font-size:11px;color:#aaa;font-family:monospace;">Sent via BSMNT · bsmnt.co.nz</div>
        </div>
      </div>`;
    await sendEmail({ to: client.email, subject: `Brief received — ${studioName}`, html: confirmHtml });

    log('📋', `Brief submitted for agency ${agencyId}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[submit-brief] error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Notify studio of a new client brief ───────────────────────────────────────
// Called by the rebuilt brief.html AFTER it has already inserted the brief into
// client_briefs. This endpoint only sends the internal heads-up email to the
// studio's admins + managers; the brief is already saved, so any failure here is
// logged and swallowed (always returns 200 so the client never sees an error and
// the success screen isn't blocked). Payload is the flat summary that brief.html
// POSTs: { agency_id, name, company, email, phone, project_type, budget,
//          description, submitted_at }.
//
// PUBLIC (brief.html has no login), so the body is only used to FIND the brief:
// the email is sent only when a matching client_briefs row exists (same agency,
// submitted_at within a few seconds of the posted one, saved in the last 30
// minutes), each brief is announced at most once, and the email content comes
// from the saved row, not the request.
const _briefsNotified = new Map(); // brief id -> notified at (ms); pruned after 24h
async function _findRecentBrief(agencyId, submittedAt, email) {
  const want = Date.parse(submittedAt || '');
  if (!isFinite(want) || Math.abs(Date.now() - want) > 10 * 60 * 1000) return null;
  const { data, error } = await supabaseAdmin.from('client_briefs')
    .select('id,agency_id,submission,submitted_at').eq('agency_id', String(agencyId))
    .order('submitted_at', { ascending: false }).limit(20);
  if (error || !Array.isArray(data)) return null;
  const wantEmail = String(email || '').toLowerCase().trim();
  return data.find(r => {
    const t = Date.parse(r && r.submitted_at);
    if (!isFinite(t) || Math.abs(t - want) > 5000 || Math.abs(Date.now() - t) > 10 * 60 * 1000) return false;
    let sub = r.submission;
    if (typeof sub === 'string') { try { sub = JSON.parse(sub); } catch (e) { sub = {}; } }
    const rowEmail = String((sub && sub.email) || '').toLowerCase().trim();
    return !wantEmail || !rowEmail || rowEmail === wantEmail;
  }) || null;
}

/**
 * Who receives "the studio" emails (new client brief, etc.).
 * Default: ACTIVE ADMINS of the agency with a real email. Deactivated/removed
 * members, managers, freelancers and guests are never included by default.
 * Override: app_state.brand.briefNotifyMemberIds = [agency_members.id, ...]
 * (non-empty) -> exactly those members, still only if active, same agency and
 * with an email.
 */
async function _studioNotifyRecipients(agencyId, brand) {
  if (!supabaseAdmin || !agencyId) return [];
  const { data, error } = await supabaseAdmin.from('agency_members')
    .select('id,name,email,role,active').eq('agency_id', String(agencyId));
  if (error) { log('⚠', 'studio recipients lookup failed: ' + error.message); return []; }
  const usable = (data || []).filter(m => m && m.active !== false
    && typeof m.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email.trim()));
  const override = brand && Array.isArray(brand.briefNotifyMemberIds)
    ? brand.briefNotifyMemberIds.map(String).filter(Boolean) : [];
  const picked = override.length
    ? usable.filter(m => override.includes(String(m.id)))
    : usable.filter(m => m.role === 'admin');
  const seen = new Set();
  return picked.filter(m => { const e = m.email.trim().toLowerCase(); if (seen.has(e)) return false; seen.add(e); return true; });
}

async function handleNotifyNewBrief(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const posted = req.body || {};
  const agencyId = posted.agency_id;
  if (!agencyId) return res.status(400).json({ ok: false, error: 'agency_id required' });

  try {
    if (!supabaseAdmin) return res.json({ ok: false, error: 'not configured' });
    const briefRow = await _findRecentBrief(agencyId, posted.submitted_at, posted.email);
    if (!briefRow) {
      log('📋', `[new-brief] no matching saved brief for agency ${agencyId}; not emailing`);
      return res.json({ ok: false, error: 'brief not found' });
    }
    const briefKey = String(briefRow.id || (agencyId + '|' + briefRow.submitted_at));
    const nowMs = Date.now();
    for (const [k, t] of _briefsNotified) if (nowMs - t > 24 * 3600 * 1000) _briefsNotified.delete(k);
    if (_briefsNotified.has(briefKey)) return res.json({ ok: true, sent: 0, note: 'already notified' });
    _briefsNotified.set(briefKey, nowMs);
    let sub = briefRow.submission;
    if (typeof sub === 'string') { try { sub = JSON.parse(sub); } catch (e) { sub = {}; } }
    sub = sub || {};
    const b = {
      name: sub.name || '', company: sub.company || '', email: sub.email || '', phone: sub.phone || '',
      project_type: sub.project_type || '', budget: sub.budget || '',
      description: String(sub.description || '').slice(0, 600),
    };

    // Recipients: active admins only (or brand.briefNotifyMemberIds), see
    // _studioNotifyRecipients. Brand for studio name/accent.
    const { data: state } = await supabaseAdmin.from('app_state').select('brand').eq('agency_id', agencyId).maybeSingle();
    let brand = state?.brand || {};
    if (typeof brand === 'string') { try { brand = JSON.parse(brand); } catch (e) { brand = {}; } }
    const admins = await _studioNotifyRecipients(agencyId, brand);
    if (!admins.length) {
      log('📋', `[new-brief] no active recipients for agency ${agencyId}`);
      return res.json({ ok: true, sent: 0, note: 'no recipients' });
    }

    const studioName = brand.appName || brand.name || 'BSMNT';
    const accent = /^#[0-9a-f]{3,8}$/i.test(String(brand.accentColor || '')) ? brand.accentColor : '#7c6fff';

    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const row = (label, val) => val
      ? `<tr><td style="padding:5px 0;font-size:11px;font-family:monospace;letter-spacing:1px;text-transform:uppercase;color:#666;width:130px;vertical-align:top;">${label}</td><td style="padding:5px 0;font-size:13px;color:#111;white-space:pre-wrap;">${esc(val)}</td></tr>`
      : '';

    const clientName = b.name || 'A client';
    const contact = `${b.email ? `<a href="mailto:${esc(b.email)}" style="color:${accent};">${esc(b.email)}</a>` : ''}${b.phone ? ' · ' + esc(b.phone) : ''}`;

    const html = `
      <div style="background:#f5f5f3;padding:32px 16px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
        <div style="max-width:560px;margin:0 auto;">
          <div style="background:#111;border-radius:10px 10px 0 0;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;">
            <span style="font-family:monospace;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.4);">${esc(studioName)}</span>
            <span style="font-family:monospace;font-size:9px;color:rgba(255,255,255,0.3);">NEW CLIENT BRIEF</span>
          </div>
          <div style="background:#fff;border-radius:0 0 10px 10px;overflow:hidden;">
            <div style="padding:24px;border-bottom:1px solid #eee;">
              <div style="font-size:10px;font-family:monospace;letter-spacing:2px;text-transform:uppercase;color:${accent};margin-bottom:8px;">New Brief Received</div>
              <div style="font-size:22px;font-weight:700;color:#111;letter-spacing:-0.3px;">${esc(clientName)}${b.company ? ' · ' + esc(b.company) : ''}</div>
              ${contact ? `<div style="font-size:13px;color:#888;margin-top:4px;">${contact}</div>` : ''}
            </div>
            <div style="padding:24px;border-bottom:1px solid #eee;">
              <div style="font-size:10px;font-family:monospace;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:14px;">Project Details</div>
              <table style="width:100%;border-collapse:collapse;">
                ${row('Project type', b.project_type)}
                ${row('Budget', b.budget)}
                ${row('The brief', b.description)}
              </table>
            </div>
            <div style="padding:20px 24px;background:#fafafa;text-align:center;">
              <a href="https://bsmnt.co.nz/app" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;">Open the full brief in BSMNT →</a>
            </div>
          </div>
          <div style="text-align:center;margin-top:16px;font-size:11px;color:#aaa;font-family:monospace;">Sent via BSMNT · bsmnt.co.nz</div>
        </div>
      </div>`;

    const subject = `New brief from ${clientName}${b.company ? ' (' + b.company + ')' : ''} — ${b.project_type || 'Video Project'}`;
    const results = await Promise.all(admins.map(a => sendEmail({ to: a.email, subject, html })));
    const sent = results.filter(r => !r || r.ok !== false).length;

    log('📋', `[new-brief] emailed ${sent}/${admins.length} recipient(s) for agency ${agencyId}`);
    res.json({ ok: true, sent });
  } catch(e) {
    console.error('[new-brief] error:', e.message);
    res.json({ ok: false, error: 'send failed' }); // 200 — never break the client submit flow
  }
}

async function handleBriefing(req, res) {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 150, temperature: 0.8 }
        })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      const status = geminiRes.status;
      // Rate limit — return 429 so app can handle gracefully
      if (status === 429) return res.status(429).json({ error: 'Rate limited — try again in a moment' });
      return res.status(500).json({ error: 'Gemini error ' + status + ': ' + err.slice(0, 200) });
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) {
      const reason = data?.candidates?.[0]?.finishReason || 'unknown';
      return res.status(500).json({ error: 'No text returned (finishReason: ' + reason + ')' });
    }

    log('💬', 'Briefing generated (' + text.length + ' chars)');
    res.json({ text: text.trim() });
  } catch (e) {
    console.error('[briefing] error:', e.message, e.stack?.split('\n')[1]);
    res.status(500).json({ error: e.message });
  }
}




// ── AI Brainstorm (returns JSON card data for brainstorm board) ──────────────
async function handleAIBrainstorm(req, res) {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const { prompt, agencyId } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.85,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.text();
      const status = geminiRes.status;
      if (status === 429) return res.status(429).json({ error: 'Rate limited — try again in a moment' });
      return res.status(500).json({ error: 'Gemini error ' + status + ': ' + err.slice(0, 200) });
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) {
      const reason = data?.candidates?.[0]?.finishReason || 'unknown';
      return res.status(500).json({ error: 'No response from AI (finishReason: ' + reason + ')' });
    }

    log('✨', 'AI brainstorm generated for ' + (agencyId || 'unknown') + ' (' + text.length + ' chars)');
    res.json({ text: text.trim() });
  } catch (e) {
    console.error('ai-brainstorm error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ══ PROJECT SHARE SYSTEM ═════════════════════════════════════════════════════

// Fields hidden from all share links (view and edit)
const SHARE_HIDDEN_FIELDS = [
  'budget','shootBudget','editBudget','budgetSpent','hardCosts','budgetEntries',
  'timeLog','hardCostsArr'
];

// Remove financial data from a project before sending to external users
function sanitizeProject(p) {
  const clean = Object.assign({}, p);
  SHARE_HIDDEN_FIELDS.forEach(f => delete clean[f]);
  return clean;
}

// Find a project by share token across all agencies
async function findProjectByToken(token) {
  if (!token || token.length < 10) return null;
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('app_state')
      .select('agency_id,projects,brand');

    if (error) {
      console.error('[share] Supabase error:', JSON.stringify(error));
      return null;
    }
    if (!rows || !rows.length) {
      console.log('[share] No rows returned from app_state');
      return null;
    }


    for (const row of rows) {
      let projects = row.projects;
      if (typeof projects === 'string') {
        try { projects = JSON.parse(projects); } catch(e) { continue; }
      }
      if (!Array.isArray(projects)) continue;

      const proj = projects.find(p =>
        p && (p.shareViewToken === token || p.shareEditToken === token)
      );
      if (proj) {
        let brand = row.brand;
        if (typeof brand === 'string') { try { brand = JSON.parse(brand); } catch(e) { brand = {}; } }
        return {
          project: proj,
          agencyId: row.agency_id,
          brand: brand || {},
          type: proj.shareViewToken === token ? 'view' : 'edit'
        };
      }
    }
    return null;
  } catch(e) {
    console.error('[share] Exception:', e.message);
    return null;
  }
}

// GET /project-share/:token — return sanitized project data
async function handleGetProjectShare(req, res) {
  const { token } = req.params;
  try {
    const found = await findProjectByToken(token);
    if (!found) return res.status(404).json({ error: 'Link not found or expired' });

    // Also fetch storyboard data from separate table
    let sbData = null;
    try {
      const { data: sbRows } = await supabaseAdmin
        .from('storyboards')
        .select('panels,title,style,scene')
        .eq('agency_id', found.agencyId)
        .eq('project_id', String(found.project.id))
        .order('updated_at', { ascending: false })
        .limit(1);
      if (sbRows && sbRows.length) sbData = sbRows[0];
    } catch(e) { /* storyboard is optional */ }

    const proj = sanitizeProject(found.project);
    // Embed storyboard panels into the project for the share page
    if (sbData && sbData.panels && sbData.panels.length) {
      if (!proj.runsheet) proj.runsheet = {};
      proj.runsheet.sbPanels = sbData.panels;
    }

    res.json({
      project: proj,
      type: found.type,
      agencyId: found.agencyId,
      brand: {
        name: found.brand.appName || 'BSMNT',
        logo: found.brand.logoBase64 || null,
        accentColor: found.brand.accentColor || '#7c6fff',
      }
    });
  } catch(e) {
    console.error('[share] GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// POST /project-share/:token/edit — apply a change and sync back
async function handleEditProjectShare(req, res) {
  const { token } = req.params;
  const { op, payload, guestName } = req.body || {};
  try {
    const found = await findProjectByToken(token);
    if (!found) return res.status(404).json({ error: 'Link not found or expired' });
    if (found.type !== 'edit') return res.status(403).json({ error: 'This is a view-only link. Use the edit link to make changes.' });

    const guest = (guestName || 'External').slice(0, 40);
    // Push a comment unless one with the same id is already there (a retried
    // request must not add it twice). Returns true when it was added.
    const _addComment = (list, c) => {
      if (list.some(x => x && String(x.id) === String(c.id))) return false;
      list.push(c); return true;
    };

    // ── Apply the operation ───────────────────────────────────────────────────
    // Runs against a fresh copy of the project on every write attempt (see
    // casUpdateAppState below). Returns null, or { status, error } to refuse.
    const applyOp = (proj) => {
    switch(op) {

      // Tasks
      case 'task_toggle': {
        const { stageId, taskId, done } = payload;
        proj.stages = (proj.stages||[]).map(s =>
          s.id !== stageId ? s : { ...s, tasks: (s.tasks||[]).map(t =>
            t.id !== taskId ? t : { ...t, done: !!done }
          )}
        );
        break;
      }
      case 'task_add': {
        const { stageId, name } = payload;
        proj.stages = (proj.stages||[]).map(s =>
          s.id !== stageId ? s : { ...s, tasks: [...(s.tasks||[]),
            { id:'t'+Date.now()+Math.random().toString(36).slice(2,5), name, done:false, _addedBy:guest }
          ]}
        );
        break;
      }
      case 'task_delete': {
        const { stageId, taskId } = payload;
        proj.stages = (proj.stages||[]).map(s =>
          s.id !== stageId ? s : { ...s, tasks: (s.tasks||[]).filter(t => t.id !== taskId) }
        );
        break;
      }
      case 'task_note': {
        const { stageId, taskId, notes } = payload;
        proj.stages = (proj.stages||[]).map(s =>
          s.id !== stageId ? s : { ...s, tasks: (s.tasks||[]).map(t =>
            t.id !== taskId ? t : { ...t, notes }
          )}
        );
        break;
      }

      // Shot list
      case 'shot_add': {
        if (!proj.shotList) proj.shotList = [];
        proj.shotList.push({
          id:'sh'+Date.now()+Math.random().toString(36).slice(2,5),
          desc: payload.desc||'', type: payload.type||'', done:false, _addedBy:guest
        });
        break;
      }
      case 'shot_update': {
        proj.shotList = (proj.shotList||[]).map(s =>
          s.id !== payload.id ? s : { ...s, ...payload.changes }
        );
        break;
      }
      case 'shot_delete': {
        proj.shotList = (proj.shotList||[]).filter(s => s.id !== payload.id);
        break;
      }
      case 'shot_toggle': {
        proj.shotList = (proj.shotList||[]).map(s =>
          s.id !== payload.id ? s : { ...s, done: !!payload.done }
        );
        break;
      }

      // Deliverables
      case 'deliverable_toggle': {
        proj.deliverables = (proj.deliverables||[]).map(d =>
          d.id !== payload.id ? d : { ...d, done: !!payload.done }
        );
        break;
      }

      // Runsheet rows
      case 'rs_row_update': {
        if (proj.runsheet && proj.runsheet.rows) {
          proj.runsheet = { ...proj.runsheet, rows: (proj.runsheet.rows||[]).map(r =>
            r.id !== payload.id ? r : { ...r, ...payload.changes }
          )};
        }
        break;
      }
      case 'rs_row_add': {
        if (!proj.runsheet) proj.runsheet = { rows:[], shotListOrdered:[] };
        if (!proj.runsheet.rows) proj.runsheet.rows = [];
        proj.runsheet = { ...proj.runsheet, rows: [...proj.runsheet.rows,
          { id:'rr'+Date.now()+Math.random().toString(36).slice(2,5), ...payload, _addedBy:guest }
        ]};
        break;
      }
      case 'rs_row_delete': {
        if (proj.runsheet && proj.runsheet.rows) {
          proj.runsheet = { ...proj.runsheet, rows: proj.runsheet.rows.filter(r => r.id !== payload.id) };
        }
        break;
      }
      case 'rs_row_done': {
        if (proj.runsheet && proj.runsheet.rows) {
          proj.runsheet = { ...proj.runsheet, rows: proj.runsheet.rows.map(r =>
            r.id !== payload.id ? r : { ...r, done: !!payload.done }
          )};
        }
        break;
      }

      // Storyboard panels
      case 'sb_panel_update': {
        // Storyboard data lives in runsheet.sbPanels or similar
        const rsData = proj.runsheet || {};
        const panels = rsData.sbPanels || rsData.panels || [];
        const updated = panels.map(p2 =>
          p2.id !== payload.id ? p2 : { ...p2, ...payload.changes }
        );
        proj.runsheet = { ...rsData, [rsData.sbPanels ? 'sbPanels' : 'panels']: updated };
        break;
      }
      case 'sb_panel_add': {
        const rsData2 = proj.runsheet || {};
        const key = rsData2.sbPanels ? 'sbPanels' : 'panels';
        const panels2 = rsData2[key] || [];
        proj.runsheet = { ...rsData2, [key]: [...panels2,
          { id: Date.now()+Math.random(), desc:'', shotType:'', cameraMove:'static', narration:'', imageUrl:null, _addedBy:guest }
        ]};
        break;
      }

      // Brainstorm board (per-project)
      case 'brainstorm_update': {
        // payload.brainstorm = full brainstorm data object {cards,connectors}
        proj.brainstorm = payload.brainstorm;
        break;
      }

      // Brief
      case 'brief_update': {
        proj.brief = { ...(proj.brief||{}), ...payload.changes };
        break;
      }

      // Comments — extends the shot/rsRow/panel/deliverable comment system to share-edit guests
      case 'comment_add': {
        const cmt = payload.comment;
        if (!cmt || !cmt.id || !cmt.text) {
          return { status: 400, error: 'comment must have id and text' };
        }
        // Tag with guest provenance regardless of what client sent (prevents impersonation)
        cmt.isGuest = true;
        cmt.userId = null;
        cmt.userName = guest;
        cmt.time = cmt.time || Date.now();

        const tType = payload.targetType, tId = String(payload.targetId);
        let attached = false, deliverableForNotify = null;
        if (tType === 'deliverable' && Array.isArray(proj.deliverables)) {
          const del = proj.deliverables.find(x => String(x.id) === tId);
          if (del) {
            if (!del.comments) del.comments = [];
            // fire push after the row is written (not again for a retry)
            if (_addComment(del.comments, cmt)) deliverableForNotify = del;
            attached = true;
          }
        } else if (tType === 'shot' && Array.isArray(proj.shotList)) {
          const sh = proj.shotList.find(x => String(x.id) === tId);
          if (sh) { if (!sh.comments) sh.comments = []; _addComment(sh.comments, cmt); attached = true; }
        } else if (tType === 'rsRow' && proj.runsheet) {
          const rsRows = proj.runsheet.rows || proj.runsheet.timeline || [];
          const rr = rsRows.find(x => String(x.id) === tId);
          if (rr) { if (!rr.comments) rr.comments = []; _addComment(rr.comments, cmt); attached = true; }
        } else if (tType === 'panel' && proj.runsheet) {
          const pnls = proj.runsheet.sbPanels || proj.runsheet.panels || proj.panels || [];
          const pn = pnls.find(x => String(x.id) === tId);
          if (pn) { if (!pn.comments) pn.comments = []; _addComment(pn.comments, cmt); attached = true; }
        }
        if (!attached) return { status: 404, error: 'Target not found for comment' };
        // Stash for post-write notify
        proj._pendingCommentNotify = deliverableForNotify
          ? { deliverable: deliverableForNotify, comment: cmt }
          : null;
        break;
      }

      default:
        return { status: 400, error: 'Unknown operation: ' + op };
    }
    return null;
    };

    // Write back: conditional on local_version, so a studio member's save that
    // lands between our read and our write is re-read and kept, not reverted.
    let proj = null, _pending = null, refusal = null;
    const result = await casUpdateAppState(found.agencyId, 'projects', function(row) {
      proj = null; _pending = null; refusal = null;
      const projects = Array.isArray(row.projects) ? [...row.projects] : [];
      const projIdx = projects.findIndex(p => p && p.id === found.project.id);
      // Gone, or the edit link was revoked/rotated since we looked it up.
      if (projIdx < 0 || projects[projIdx].shareEditToken !== token) {
        refusal = { status: 404, error: 'Project not found in state' };
        return null;
      }
      const next = { ...projects[projIdx] };
      const err = applyOp(next);
      if (err) { refusal = err; return null; }
      // Stash + strip the temp pending-notify so it doesn't persist in Supabase
      _pending = next._pendingCommentNotify || null;
      delete next._pendingCommentNotify;
      projects[projIdx] = next;
      proj = next;
      return { projects };
    }, 'share:' + guest);
    if (!result.row) return res.status(404).json({ error: 'State not found' });
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });

    // Fire push notifications for guest deliverable comments (best-effort, non-blocking)
    if (_pending) {
      _notifyDeliverableComment(found.agencyId, proj, _pending.deliverable, _pending.comment, null)
        .catch(e => log('🔔', 'Push notify error: ' + e.message));
    }

    // Notify owner via Supabase Realtime broadcast so their app picks up the change immediately
    // (non-fatal on failure: the owner picks it up via the 30s polling fallback).
    await broadcastStateUpdate(found.agencyId, 'share:' + guest, { op: op });

    log('✏️', `Share edit [${op}] on project ${found.project.name} by ${guest}`);
    res.json({ ok: true, project: sanitizeProject(proj) });

  } catch(e) {
    console.error('[share] EDIT error:', e.message);
    res.status(e && e.status === 409 ? 409 : 500).json({ error: e.message });
  }
}


// ── Project Collaboration Invites ─────────────────────────────────────────────
function _sameEmail(a, b) {
  const x = String(a || '').toLowerCase().trim(), y = String(b || '').toLowerCase().trim();
  return !!x && x === y;
}


const INVITE_ROLES = ['admin', 'manager', 'member', 'user', 'crew', 'pilot', 'chief_pilot'];
async function handleInviteMember(req, res) {
  // requireAuth + needMember({admin}) ran: the caller is an admin of agencyId.
  const { agencyId, email, memberData } = req.body || {};
  let { role } = req.body || {};
  if (!agencyId || !email || typeof email !== 'string' || !email.includes('@'))
    return res.status(400).json({ error: 'agencyId and email required' });
  if (role != null && !INVITE_ROLES.includes(String(role))) return res.status(400).json({ error: 'Invalid role' });
  try {
    const expires = new Date(Date.now() + 7*24*60*60*1000).toISOString();
    // Upsert on (agency_id, email) — prevents duplicate invite rows if admin sends twice
    // Also resets expiry so a re-invite refreshes the 7-day window
    const { error } = await supabaseAdmin.from('invites').upsert({
      agency_id: agencyId,
      email: email.toLowerCase().trim(),
      role: role || 'member',
      expires_at: expires,
      accepted: false, // reset accepted state on re-invite
      member_name:       memberData?.name       || email.split('@')[0],
      member_initials:   memberData?.initials   || email.slice(0,2).toUpperCase(),
      member_color:      memberData?.color      || '#7c6fff',
      cost_rate:         memberData?.costRate   || 0,
      charge_rate:       memberData?.chargeRate || 0,
      can_access_reports: memberData?.canAccessReports || false,
      can_edit_budgets:   memberData?.canEditBudgets   || false,
    }, { onConflict: 'agency_id,email', ignoreDuplicates: false });
    if (error) throw error;
    log('✉', `Member invite created: ${maskEmail(email)} → agency ${agencyId}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('invite-member error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function handleSendProjectInvite(req, res) {
  const { inviterAgencyId, inviterName, projectId, projectName, invitedEmail } = req.body || {};
  if (!inviterAgencyId || !projectId || !invitedEmail)
    return res.status(400).json({ error: 'Missing required fields' });
  try {
    const { data: members } = await supabaseAdmin
      .from('agency_members').select('id,name,agency_id,email').eq('email', invitedEmail).limit(1);
    if (!members?.length)
      return res.status(404).json({ error: 'No BSMNT account found for that email' });
    const guestMember = members[0];
    if (String(guestMember.agency_id) === String(inviterAgencyId))
      return res.status(400).json({ error: 'That user is already in your studio' });
    const { data: existing } = await supabaseAdmin
      .from('project_invites').select('id,status')
      .eq('project_id', projectId).eq('invited_email', invitedEmail).maybeSingle();
    if (existing?.status === 'pending')  return res.status(409).json({ error: 'Invite already sent' });
    if (existing?.status === 'accepted') return res.status(409).json({ error: 'Already collaborating' });
    // Insert invite and fetch the generated ID for the deep link
    const { error: ie } = await supabaseAdmin.from('project_invites').insert({
      project_id: projectId, project_name: projectName,
      owner_agency_id: inviterAgencyId, owner_name: inviterName,
      invited_email: invitedEmail, status: 'pending'
    });
    if (ie) throw ie;
    // Fetch the invite ID we just created
    const { data: newInvite } = await supabaseAdmin.from('project_invites')
      .select('id').eq('invited_email', invitedEmail).eq('project_id', projectId)
      .eq('owner_agency_id', inviterAgencyId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const inviteId = newInvite?.id || '';
    const firstName = escapeHtml((guestMember.name || 'there').split(' ')[0]);
    const pnRaw = String(projectName || 'a project').slice(0, 200);
    const pn = escapeHtml(pnRaw);
    const innRaw = String(inviterName || 'Someone').slice(0, 120);
    const inn = escapeHtml(innRaw);
    sendEmail({
      to: invitedEmail,
      subject: `${innRaw} invited you to collaborate on "${pnRaw}"`,
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="background:#0c0c0e;margin:0;padding:0;font-family:'DM Sans',system-ui,sans-serif;"><div style="max-width:500px;margin:40px auto;background:#131316;border:1px solid #2c2c36;border-radius:16px;overflow:hidden;"><div style="background:linear-gradient(135deg,rgba(124,111,255,0.3),rgba(192,132,252,0.15));padding:32px;text-align:center;border-bottom:1px solid #2c2c36;"><div style="font-size:48px;margin-bottom:12px;">🎬</div><h1 style="color:#eeeef2;font-size:22px;margin:0 0 4px;font-weight:700;">Project Invite</h1><p style="color:#9898aa;font-size:13px;margin:0;">via BSMNT</p></div><div style="padding:28px 32px;"><p style="color:#c8c8d8;font-size:15px;margin:0 0 16px;">Hey ${firstName},</p><p style="color:#c8c8d8;font-size:15px;margin:0 0 20px;"><strong style="color:#eeeef2;">${inn}</strong> has invited you to collaborate on <strong style="color:#7c6fff;">${pn}</strong>.</p><p style="color:#9898aa;font-size:13px;margin:0 0 24px;">Open BSMNT to accept or decline — the invite is waiting in your notifications.</p><a href="https://bsmnt.co.nz/app.html?accept_invite=${encodeURIComponent(inviteId)}" style="display:block;background:#7c6fff;color:#fff;text-decoration:none;padding:14px;border-radius:8px;text-align:center;font-weight:600;font-size:15px;">Accept project invite \u2192</a><p style="color:#55556a;font-size:12px;margin:16px 0 0;text-align:center;">You can also decline from within the BSMNT app.</p></div><div style="padding:16px 32px;border-top:1px solid #2c2c36;text-align:center;"><p style="color:#55556a;font-size:11px;margin:0;">BSMNT \u00b7 Week Below</p></div></div></body></html>`,
    }).catch(e => log('invite email err', e.message));
    log('🤝', `Project invite sent: ${maskEmail(invitedEmail)} for project ${projectId}`);
    res.json({ ok: true });
  } catch(e) {
    var emsg = e.message || String(e);
    // Common case: SQL migrations not run yet
    if (emsg.includes('does not exist') || emsg.includes('42P01')) {
      return res.status(503).json({ error: 'Invite tables not set up — run SQL migrations in Supabase first' });
    }
    console.error('send-project-invite:', emsg);
    res.status(500).json({ error: emsg });
  }
}

async function handleAcceptProjectInvite(req, res) {
  const { inviteId, guestAgencyId, accept } = req.body || {};
  if (!inviteId || !guestAgencyId) return res.status(400).json({ error: 'inviteId and guestAgencyId required' });
  try {
    const { data: invite } = await supabaseAdmin.from('project_invites').select('*').eq('id', inviteId).maybeSingle();
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    // Only the invited person may answer (guestAgencyId membership checked in the route).
    if (!_sameEmail(invite.invited_email, req.authUser.email))
      return res.status(403).json({ error: 'This invite was sent to a different email address' });
    const newStatus = accept ? 'accepted' : 'declined';
    let projectData = null;
    if (accept) {
      // Create collaboration link first; the invite is only marked accepted once
      // the link exists (a failure here used to leave an "accepted" invite with
      // no collaboration and still answer ok).
      const { error: linkErr } = await supabaseAdmin.from('shared_projects').upsert({
        project_id: invite.project_id, owner_agency_id: invite.owner_agency_id, guest_agency_id: guestAgencyId,
      }, { onConflict: 'project_id,guest_agency_id' });
      if (linkErr) throw linkErr;
      // Copy project JSON from owner's app_state
      const { data: ownerState } = await supabaseAdmin.from('app_state').select('projects').eq('agency_id', invite.owner_agency_id).maybeSingle();
      const project = (ownerState?.projects || []).find(p => String(p.id) === String(invite.project_id));
      if (project) {
        await supabaseAdmin.from('shared_project_data').upsert({
          project_id: invite.project_id, owner_agency_id: invite.owner_agency_id,
          project_json: project, updated_by: 'system', updated_at: new Date().toISOString(),
        }, { onConflict: 'project_id,owner_agency_id' });
        // Return project to guest app so it appears immediately
        projectData = Object.assign({}, project, {
          _shared: true,
          _ownerAgencyId: invite.owner_agency_id,
        });
      }
      log('🤝', `Collaboration accepted: ${invite.project_name} by agency ${guestAgencyId}`);
    }
    const { error: stErr } = await supabaseAdmin.from('project_invites').update({ status: newStatus }).eq('id', inviteId);
    if (stErr) throw stErr;
    res.json({ ok: true, status: newStatus, project: projectData });
  } catch(e) {
    console.error('accept-project-invite:', e.message);
    res.status(500).json({ error: e.message });
  }
}


async function handleGetInviteById(req, res) {
  const { inviteId } = req.params;
  if (!inviteId) return res.status(400).json({ error: 'inviteId required' });
  try {
    const { data: invite } = await supabaseAdmin.from('project_invites')
      .select('*').eq('id', inviteId).maybeSingle();
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    const allowed = _sameEmail(invite.invited_email, req.authUser.email)
      || !!(invite.owner_agency_id && await requireMember(req.authUser.id, String(invite.owner_agency_id)));
    if (!allowed) return res.status(404).json({ error: 'Invite not found' });
    res.json({ invite });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

async function handleGetProjectInvites(req, res) {
  const { email } = req.params;
  if (!email) return res.status(400).json({ error: 'email required' });
  if (!_sameEmail(decodeURIComponent(email), req.authUser.email)) return res.status(403).json({ error: 'You can only list your own invites' });
  try {
    const { data } = await supabaseAdmin.from('project_invites')
      .select('*').eq('invited_email', decodeURIComponent(email)).eq('status', 'pending')
      .order('created_at', { ascending: false });
    res.json({ invites: data || [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

// Member invite lookup — bypasses RLS so a brand-new authenticated user (with
// no agency_members row yet) can find their own pending invite.
async function handleCheckMemberInvite(req, res) {
  const { email } = req.params;
  const acceptedFilter = req.query.accepted; // 'any' or undefined (= unaccepted only)
  if (!email) return res.status(400).json({ error: 'email required' });
  // Own invite only: the email must be the verified token's email.
  if (!_sameEmail(decodeURIComponent(email), req.authUser.email)) return res.status(403).json({ error: 'You can only look up your own invite' });
  try {
    const lcEmail = decodeURIComponent(email).toLowerCase().trim();
    // We can't use .order/.limit/.maybeSingle in one chain on the fluent helper
    // so do select first, then take the latest. Filter by accepted unless 'any'.
    const { data, error } = await supabaseAdmin.from('invites')
      .select('*, agencies(*)')
      .eq('email', lcEmail)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    let row = data || null;
    // If caller wants only unaccepted (default) and this row is accepted, drop it
    if (row && acceptedFilter !== 'any' && row.accepted === true) row = null;
    res.json({ invite: row });
  } catch(e) {
    console.error('check-member-invite error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Email via Resend ──────────────────────────────────────────────────────────




async function handleAppendTimeLog(req, res) {
  const { agencyId, projectId, entry } = req.body || {};
  if (!agencyId || !projectId || !entry) {
    return res.status(400).json({ error: 'agencyId, projectId, entry required' });
  }
  if (!entry.hours || !entry.date || !entry.user) {
    return res.status(400).json({ error: 'entry must have hours, date, user' });
  }
  if (typeof entry !== 'object' || Array.isArray(entry)) {
    return res.status(400).json({ error: 'entry must be an object' });
  }
  try {
    // Conditional read-append-write (casUpdateAppState): a client write that
    // lands between our read and write makes us re-read instead of reverting it.
    // Idempotent on entry.id, so a retried request (client timeout, or the web's
    // own full sync having already written the entry) can't store it twice.
    let found = false, duplicate = false;
    const result = await casUpdateAppState(agencyId, 'projects', function(row) {
      found = false; duplicate = false;
      const projects = Array.isArray(row.projects) ? row.projects : [];
      const idx = projects.findIndex(p => p && String(p.id) === String(projectId));
      if (idx < 0) return null;
      found = true;
      const p = projects[idx];
      const timeLog = Array.isArray(p.timeLog) ? p.timeLog : [];
      const hasId = entry.id != null && String(entry.id) !== '';
      if (hasId && timeLog.some(e => e && e.id != null && String(e.id) === String(entry.id))) { duplicate = true; return null; }
      const next = projects.slice();
      next[idx] = Object.assign({}, p, { timeLog: timeLog.concat([entry]) });
      return { projects: next };
    }, req.member && req.member.id);
    if (!result.row) return res.status(404).json({ error: 'Agency state not found' });
    // Used to answer ok and drop the entry. Clients fall back to their own
    // merge-write on a non-ok answer, so the entry isn't lost.
    if (!found) return res.status(404).json({ error: 'Project not found', code: 'project_not_found' });

    log('⏱', duplicate
      ? `Time log already present (retry): project ${projectId} for agency ${agencyId}`
      : `Time log appended: ${entry.hours}h to project ${projectId} for agency ${agencyId}`);
    res.json({ ok: true, duplicate });
  } catch(e) {
    if (e && e.status === 409) return res.status(409).json({ error: e.message });
    log('⏱ append-time-log error:', e.message);
    res.status(500).json({ error: e.message });
  }
}


// ── POST /notify-deliverable-comment ─────────────────────────────────────────
// Called by the client (or internally by the share-edit comment_add op) to
// fan out push notifications to all assignees of a project when a comment
// lands on one of its deliverables. Looks up assignees from app_state, skips
// the comment author, and dispatches via /push/send (whatever your push
// backend points at). Non-blocking — silently no-ops if push isn't deployed.
async function handleNotifyDeliverableComment(req, res) {
  try {
    const b = req.body || {};
    if (!b.agencyId || !b.projectId) {
      return res.status(400).json({ error: 'agencyId and projectId required' });
    }
    const { data: stateRow } = await supabaseAdmin.from('app_state')
      .select('projects').eq('agency_id', b.agencyId).maybeSingle();
    if (!stateRow) return res.status(404).json({ error: 'Agency not found' });
    const proj = (stateRow.projects || []).find(p => String(p.id) === String(b.projectId));
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    let assignees = (Array.isArray(b.assigneeIds) && b.assigneeIds.length)
      ? b.assigneeIds.map(String)
      : (proj.assigned || []).map(String);
    if (b.excludeUserId) {
      assignees = assignees.filter(uid => String(uid) !== String(b.excludeUserId));
    }
    if (!assignees.length) return res.json({ ok: true, sent: 0 });

    await _notifyDeliverableComment(
      b.agencyId,
      proj,
      { id: b.deliverableId, name: b.deliverableName },
      { userName: b.authorName, isGuest: b.authorIsGuest, timecode: b.timecode, text: b.text },
      assignees
    );
    res.json({ ok: true, sent: assignees.length });
  } catch(e) {
    console.error('notify-deliverable-comment error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// Shared notify worker. Used by:
//   1. The /notify-deliverable-comment endpoint (when a logged-in team member posts)
//   2. The handleEditProjectShare 'comment_add' op (when a share-link guest posts)
async function _notifyDeliverableComment(agencyId, proj, del, cmt, explicitAssignees) {
  const assignees = (Array.isArray(explicitAssignees) && explicitAssignees.length)
    ? explicitAssignees.map(String)
    : (proj.assigned || []).map(String);
  if (!assignees.length) return;

  const title = (cmt.userName || 'Someone') + ' commented on ' + ((del && del.name) || 'a deliverable');
  const bodyParts = [];
  if (cmt.timecode) bodyParts.push('[' + cmt.timecode + ']');
  if (cmt.text) bodyParts.push(cmt.text);
  const body = bodyParts.join(' ').slice(0, 200);
  const deeplink = 'https://bsmnt.co.nz/app.html#p=' + proj.id + '&t=deliverables';

  // Fan out per-user via the in-process APNs helper. No HTTP roundtrip — we're
  // calling the same code path /push/send uses but skipping the network hop.
  await pushToMemberIds(agencyId, assignees, 'pushCommentOnCard', title, body, {
    deeplink: deeplink,
    kind: 'deliverable_comment',
    projectId: String(proj.id),
    deliverableId: del && del.id ? String(del.id) : null,
  });
  log('🔔', 'Comment notify fanned to ' + assignees.length + ' assignee(s) on "' + (proj.name || '?') + '"');
}


// ═════════════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS — APNs delivery + token registration
// ═════════════════════════════════════════════════════════════════════════════
// Env vars required (set in Railway). Both APN_ and APNS_ prefixes are accepted
// for each var since both naming conventions are common:
//   APN_KEY_ID / APNS_KEY_ID         — 10-char Key ID from Apple Developer
//                                       Portal → Keys
//   APN_TEAM_ID / APNS_TEAM_ID       — 10-char Team ID from Apple Developer
//                                       Portal → Membership
//   APN_KEY_P8 / APNS_KEY_P8         — the .p8 contents (PEM incl. BEGIN/END
//                                       lines, or base64 of the file). PREFERRED.
//     OR (legacy fallback, only when KEY_P8 is unset)
//   APN_KEY_PATH / APNS_KEY_PATH     — path to a .p8 file on disk. Keep keys
//                                       out of the repo (SECURITY_NOTES.md).
//   APN_BUNDLE_ID / APNS_BUNDLE_ID   — defaults to 'nz.co.belowstudios.bsmnt1'
//   APN_PRODUCTION / APNS_PRODUCTION — 'true' (default) or 'false'.
//                                       *** TestFlight + App Store use the
//                                       PRODUCTION APNs endpoint. Only set
//                                       false if running a dev build from
//                                       Xcode to a phone with the dev
//                                       provisioning profile. ***
//
// Supabase needs a `device_tokens` table — see the SQL migration shipped
// alongside this file.

// Helper: read env var under either APN_ or APNS_ prefix.
function _apnEnv(name) {
  return process.env['APN_' + name] || process.env['APNS_' + name] || '';
}

// Normalise an APNs key from an env var: PEM with real or escaped (\n)
// newlines, or base64 of the whole .p8 file.
function _apnKeyFromEnv(raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (/^["']/.test(v) && v[0] === v[v.length - 1]) v = v.slice(1, -1);
  if (!v.includes('-----BEGIN')) {
    try {
      const dec = Buffer.from(v, 'base64').toString('utf8');
      if (dec.includes('-----BEGIN')) v = dec.trim();
    } catch (e) { /* not base64 */ }
  }
  return v.replace(/\\n/g, '\n');
}

let _apnProvider = null;
let _apnProviderError = null;

function getApnProvider() {
  if (_apnProvider || _apnProviderError) return _apnProvider;
  if (!apn) {
    _apnProviderError = 'package @parse/node-apn not installed';
    return null;
  }
  const keyId  = _apnEnv('KEY_ID');
  const teamId = _apnEnv('TEAM_ID');

  // Two ways to provide the .p8 key (env var wins; the file is only a fallback):
  //   1. APNS_KEY_P8 / APN_KEY_P8 — the .p8 contents in an env var: the PEM text
  //      (real newlines or literal \n), or the whole file base64-encoded.
  //   2. APNS_KEY_PATH / APN_KEY_PATH — path to a .p8 file on disk. Used ONLY
  //      when no KEY_P8 env var is set. Legacy: the key must not live in the repo
  //      (see SECURITY_NOTES.md for the rotation steps).
  let keyContents = null;
  const keyPath = _apnEnv('KEY_PATH');
  const keyInline = _apnKeyFromEnv(_apnEnv('KEY_P8'));
  if (keyInline) {
    keyContents = keyInline;
  } else if (keyPath) {
    try {
      keyContents = fs.readFileSync(keyPath, 'utf8');
    } catch(e) {
      _apnProviderError = 'APNs key file at ' + keyPath + ' could not be read: ' + e.message;
      log('❌', _apnProviderError);
      return null;
    }
  }

  if (!keyId || !teamId || !keyContents) {
    const missing = [];
    if (!keyId) missing.push('KEY_ID');
    if (!teamId) missing.push('TEAM_ID');
    if (!keyContents) missing.push('KEY_PATH or KEY_P8');
    _apnProviderError = 'APNs env vars missing: ' + missing.join(', ') + ' (with APN_ or APNS_ prefix)';
    return null;
  }

  const prodFlag = _apnEnv('PRODUCTION');
  // Default to TRUE. TestFlight + App Store use production APNs. Sending a
  // production token via the sandbox endpoint (or vice versa) gets a
  // BadDeviceToken rejection from Apple — the #1 cause of silent push fails.
  const isProduction = prodFlag === '' ? true : prodFlag !== 'false';

  try {
    _apnProvider = new apn.Provider({
      token: { key: keyContents, keyId: keyId, teamId: teamId },
      production: isProduction,
    });
    log('🔔', 'APNs provider initialized (production=' + isProduction + ', keyId=' + keyId + ')');
    if (!isProduction) {
      log('⚠️ ', 'APN_PRODUCTION=false — sandbox APNs only. TestFlight tokens will be rejected as BadDeviceToken. Set to true for TestFlight/App Store.');
    }
    return _apnProvider;
  } catch(e) {
    _apnProviderError = 'APNs provider init failed: ' + e.message;
    log('❌', _apnProviderError);
    return null;
  }
}

// Send a push to specific iOS device tokens. Returns { sent, failed, error? }.
// Cleans up invalid/expired tokens from the DB on APNs response codes
// (BadDeviceToken, Unregistered) so we don't keep trying to push to dead phones.
async function sendApnsPush(tokens, title, body, payload) {
  const provider = getApnProvider();
  if (!provider) return { sent: 0, failed: 0, error: _apnProviderError };
  if (!Array.isArray(tokens)) tokens = [tokens];
  tokens = tokens.filter(Boolean);
  if (!tokens.length) return { sent: 0, failed: 0 };

  const note = new apn.Notification();
  note.expiry  = Math.floor(Date.now() / 1000) + 3600;
  note.badge   = 1;
  note.sound   = 'default';
  note.alert   = { title: String(title || ''), body: String(body || '') };
  note.topic   = _apnEnv('BUNDLE_ID') || 'nz.co.belowstudios.bsmnt1';
  note.payload = payload || {};

  let result;
  try {
    result = await provider.send(note, tokens);
  } catch(e) {
    log('❌', 'APNs send threw: ' + e.message);
    return { sent: 0, failed: tokens.length, error: e.message };
  }

  if (result.failed && result.failed.length) {
    const dead = result.failed
      .filter(f => f.response && (
        f.response.reason === 'BadDeviceToken' ||
        f.response.reason === 'Unregistered' ||
        f.response.reason === 'DeviceTokenNotForTopic'
      ))
      .map(f => f.device);
    if (dead.length && supabaseAdmin) {
      try {
        await supabaseAdmin.from('device_tokens').delete().in('token', dead);
        log('🗑️', 'Removed ' + dead.length + ' dead push token(s)');
      } catch(e) { /* not critical */ }
    }
    const firstReason = result.failed[0] && result.failed[0].response && result.failed[0].response.reason;
    if (firstReason) log('⚠️', 'APNs failure reason: ' + firstReason);
  }
  return { sent: result.sent.length, failed: result.failed.length };
}

// Look up all tokens for a user, send to each device.
async function sendPushToUser(userId, title, body, payload) {
  if (!supabaseAdmin) return { sent: 0, failed: 0, error: 'supabase not configured' };
  const { data: rows, error } = await supabaseAdmin.from('device_tokens')
    .select('token,platform').eq('user_id', String(userId));
  if (error) return { sent: 0, failed: 0, error: error.message || String(error) };
  if (!rows || !rows.length) return { sent: 0, failed: 0, reason: 'no tokens for user' };
  const iosTokens = rows.filter(r => (r.platform || 'ios') === 'ios').map(r => r.token);
  return sendApnsPush(iosTokens, title, body, payload);
}

// ── Notification fan-out helpers ──────────────────────────────────────────────
// Resolve agency_members.id (the app id used in proj.assigned, timeLog, timer
// events) -> user_id (= the Supabase auth id that device_tokens are keyed by),
// gate on the recipient's own saved preferences, then push.
async function _agencyActiveMembers(agencyId) {
  if (!supabaseAdmin || !agencyId) return [];
  const { data, error } = await supabaseAdmin.from('agency_members')
    .select('id,user_id,role,active,name,preferences')
    .eq('agency_id', String(agencyId)).eq('active', true);
  if (error) { log('⚠', 'members lookup: ' + error.message); return []; }
  return data || [];
}
function _pushPrefOn(member, prefKey) {
  const p = (member && member.preferences) || {};
  if (p.pushEnabled === false) return false;   // master off
  // Focus mode (set by the native app while a focus session runs): skip pushes
  // until it ends. No focusModeUntil = on until switched off; an expired (or
  // unparseable) focusModeUntil means the session is over, so pushes resume.
  if (p.focusModeOn === true && (!p.focusModeUntil || Date.parse(p.focusModeUntil) > Date.now())) {
    return false;
  }
  if (!prefKey) return true;
  return p[prefKey] !== false;                 // default-on
}
async function _pushMember(member, prefKey, title, body, payload) {
  try {
    if (!member || !member.user_id) return;
    if (!_pushPrefOn(member, prefKey)) return;
    await sendPushToUser(String(member.user_id), title, body, payload || {});
  } catch(e) { log('⚠', 'push member: ' + (e && e.message)); }
}
// Notify every active admin of an agency, excluding the actor's member id.
async function pushToAdmins(agencyId, prefKey, title, body, payload, excludeMemberId) {
  const members = await _agencyActiveMembers(agencyId);
  const admins = members.filter(m => m.role === 'admin' && String(m.id) !== String(excludeMemberId || ''));
  await Promise.all(admins.map(m => _pushMember(m, prefKey, title, body, payload)));
  return admins.length;
}
// Notify specific members by agency_members.id (e.g. project assignees).
async function pushToMemberIds(agencyId, memberIds, prefKey, title, body, payload, excludeMemberId) {
  const members = await _agencyActiveMembers(agencyId);
  const want = new Set((memberIds || []).map(String));
  const targets = members.filter(m => want.has(String(m.id)) && String(m.id) !== String(excludeMemberId || ''));
  await Promise.all(targets.map(m => _pushMember(m, prefKey, title, body, payload)));
  return targets.length;
}
// Timer start/stop -> notify the agency's other admins. Fired server-side off
// the websocket so it works no matter which device/platform started the timer.
async function _notifyTimerEvent(kind, timerUserId, userName, projectName) {
  try {
    if (!supabaseAdmin || !timerUserId) return;
    const { data: actor } = await supabaseAdmin.from('agency_members')
      .select('agency_id,name').eq('id', String(timerUserId)).maybeSingle();
    if (!actor || !actor.agency_id) return;
    const who = userName || actor.name || 'Someone';
    const title = who + (kind === 'start' ? ' started tracking time' : ' stopped tracking time');
    const body = projectName ? ('on ' + projectName) : '';
    await pushToAdmins(actor.agency_id, 'pushAdminTimeTracking', title, body,
      { kind: 'admin_time_' + kind }, String(timerUserId));
  } catch(e) { log('⚠', 'timer notify: ' + (e && e.message)); }
}
// POST /notify/project-created -> tell admins a new project landed.
async function handleNotifyProjectCreated(req, res) {
  try {
    const b = req.body || {};
    if (!b.agencyId || !b.projectName) return res.status(400).json({ error: 'agencyId and projectName required' });
    const by = b.byName || 'Someone';
    const n = await pushToAdmins(b.agencyId, 'pushAdminNewProject',
      'New project: ' + b.projectName, by + ' added it to the studio',
      { kind: 'admin_new_project', projectId: b.projectId ? String(b.projectId) : null },
      b.byId);
    res.json({ ok: true, notified: n });
  } catch(e) { console.error('notify-project-created:', e.message); res.status(500).json({ error: e.message }); }
}
// POST /notify/project-assigned -> tell each assignee they are on a project.
async function handleNotifyProjectAssigned(req, res) {
  try {
    const b = req.body || {};
    if (!b.agencyId || !Array.isArray(b.assigneeIds)) return res.status(400).json({ error: 'agencyId and assigneeIds required' });
    const by = b.byName || 'Someone';
    const n = await pushToMemberIds(b.agencyId, b.assigneeIds, 'pushProjectAssigned',
      'You\'re on ' + (b.projectName || 'a project'), by + ' assigned you',
      { kind: 'project_assigned', projectId: b.projectId ? String(b.projectId) : null },
      b.byId);
    res.json({ ok: true, notified: n });
  } catch(e) { console.error('notify-project-assigned:', e.message); res.status(500).json({ error: e.message }); }
}

// POST /notify/timer-event -> a teammate started/stopped a timer. Notify the
// other admins, and maintain _runningTimers so the 2h idle check has state
// (the Railway-ws activeTimers map is never fed by the current client).
async function handleNotifyTimerEvent(req, res) {
  try {
    const b = req.body || {};
    if (!b.agencyId || !b.byId || !b.kind) return res.status(400).json({ error: 'agencyId, byId, kind required' });
    if (b.kind === 'start') {
      _runningTimers[String(b.byId)] = { agencyId: String(b.agencyId), projectName: b.projectName || '', startedAt: Date.now() };
    } else if (b.kind === 'stop') {
      delete _runningTimers[String(b.byId)];
    }
    const who = b.byName || 'Someone';
    const verb = b.kind === 'start' ? ' started tracking time' : ' stopped tracking time';
    const n = await pushToAdmins(b.agencyId, 'pushAdminTimeTracking', who + verb,
      b.projectName ? ('on ' + b.projectName) : '',
      { kind: 'admin_time_' + b.kind }, b.byId);
    res.json({ ok: true, notified: n });
  } catch(e) { console.error('notify-timer-event:', e.message); res.status(500).json({ error: e.message }); }
}

// ── POST /push/register-token ────────────────────────────────────────────────
// Called by the iOS client on first launch + on each app open. Upserts the
// (user_id, token) pair so a single user with multiple devices gets all of them.
async function handleRegisterPushToken(req, res) {
  try {
    const b = req.body || {};
    if (!b.token || typeof b.token !== 'string' || b.token.length > 512) {
      return res.status(400).json({ error: 'token required' });
    }
    if (!supabaseAdmin) return res.status(500).json({ error: 'supabase not configured' });
    // The owner is the verified caller, never the body's userId.
    const uid = String(req.authUser.id);
    if (b.agencyId && !(await requireMember(uid, String(b.agencyId)))) {
      return res.status(403).json({ error: 'Not a member of this agency' });
    }
    const { error } = await supabaseAdmin.from('device_tokens').upsert({
      user_id:      uid,
      agency_id:    b.agencyId ? String(b.agencyId) : null,
      token:        String(b.token),
      platform:     b.platform || 'ios',
      device_name:  b.deviceName || null,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'token' }); // device_tokens.token is UNIQUE (01_supabase_schema.sql); a device that changes user is re-pointed
    if (error) {
      log('❌', 'register-token error: ' + (error.message || error));
      return res.status(500).json({ error: error.message || String(error) });
    }
    log('🔔', 'Push token registered for user ' + uid.slice(0, 8) + '…');
    res.json({ ok: true });
  } catch(e) {
    log('❌', 'register-token threw: ' + e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── POST /push/send ──────────────────────────────────────────────────────────
// Send a push to all of a user's registered devices. Used by the diagnostic
// panel's "send test" button and by the internal notify worker (which calls
// sendPushToUser directly to avoid the HTTP hop).
async function handlePushSend(req, res) {
  try {
    const b = req.body || {};
    if (!b.userId || !b.title) {
      return res.status(400).json({ error: 'userId and title required' });
    }
    // requireAuth ran: only yourself or someone in one of your own studios.
    const ok = await _sharesAgency(String(req.authUser.id), String(b.userId));
    if (!ok) return res.status(403).json({ error: 'You can only push to members of your own studio' });
    const result = await sendPushToUser(String(b.userId), b.title, b.body || '', {
      deeplink:      b.deeplink,
      kind:          b.kind,
      projectId:     b.projectId,
      deliverableId: b.deliverableId,
    });
    res.json({ ok: true, ...result });
  } catch(e) {
    log('❌', 'push/send threw: ' + e.message);
    res.status(500).json({ error: e.message });
  }
}

// True when targetUserId is the caller, or both are active members of at least
// one common agency (agency_members.user_id = Supabase auth id).
async function _sharesAgency(callerUserId, targetUserId) {
  if (!supabaseAdmin || !callerUserId || !targetUserId) return false;
  if (callerUserId === targetUserId) return true;
  const { data: mine, error: e1 } = await supabaseAdmin.from('agency_members')
    .select('agency_id,active').eq('user_id', callerUserId);
  if (e1) throw e1;
  const agencies = (mine || []).filter(r => r && r.active !== false && r.agency_id).map(r => String(r.agency_id));
  if (!agencies.length) return false;
  const { data: theirs, error: e2 } = await supabaseAdmin.from('agency_members')
    .select('agency_id,active').eq('user_id', targetUserId).in('agency_id', agencies);
  if (e2) throw e2;
  return (theirs || []).some(r => r && r.active !== false);
}

// ── /push/prefs ──────────────────────────────────────────────────────────────
// Minimal stub — accepts and returns OK. Wire to real preferences when needed
// (e.g. per-user opt-out for specific notification kinds). Client currently
// doesn't fail if this returns OK with no data.
async function handlePushPrefs(req, res) {
  res.json({ ok: true, prefs: {} });
}

// ── GET /push/status ─────────────────────────────────────────────────────────
// Diagnostic endpoint — returns the current push notification config state so
// we can verify Supabase, the device_tokens table, and APNs without needing
// access to Railway logs. Safe to expose: no secrets are returned, only
// presence-of-config and key IDs (which are not secret).
async function handlePushStatus(req, res) {
  var status = {
    serverTime: new Date().toISOString(),
    supabase: { configured: !!supabaseAdmin },
    deviceTokensTable: { status: 'unchecked' },
    apns: { configured: false, error: null, production: null, bundleId: null, keyId: null, teamId: null },
  };

  // 1. Verify device_tokens table exists by trying a tiny select
  if (supabaseAdmin) {
    try {
      var result = await supabaseAdmin.from('device_tokens').select('id').limit(1);
      // The custom REST wrapper doesn't check HTTP status. If the table doesn't
      // exist Supabase returns an error JSON, which the wrapper passes through
      // as `data` (not `error`). So inspect the data shape.
      if (result.error) {
        status.deviceTokensTable.status = 'error';
        status.deviceTokensTable.error = result.error.message || String(result.error);
      } else if (Array.isArray(result.data)) {
        status.deviceTokensTable.status = 'exists';
        status.deviceTokensTable.firstRowsCount = result.data.length;
      } else if (result.data && result.data.code) {
        // Supabase REST error object: { code, message, hint, details }
        status.deviceTokensTable.status = 'supabase-error';
        status.deviceTokensTable.code = result.data.code;
        status.deviceTokensTable.message = result.data.message;
        status.deviceTokensTable.hint = result.data.hint;
      } else {
        status.deviceTokensTable.status = 'unknown-response';
        status.deviceTokensTable.rawResponse = result.data;
      }
    } catch(e) {
      status.deviceTokensTable.status = 'exception';
      status.deviceTokensTable.error = e.message;
    }
  }

  // 2. APNs provider status — touch the provider once to init/check
  try {
    var prov = getApnProvider();
    if (prov) {
      var prodFlag = _apnEnv('PRODUCTION');
      var isProduction = prodFlag === '' ? true : prodFlag !== 'false';
      status.apns.configured = true;
      status.apns.production = isProduction;
      status.apns.bundleId = _apnEnv('BUNDLE_ID') || 'nz.co.belowstudios.bsmnt1';
      status.apns.keyId = _apnEnv('KEY_ID') || null;
      status.apns.teamId = _apnEnv('TEAM_ID') || null;
      status.apns.usingPrefix = process.env.APN_KEY_ID ? 'APN_' : (process.env.APNS_KEY_ID ? 'APNS_' : 'NONE');
      status.apns.keySource = _apnEnv('KEY_P8') ? 'env-var' : (_apnEnv('KEY_PATH') ? 'file (legacy fallback)' : 'NONE');
    } else {
      status.apns.error = _apnProviderError;
    }
  } catch(e) {
    status.apns.error = 'getApnProvider threw: ' + e.message;
  }

  // 3. Count of registered device tokens (across all users)
  if (supabaseAdmin && status.deviceTokensTable.status === 'exists') {
    try {
      var all = await supabaseAdmin.from('device_tokens').select('id');
      if (Array.isArray(all.data)) {
        status.deviceTokensTable.totalTokens = all.data.length;
      }
    } catch(e) { /* ignore */ }
  }

  res.json(status);
}


// Allowed for (a) an admin of the agency (Team page enable/disable, re-adding a
// removed member), or (b) the invitee re-activating THEIR OWN membership row
// while accepting an invite to that agency (web handlePendingInvite fallback).
// Nobody can change their own row otherwise, and admins can't deactivate themselves.
async function handleSetMemberActive(req, res) {
  const { userId, agencyId, active } = req.body || {};
  if (!userId || !agencyId || active === undefined) {
    return res.status(400).json({ error: 'userId, agencyId, active required' });
  }
  try {
    const caller = await requireMember(req.authUser.id, String(agencyId));
    const isAdmin = !!(caller && caller.role === 'admin');
    if (isAdmin && String(caller.id) === String(userId) && !active) {
      return res.status(400).json({ error: 'You can\u2019t remove yourself from your own studio.' });
    }
    if (!isAdmin) {
      let ok = false;
      if (active) {
        const email = String(req.authUser.email || '').toLowerCase().trim();
        const [{ data: target }, { data: inv }] = await Promise.all([
          supabaseAdmin.from('agency_members').select('id,email,user_id')
            .eq('id', String(userId)).eq('agency_id', String(agencyId)).maybeSingle(),
          supabaseAdmin.from('invites').select('id').eq('agency_id', String(agencyId)).eq('email', email).limit(1),
        ]);
        ok = !!(target && email && Array.isArray(inv) && inv.length &&
          (String(target.user_id || '') === String(req.authUser.id) || String(target.email || '').toLowerCase().trim() === email));
      }
      if (!ok) return res.status(403).json({ error: 'Admins only' });
    }
    const { error } = await supabaseAdmin
      .from('agency_members')
      .update({ active: !!active })
      .eq('id', userId)
      .eq('agency_id', agencyId);
    if (error) return res.status(500).json({ error: error.message });
    log('👤', `Member ${userId} active=${active} in agency ${agencyId} (by ${String(req.authUser.id).slice(0, 8)})`);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}


async function handleLinkPreview(req, res) {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string' || url.length > 2048) return res.status(400).json({ error: 'url required' });
  try {
    // SSRF-safe: http/https only, every resolved address must be public (no
    // loopback/private/link-local/metadata, IPv4 or IPv6), connection pinned to
    // the checked address, redirects re-checked (max 3), 5s, 512 KB cap.
    const resp = await safeFetchText(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BSMNT/1.0)' },
      timeoutMs: 5000, maxBytes: 512 * 1024, maxRedirects: 3,
    });
    const html = resp.text || '';
    function getMeta(prop) {
      const patterns = [
        new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)["\']', 'i'),
        new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*property=["\']' + prop + '["\']', 'i'),
        new RegExp('<meta[^>]+name=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)["\']', 'i'),
      ];
      for (const re of patterns) { const m = html.match(re); if (m) return m[1]; }
      return '';
    }
    const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    res.json({
      title: getMeta('og:title') || getMeta('twitter:title') || (titleMatch && titleMatch[1].trim()) || url,
      description: getMeta('og:description') || getMeta('twitter:description') || getMeta('description') || '',
      image: getMeta('og:image') || getMeta('twitter:image') || '',
    });
  } catch(e) {
    res.json({ title: url, description: '', image: '' });
  }
}

async function handleSaveUserPref(req, res) {
  // The member row comes from the verified token (user_id), never from the
  // body's userId, so nobody can edit another member's preferences.
  const { agencyId, key, value } = req.body || {};
  if (!agencyId || !key) return res.status(400).json({ error: 'agencyId, key required' });
  // Whitelist allowed pref keys — never let clients write arbitrary fields
  const ALLOWED = ['uiTheme', 'cardStyle', 'bgTheme', 'accentColor', 'navOrder', 'lightMode', 'checklist'];
  if (!ALLOWED.includes(key)) return res.status(400).json({ error: 'Key not allowed: ' + key });
  try {
    // Fetch current preferences first
    const { data: row } = await supabaseAdmin
      .from('agency_members')
      .select('id,preferences')
      .eq('user_id', String(req.authUser.id))
      .eq('agency_id', String(agencyId))
      .maybeSingle();
    if (!row) return res.status(404).json({ error: 'Member not found' });
    const prefs = Object.assign({}, row.preferences || {}, { [key]: value });
    const { error } = await supabaseAdmin
      .from('agency_members')
      .update({ preferences: prefs })
      .eq('id', String(row.id))
      .eq('agency_id', String(agencyId));
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

async function handleBulkEmail(req, res) {
  const { subject, body } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
  // Platform owner only: enforced by requirePlatformAdmin on the verified token
  // (the old body agencyId check could be spoofed by anyone).

  try {
    // Fetch all agency admin emails from agency_members
    const { data: members } = await supabaseAdmin
      .from('agency_members')
      .select('email, name, agency_id')
      .eq('role', 'admin')
      .eq('active', true);

    if (!members || !members.length) return res.json({ ok: true, sent: 0 });

    // Dedupe by email
    const seen = new Set();
    const recipients = members.filter(m => {
      if (!m.email || seen.has(m.email)) return false;
      seen.add(m.email);
      return true;
    });

    let sent = 0, failed = 0;
    for (const r of recipients) {
      const firstName = (r.name || 'there').split(' ')[0];
      const personalised = body.replace(/\[first name\]/gi, firstName).replace(/\[name\]/gi, r.name || 'there');
      try {
        await sendEmail({ to: r.email, subject, html: personalised });
        sent++;
      } catch(e) {
        log('✉', 'bulk-email error for ' + maskEmail(r.email) + ': ' + e.message);
        failed++;
      }
    }

    log('✉', `Bulk email sent: ${sent} ok, ${failed} failed. Subject: "${subject}"`);
    res.json({ ok: true, sent, failed, total: recipients.length });
  } catch(e) {
    log('✉ bulk-email error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

async function getAgencyLogoHtml(agencyId, height='36px') {
  try {
    if (!agencyId) return null;
    const { data } = await supabaseAdmin
      .from('app_state').select('brand').eq('agency_id', agencyId).maybeSingle();
    const b = data?.brand || {};
    if (b.logoBase64) return `<img src="${b.logoBase64}" style="height:${height};max-width:160px;object-fit:contain;display:block;margin:0 auto;" alt="logo"/>`;
    if (b.appName) return `<div style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.5px;">${b.appName}</div>`;
  } catch(e) {}
  return null;
}

function sendEmail({ to, subject, html }) {
  if (!RESEND_KEY) { log('✉', `[no key] Would send to ${maskEmail(to)}: ${subject}`); return Promise.resolve(); }
  if (!to || typeof to !== 'string' || !to.includes('@')) { log('✉', 'Skipping — invalid address'); return Promise.resolve(); }
  const body = JSON.stringify({ from: FROM_EMAIL, to, subject, html });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { log('✉', `Sent to ${maskEmail(to)} — ${subject}`); resolve({ ok:true }); }
        else { log('✉', `Failed (${res.statusCode}) to ${maskEmail(to)}: ${String(data).slice(0, 300)}`); resolve({ ok:false, error:`HTTP ${res.statusCode}`, detail:data }); }
      });
    });
    req.on('error', e => { log('✉', `Error: ${e.message}`); resolve({ ok:false, error:e.message }); });
    req.write(body); req.end();
  });
}

const BASE_STYLE = `
  body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#0c0c0e;margin:0;padding:40px 16px;color:#e0e0ec;}
  .wrap{max-width:560px;margin:0 auto;}
  .card{background:#131316;border:1px solid #25252f;border-radius:16px;overflow:hidden;}
  .body{padding:36px 36px 32px;}
  h2{font-size:22px;font-weight:700;margin:0 0 6px;color:#fff;letter-spacing:-0.4px;}
  .sub{font-size:14px;color:#8080a0;margin:0 0 28px;line-height:1.6;}
  .slabel{font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#55556a;margin:24px 0 10px;border-bottom:1px solid #25252f;padding-bottom:8px;}
  .prow{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid #1e1e28;}
  .pname{font-size:13px;font-weight:600;color:#e0e0ec;} .pmeta{font-size:11px;color:#55556a;margin-top:2px;}
  .badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap;}
  .ok{background:rgba(52,211,153,0.12);color:#34d399;} .warn{background:rgba(251,191,36,0.12);color:#fbbf24;} .over{background:rgba(248,113,113,0.12);color:#f87171;}
  .stats{display:flex;gap:10px;margin:0 0 24px;}
  .stat{background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:14px 16px;flex:1;text-align:center;}
  .sn{font-size:24px;font-weight:700;color:#7c6fff;letter-spacing:-0.5px;} .sl{font-size:10px;color:#55556a;margin-top:3px;text-transform:uppercase;letter-spacing:0.5px;}
  .drow{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #1e1e28;}
  .dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
  .proj-card{background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:20px 22px;margin:20px 0;border-left:3px solid #7c6fff;}
  .proj-card-name{font-size:17px;font-weight:700;color:#fff;margin-bottom:5px;}
  .proj-card-client{font-size:12px;color:#55556a;} .proj-card-due{font-size:12px;color:#8080a0;margin-top:8px;}
  .proj-card-desc{font-size:13px;color:#8080a0;margin-top:12px;line-height:1.65;}
  .ftr{padding:20px 36px;text-align:center;font-size:11px;color:#3a3a50;line-height:1.8;border-top:1px solid #25252f;}
`;

function wrap(body, logoHtml) {
  const _logo = logoHtml ||
    `<div style="display:inline-block;background:#7c6fff;border-radius:10px;width:40px;height:40px;line-height:40px;text-align:center;font-size:20px;font-weight:700;color:#fff;">B</div>
     <div style="font-size:18px;font-weight:700;color:#fff;margin-top:6px;">BSMNT</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>${BASE_STYLE}</style></head>
<body><div class="wrap">
  <div style="text-align:center;padding-bottom:24px;">${_logo}</div>
  <div class="card"><div class="body">${body}</div>
  <div class="ftr">BSMNT &middot; bsmnt.co.nz<br>You're receiving this as a member of your studio.</div>
  </div>
</div></body></html>`;
}

async function weeklyEmail(user, { myProjects, completedThisWeek, hoursLastWeek, dueItems, overdueItems, agencyId }) {
  const _wLogo = agencyId ? await getAgencyLogoHtml(agencyId) : null;
  const dateLabel = new Date().toLocaleDateString('en-NZ', { day:'numeric', month:'long', year:'numeric' });
  const firstName = String(user.name || 'there').split(' ')[0];
  if (Array.isArray(completedThisWeek)) completedThisWeek = completedThisWeek.length;
  const projRows = myProjects.map(p => {
    const cls = p.budgetPct < 70 ? 'ok' : p.budgetPct < 100 ? 'warn' : 'over';
    const label = p.budgetPct < 70 ? 'On track' : p.budgetPct < 100 ? 'Watch budget' : 'Over budget';
    const dueFmt = p.endDate ? new Date(p.endDate+'T12:00:00').toLocaleDateString('en-NZ',{day:'numeric',month:'short'}) : null;
    return `<div class="prow"><div><div class="pname">${p.name}</div><div class="pmeta">${p.client || ''}${dueFmt?' · Due '+dueFmt:''}</div></div><span class="badge ${cls}">${label}</span></div>`;
  }).join('') || '<p style="font-size:13px;color:#55556a;padding:8px 0;">No active projects assigned to you.</p>';
  const allDue = [...overdueItems, ...dueItems];
  const dueRows = allDue.map(d => {
    const col = d.overdue ? '#f87171' : '#fbbf24';
    return `<div class="drow"><div class="dot" style="background:${col}"></div><div style="flex:1"><div style="font-size:13px;font-weight:500;color:#e0e0ec">${d.name}</div><div style="font-size:11px;color:#55556a">${d.type==='project'?'Project':'Task'}</div></div><span style="font-size:12px;font-weight:600;color:${col}">${d.overdue?'Overdue':'Due '+d.dueLabel}</span></div>`;
  }).join('') || '<p style="font-size:13px;color:#55556a;padding:8px 0;">Nothing due this week 🎉</p>';
  return {
    subject: `Your BSMNT recap — ${dateLabel}`,
    html: wrap(`<h2>Morning, ${firstName} 👋</h2><p class="sub">Your studio recap for the week of ${dateLabel}</p>
      <div class="stats"><div class="stat"><div class="sn">${hoursLastWeek.toFixed(1)}h</div><div class="sl">Hours logged</div></div>
      <div class="stat"><div class="sn">${myProjects.length}</div><div class="sl">Active projects</div></div>
      <div class="stat"><div class="sn" style="color:#34d399">${completedThisWeek}</div><div class="sl">Tasks done</div></div></div>
      <div class="slabel">Your Active Projects</div>${projRows}
      <div class="slabel">Due This Week / Overdue</div>${dueRows}`, _wLogo),
  };
}

function assignmentEmail(user, projectIn, byNameIn, logoHtml) {
  const H = escapeHtml;
  const project = {
    name: String((projectIn && projectIn.name) || 'a project'),
    client: H(projectIn && projectIn.client || ''),
    endDate: projectIn && /^\d{4}-\d{2}-\d{2}$/.test(String(projectIn.endDate || '')) ? projectIn.endDate : '',
    description: H(projectIn && projectIn.description || ''),
  };
  const byName = H(byNameIn || 'Someone');
  const firstName = H((user.name || 'there').split(' ')[0]);
  const dueFmt = project.endDate ? new Date(project.endDate+'T12:00:00').toLocaleDateString('en-NZ',{day:'numeric',month:'long',year:'numeric'}) : null;
  return {
    subject: `You've been added to "${project.name}"`,
    html: wrap(`<h2>You're on a new project</h2>
      <p class="sub">${byName} has assigned you to a project.</p>
      <div class="proj-card">
        <div class="proj-card-name">${H(project.name)}</div>
        ${project.client?`<div class="proj-card-client">${project.client}</div>`:''}
        ${dueFmt?`<div class="proj-card-due">📅 Due ${dueFmt}</div>`:''}
        ${project.description?`<div class="proj-card-desc">${project.description}</div>`:''}
      </div>
      <p style="font-size:13px;color:#8080a0;line-height:1.7;margin:0;">Log in to BSMNT to view the full brief, track your time, and check the run sheet.</p>`, logoHtml),
  };
}

// ── Weekly recap (DEPRECATED · single-tenant) ───────────────────────────────────
// Superseded by scheduleFridayRecaps() (multi-tenant, above). No longer scheduled
// or triggered anywhere — kept for reference only and safe to delete.

function msUntilNextMondayNZT() {
  const NZT = 12 * 3600000;
  const nowNzt = new Date(Date.now() + NZT);
  const day = nowNzt.getUTCDay(), hour = nowNzt.getUTCHours();
  let daysToMonday = (1 - day + 7) % 7;
  if (daysToMonday === 0 && hour >= 8) daysToMonday = 7;
  const nowSecs = nowNzt.getUTCHours()*3600 + nowNzt.getUTCMinutes()*60 + nowNzt.getUTCSeconds();
  const secsToday = daysToMonday === 0 ? (8*3600 - nowSecs) : (86400 - nowSecs + 8*3600 + (daysToMonday-1)*86400);
  return secsToday * 1000;
}

function calcBudgetPct(p) {
  const budgetEntries = (p.budgetEntries||[]).reduce((s,e)=>s+(e.amount||0),0);
  const billed = (p.timeLog||[]).reduce((s,l)=>{
    const u=(appState.users||[]).find(u=>String(u.id)===String(l.user));
    return s+(l.hours*(u?u.chargeRate||0:0));
  },0);
  const total = billed+(p.hardCosts||0)+budgetEntries;
  return p.budget>0?Math.round(total/p.budget*100):0;
}

function sendWeeklyRecaps() {
  if (!appState.seeded||!appState.users.length){log('✉','Recap skipped — no data');return;}
  const now=new Date();
  const lastMonday=new Date(now); lastMonday.setDate(now.getDate()-7); lastMonday.setHours(0,0,0,0);
  const lastSunday=new Date(now); lastSunday.setDate(now.getDate()-1); lastSunday.setHours(23,59,59,999);
  const nextWeekEnd=new Date(now); nextWeekEnd.setDate(now.getDate()+7); nextWeekEnd.setHours(23,59,59,999);
  const inLastWeek=d=>{if(!d)return false;const x=new Date(d+'T00:00:00');return x>=lastMonday&&x<=lastSunday;};
  const activeProjects=(appState.projects||[]).filter(p=>p.status!=='upcoming');
  const overdueItems=[],dueItems=[];
  activeProjects.forEach(p=>{
    if(!p.endDate)return;const d=new Date(p.endDate+'T23:59:59');
    if(d<now){overdueItems.push({name:p.name,type:'project',overdue:true,dueLabel:p.endDate});}
    else if(d<=nextWeekEnd){const diff=Math.ceil((d-now)/86400000);dueItems.push({name:p.name,type:'project',overdue:false,dueLabel:diff===0?'today':diff===1?'tomorrow':`in ${diff} days`});}
  });
  (appState.tasks||[]).filter(t=>!t.done&&t.dueDate).forEach(t=>{
    const d=new Date(t.dueDate+'T23:59:59');
    if(d<now){overdueItems.push({name:t.name,type:'task',overdue:true,dueLabel:t.dueDate});}
    else if(d<=nextWeekEnd){const diff=Math.ceil((d-now)/86400000);dueItems.push({name:t.name,type:'task',overdue:false,dueLabel:diff===0?'today':diff===1?'tomorrow':`in ${diff} days`});}
  });
  const recipients=(appState.users||[]).filter(u=>u.active!==false&&u.emailWeekly!==false&&u.email&&u.email.includes('@'));
  log('✉',`Sending weekly recaps to ${recipients.length} users`);
  recipients.forEach((user,idx)=>{
    const hoursLastWeek=activeProjects.reduce((s,p)=>s+(p.timeLog||[]).filter(l=>String(l.user)===String(user.id)&&inLastWeek(l.date)).reduce((t,l)=>t+l.hours,0),0);
    const completedThisWeek=(appState.tasks||[]).filter(t=>t.done&&inLastWeek(t.completedAt)).length;
    const myProjects=activeProjects.filter(p=>(p.assigned||[]).map(String).includes(String(user.id))).map(p=>{
      const cl=(appState.clients||[]).find(c=>c.id===p.clientId);
      return{name:p.name,client:cl?cl.name:'',endDate:p.endDate,budgetPct:calcBudgetPct(p)};
    });
    const{subject,html}=weeklyEmail(user,{myProjects,completedThisWeek,hoursLastWeek,dueItems,overdueItems});
    setTimeout(()=>sendEmail({to:user.email,subject,html}),idx*600);
  });
}

function scheduleWeeklyRecap() {
  const ms=msUntilNextMondayNZT();
  log('✉',`Weekly recap in ~${Math.round(ms/3600000)}h`);
  setTimeout(()=>{sendWeeklyRecaps();scheduleWeeklyRecap();scheduleRetainerCheck();},ms);
}

// Assignment emails for projects synced over the socket (web wsSend app_sync).
// Multi-tenant: recipients are ACTIVE members of the sender's agency, looked up
// in agency_members (never the emails in the message), and only when their
// emailAssign preference isn't off. Everything interpolated is escaped.
const _assignPrev = new Map(); // agencyId -> previous projects snapshot (assignment diff only)
async function notifyAssignments(agencyId, newProjects, prevProjects, triggerName) {
  if (!Array.isArray(newProjects) || !supabaseAdmin || !agencyId) return;
  const adds = [];
  newProjects.forEach(newP => {
    if (!newP) return;
    const oldP = (prevProjects || []).find(p => p && String(p.id) === String(newP.id));
    const oldIds = (oldP ? oldP.assigned || [] : []).map(String);
    const added = (newP.assigned || []).map(String).filter(id => !oldIds.includes(id));
    if (added.length) adds.push({ newP, added });
  });
  if (!adds.length) return;
  const { data: members, error } = await supabaseAdmin.from('agency_members')
    .select('id,name,email,active,preferences,email_assign').eq('agency_id', String(agencyId));
  if (error) { log('⚠', 'assignment recipients: ' + error.message); return; }
  const logoHtml = await getAgencyLogoHtml(agencyId);
  for (const { newP, added } of adds) {
    for (const uid of added) {
      const m = (members || []).find(x => String(x.id) === uid);
      if (!m || m.active === false || !m.email || !String(m.email).includes('@')) continue;
      const pref = (m.preferences && m.preferences.emailAssign != null) ? m.preferences.emailAssign : m.email_assign;
      if (pref === false) continue;
      const { subject, html } = assignmentEmail(m, { name: newP.name, client: '', endDate: newP.endDate, description: newP.description }, triggerName || 'Someone', logoHtml);
      sendEmail({ to: m.email, subject, html });
    }
  }
}

// ── WebSocket handler ─────────────────────────────────────────────────────────
// Every socket must authenticate before anything else is processed:
//   first message {type:'auth', token:<Supabase access token>, agencyId?}
//   (or ?token=<access token> on the URL, for clients that can't send first).
// Unauthenticated sockets get no snapshot and every other message is refused.
// Messages are handled strictly in order per socket, so a client can send auth
// and then its payload back-to-back. Broadcasts only reach sockets whose user
// is a member of the payload's agencyId.

const WS_AUTH_TIMEOUT_MS = 30 * 1000;

async function _wsAuthenticate(socket, token, wantAgencyId) {
  const user = await userFromToken(token);
  if (!user) return false;
  const rows = await memberships(user.id);
  socket.user = user;
  socket.memberRows = rows;
  socket.agencies = new Set(rows.map(r => String(r.agency_id)));
  socket.agencyId = (wantAgencyId && socket.agencies.has(String(wantAgencyId))) ? String(wantAgencyId)
                  : (rows[0] ? String(rows[0].agency_id) : null);
  return true;
}

// The agency a message acts on: msg.agencyId if the caller belongs to it,
// otherwise the socket's default agency.
function _wsAgency(socket, msgAgencyId) {
  if (msgAgencyId && socket.agencies && socket.agencies.has(String(msgAgencyId))) return String(msgAgencyId);
  if (msgAgencyId) return null;
  return socket.agencyId || null;
}
function _wsIsAdminOf(socket, agencyId) {
  return !!(socket.memberRows || []).find(r => String(r.agency_id) === String(agencyId) && r.role === 'admin');
}
// agency_members.id (the app's user id in timers/assignments) owned by this socket's user.
function _wsOwnMember(socket, memberId) {
  return (socket.memberRows || []).find(r => String(r.id) === String(memberId)) || null;
}
function _wsSend(socket, obj) {
  try { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj)); } catch (e) {}
}

wss.on('connection', (socket, req) => {
  clients.add(socket);
  socket._lastSync = 0; socket._syncCount = 0;
  socket.user = null; socket.agencies = new Set(); socket.memberRows = [];
  socket._ip = clientIp(req || { headers: {} });
  socket._chain = Promise.resolve();
  log('+', `Client connected (total: ${clients.size})`);

  // Optional URL token (?token=). The web sends {type:'auth'} as its first message instead.
  try {
    const q = new URL((req && req.url) || '/', 'http://x').searchParams;
    const t = q.get('token');
    if (t) socket._chain = socket._chain.then(() => _wsAuthenticate(socket, t, q.get('agencyId'))
      .then(ok => { if (ok) { _wsSend(socket, { type: 'auth_ok' }); sendSnapshot(socket); } }));
  } catch (e) {}

  // Drop sockets that never authenticate.
  socket._authTimer = setTimeout(() => { if (!socket.user) { try { socket.close(4401, 'auth required'); } catch (e) {} } }, WS_AUTH_TIMEOUT_MS);

  socket.on('message', raw => {
    socket._chain = socket._chain
      .then(() => _wsHandleMessage(socket, raw))
      .catch(e => log('⚠', 'ws message error: ' + (e && e.message)));
  });

  socket.on('close', () => { clearTimeout(socket._authTimer); clients.delete(socket); log('-', `Client disconnected (total: ${clients.size})`); });
  socket.on('error', err => { console.error('Socket error:', err.message); clients.delete(socket); });
});

async function _wsHandleMessage(socket, raw) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'auth') {
    if (overLimit('ws-auth', socket._ip, MIN, 30)) return _wsSend(socket, { type: 'auth_error', error: 'rate limited' });
    const ok = await _wsAuthenticate(socket, msg.token, msg.agencyId).catch(() => false);
    if (!ok) { _wsSend(socket, { type: 'auth_error', error: 'invalid token' }); return; }
    clearTimeout(socket._authTimer);
    _wsSend(socket, { type: 'auth_ok' });
    sendSnapshot(socket);
    return;
  }
  if (!socket.user) {
    _wsSend(socket, { type: 'error', error: 'unauthorized', for: String(msg.type || '') });
    return;
  }
  const uid = String(socket.user.id);
  if (overLimit('ws-msg', uid, MIN, 120)) return;
  const EMAIL_TYPES = ['test_email', 'send_recap_now', 'feedback_reply', 'project_assigned', 'feedback_submitted', 'feedback_status_update'];
  if (EMAIL_TYPES.includes(msg.type) && (overLimit('ws-mail-m', uid, MIN, 20) || overLimit('ws-mail-h', uid, HOUR, 200))) {
    if (msg.type === 'test_email') _wsSend(socket, { type: 'email_result', ok: false, error: 'Too many emails. Try again later.' });
    if (msg.type === 'send_recap_now') _wsSend(socket, { type: 'recap_result', ok: false, error: 'Too many requests. Try again later.' });
    return;
  }
  const H = escapeHtml;

  switch (msg.type) {

    case 'timer_start': {
      const { userId, userName, userColor, userInitials, projectId, projectName, taskId, phase } = msg;
      const mem = userId && _wsOwnMember(socket, userId);
      if (!mem) return;
      const agencyId = String(mem.agency_id);
      activeTimers[String(userId)] = { agencyId, userId, userName, userColor, userInitials, projectId, projectName, taskId, phase, startedAt: new Date().toISOString() };
      broadcast({ type:'timer_start', agencyId, timer:activeTimers[String(userId)] }, socket);
      _notifyTimerEvent('start', userId, userName, projectName);
      log('▶', `Timer started (member ${String(userId).slice(0, 8)})`);
      break;
    }

    case 'timer_stop': {
      const { userId } = msg;
      const mem = userId && _wsOwnMember(socket, userId);
      if (!mem) return;
      const timer = activeTimers[String(userId)];
      delete activeTimers[String(userId)];
      broadcast({ type:'timer_stop', agencyId: String(mem.agency_id), userId, timer }, socket);
      if (timer) _notifyTimerEvent('stop', userId, timer.userName, timer.projectName);
      break;
    }

    case 'app_sync': {
      // Web forwards its projects here only so assignment emails can fire. The
      // old code merged every studio's data into one global state and pushed it
      // to every socket; now it is per-agency, in memory, and never re-broadcast.
      const now = Date.now();
      if (now - (socket._lastSync||0) < 500) {
        socket._syncCount = (socket._syncCount||0) + 1;
        if (socket._syncCount > 5) { log('⚠','Rate limit: app_sync throttled'); break; }
      } else { socket._syncCount = 0; }
      socket._lastSync = now;
      const agencyId = _wsAgency(socket, msg.agencyId);
      if (!agencyId || !Array.isArray(msg.projects)) break;
      const prev = _assignPrev.get(agencyId);
      _assignPrev.set(agencyId, msg.projects.map(p => ({ id: p && p.id, assigned: (p && p.assigned) || [] })));
      // First sync after a restart has no baseline: record it, don't email everyone.
      if (prev) notifyAssignments(agencyId, msg.projects, prev, msg.userName).catch(e => log('⚠', 'assign notify: ' + e.message));
      break;
    }

    case 'wb_sync':
    case 'tasks_sync': {
      // Legacy relays; scoped to the sender's agency and not persisted.
      const agencyId = _wsAgency(socket, msg.agencyId);
      if (!agencyId) break;
      const out = msg.type === 'wb_sync'
        ? { type:'wb_sync', agencyId, wbState: msg.wbState || {}, triggeredBy: msg.userName || '?' }
        : { type:'tasks_sync', agencyId, tasks: msg.tasks || [], triggeredBy: msg.userName || '?' };
      broadcast(out, socket);
      break;
    }

    case 'ping': { sendSnapshot(socket); break; }

    case 'test_email': {
      const to = msg.to;
      if (!to || typeof to !== 'string' || !to.includes('@')) { _wsSend(socket, {type:'email_result',ok:false,error:'No valid email address.'}); break; }
      if (!(socket.memberRows || []).some(r => r.role === 'admin') && !isPlatformAdmin(socket.user)) { _wsSend(socket, {type:'email_result',ok:false,to,error:'Admins only.'}); break; }
      if (!RESEND_KEY) { _wsSend(socket, {type:'email_result',ok:false,to,error:'RESEND_API_KEY not set.'}); break; }
      sendEmail({ to, subject:'✅ BSMNT — email test', html:wrap(`
        <h2>Test email ✓</h2>
        <p class="sub">BSMNT emails are working correctly.</p>
        <p style="font-size:13px;color:#8080a0;">Sent: ${new Date().toISOString()}</p>
      `) }).then(r => _wsSend(socket, {type:'email_result',ok:!!(r && r.ok),to,error:(r && r.error)||null}));
      log('✉', `Test email → ${maskEmail(to)}`);
      break;
    }

    case 'send_recap_now': {
      const agencyId = _wsAgency(socket, msg.agencyId);
      if (!agencyId || (!_wsIsAdminOf(socket, agencyId) && !isPlatformAdmin(socket.user))) {
        _wsSend(socket, { type:'recap_result', ok:false, error:'Admins only.' });
        break;
      }
      log('✉', `Manual recap (agency ${agencyId})`);
      try {
        if (!supabaseAdmin) throw new Error('Supabase not configured on the server.');
        const { data: agData } = await supabaseAdmin.from('app_state').select('*').eq('agency_id', agencyId).maybeSingle();
        if (!agData) throw new Error('Agency not found.');
        const users = await _recapRecipients(agencyId);
        let sent = 0, fails = 0;
        for (const user of users) {
          const r = await _sendMemberRecap(user, agData, users, agencyId);
          if (r && r.ok === false) fails++; else sent++;
        }
        _wsSend(socket, { type:'recap_result', ok: fails === 0, count: sent, sent, fails,
          error: fails ? (sent + ' sent, ' + fails + ' failed · check the bsmnt.co.nz domain in Resend') : null });
      } catch(e) {
        _wsSend(socket, { type:'recap_result', ok:false, error:e.message });
      }
      break;
    }

    case 'feedback_reply': {
      // Platform feedback inbox (owner only).
      if (!isPlatformAdmin(socket.user)) break;
      const { userEmail, subject, replyText, senderName } = msg;
      if (!userEmail||typeof userEmail!=='string'||!userEmail.includes('@')||!RESEND_KEY||!replyText||!String(replyText).trim()) break;
      sendEmail({ to:userEmail, subject:String(subject||'Re: your feedback'), html:wrap(`
        <h2>✉ Reply to your feedback</h2>
        <p class="sub">Re: <strong>${H(subject||'your feedback')}</strong></p>
        <div style="background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:20px 24px;margin:20px 0;border-left:3px solid #7c6fff;">
          <div style="font-size:14px;color:#e0e0ec;line-height:1.75;white-space:pre-wrap;">${H(String(replyText).trim())}</div>
        </div>
        <p style="font-size:13px;color:#8080a0;margin:0;">— ${H(senderName||'The BSMNT team')}</p>
      `) });
      log('✉', `Feedback reply → ${maskEmail(userEmail)}`);
      break;
    }

    case 'project_assigned': {
      // Only to an active member of the sender's studio.
      const agencyId = _wsAgency(socket, msg.agencyId);
      const { to, projectName, assignedBy } = msg;
      if (!agencyId || !to || typeof to !== 'string' || !to.includes('@') || !RESEND_KEY) break;
      const { data: rows } = await supabaseAdmin.from('agency_members')
        .select('id,name,email,active').eq('agency_id', agencyId);
      const member = (rows || []).find(r => r && r.active !== false && String(r.email || '').toLowerCase().trim() === to.toLowerCase().trim());
      if (!member) break;
      const logoHtml = await getAgencyLogoHtml(agencyId);
      const { subject, html } = assignmentEmail(member, { name: String(projectName || 'a project') }, String(assignedBy || 'Someone'), logoHtml);
      sendEmail({ to: member.email, subject, html });
      log('✉', `project_assigned → ${maskEmail(member.email)}`);
      break;
    }

    case 'feedback_submitted': {
      // Native sends `entry` (the feedback row) plus flat fields; the web sends
      // only flat fields (agencyId, userName, userEmail, feedbackType, subject,
      // preview, page). Read either shape. Goes to ADMIN_EMAIL only.
      const e = (msg.entry && typeof msg.entry === 'object') ? msg.entry : {};
      const fb = {
        type:       String(e.type || msg.feedbackType || 'general'),
        subject:    e.subject || msg.subject || '',
        message:    e.message || msg.message || msg.preview || '',
        user_name:  e.user_name || msg.userName || '',
        user_email: e.user_email || msg.userEmail || socket.user.email || '',
        page:       e.page || msg.page || '',
        agency_id:  e.agency_id || msg.agencyId || '',
      };
      const isPreview = !e.message && !msg.message && !!msg.preview;
      log('💬', `Feedback [${fb.type}] from agency ${String(fb.agency_id || '?').slice(0, 8)}`);
      const adminEmail=process.env.ADMIN_EMAIL||'';
      if (adminEmail&&adminEmail.includes('@')&&RESEND_KEY) {
        const typeEmoji={bug:'🐛',feature:'💡',general:'💬'}[fb.type]||'💬';
        sendEmail({to:adminEmail,subject:`${typeEmoji} [${fb.type}] ${String(fb.subject||'Feedback').slice(0, 200)}`,html:wrap(`
          <h2>${typeEmoji} New ${H(fb.type)} feedback</h2>
          <p class="sub">From <strong>${H(fb.user_name||'Unknown')}</strong> (${H(fb.user_email||'no email')}) on ${H(fb.page||'unknown page')}</p>
          <div style="background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:20px 24px;margin:20px 0;border-left:4px solid #7c6fff;">
            <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:8px;">${H(fb.subject||'(no subject)')}</div>
            <div style="font-size:14px;color:#8080a0;line-height:1.7;white-space:pre-wrap;">${H(fb.message)}${isPreview && String(fb.message).length >= 120 ? '…' : ''}</div>
          </div>${isPreview ? '<p style="font-size:12px;color:#55556a;">First 120 characters shown; the full message is in the feedback table.</p>' : ''}
        `)});
      }
      break;
    }

    case 'feedback_status_update': {
      if (!isPlatformAdmin(socket.user)) break;
      const { to, subject, status, userName:uName2, customMessage } = msg;
      if (!to||typeof to!=='string'||!to.includes('@')||!RESEND_KEY) break;
      const statusMsg=customMessage||{
        reviewing:"We're looking into this and will keep you posted.",
        shipped:"Great news — this has been shipped!",
        closed:"We've reviewed this and closed it out. Thanks for your time.",
      }[status]||`Status: ${status}`;
      const col=status==='shipped'?'#34d399':status==='reviewing'?'#fbbf24':'#7c6fff';
      sendEmail({to,subject:`Re: ${String(subject||'your feedback').slice(0, 200)}`,html:wrap(`
        <h2>Update on your feedback</h2>
        <p class="sub">Re: <strong>${H(subject||'your feedback')}</strong></p>
        <div style="background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:20px 24px;margin:20px 0;border-left:4px solid ${col};">
          <div style="font-size:14px;color:#e0e0ec;line-height:1.75;white-space:pre-wrap;">${H(statusMsg)}</div>
        </div>
        <p style="font-size:13px;color:#8080a0;">— ${H(uName2||'The team')}</p>
      `)});
      log('✉', `Feedback status → ${maskEmail(to)}: ${String(status).slice(0, 20)}`);
      break;
    }
  }
}

// ── Retainer auto-spawn ───────────────────────────────────────────────────────

function spawnRetainerProjects() {
  if (!appState.seeded) return;
  const retainers = appState.retainers||[];
  if (!retainers.length) return;
  const now=new Date(), todayStr=now.toISOString().split('T')[0], dayOfMonth=now.getUTCDate();
  const monthNames=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthLabel=monthNames[now.getUTCMonth()], year=now.getUTCFullYear();
  let spawned=0;
  retainers.forEach(r=>{
    if (r.active===false) return;
    let shouldSpawn=false; const targetDay=r.dayOfMonth||1;
    if (r.frequency==='monthly'&&dayOfMonth===targetDay) shouldSpawn=true;
    if (r.frequency==='fortnightly'&&(dayOfMonth===targetDay||dayOfMonth===((targetDay+13)%28)+1)) shouldSpawn=true;
    if (r.frequency==='weekly'&&(dayOfMonth-targetDay+28)%7===0) shouldSpawn=true;
    if (!shouldSpawn) return;
    if (r.lastSpawned&&r.lastSpawned.startsWith(todayStr.slice(0,7))) { log('📅',`Retainer "${r.name}" already spawned this month`); return; }
    const lastDay=new Date(year,now.getUTCMonth()+1,0), endDate=lastDay.toISOString().split('T')[0];
    const phaseMap={preproduction:'Pre-Production',production:'Production',postproduction:'Post Production'};
    const project={
      id:Date.now()+Math.floor(Math.random()*10000),
      name:`${r.name} — ${monthLabel} ${year}`,clientId:r.clientId,
      status:r.status||'preproduction',phase:phaseMap[r.status]||'Pre-Production',
      budget:r.budget||0,shootBudget:0,editBudget:0,budgetSpent:{shoot:0,edit:0},
      hardCosts:0,startDate:todayStr,endDate,description:r.description||'',assigned:r.assigned||[],
      stages:[{id:'s1',name:'Pre-Production',tasks:[]},{id:'s2',name:'Production',tasks:[]},{id:'s3',name:'Post Production',tasks:[]}],
      shotList:[],timeLog:[],budgetEntries:[],deliverables:[],retainerId:r.id,
    };
    appState.projects.push(project); r.lastSpawned=todayStr; spawned++;
    log('📅', `Spawned retainer: "${project.name}"`);
    broadcast({ type:'recurring_spawn', project, retainerId:r.id });
  });
  if (spawned>0) scheduleSave();
}

function scheduleRetainerCheck() {
  const NZT=12*3600000, nowNzt=new Date(Date.now()+NZT);
  const secsNow=nowNzt.getUTCHours()*3600+nowNzt.getUTCMinutes()*60+nowNzt.getUTCSeconds();
  let secsUntil=7*3600-secsNow; if (secsUntil<=0) secsUntil+=86400;
  log('📅', `Retainer check in ~${Math.round(secsUntil/3600)}h`);
  setTimeout(()=>{ spawnRetainerProjects(); scheduleRetainerCheck(); }, secsUntil*1000);
}


async function handleProjectReport(req, res) {
  const { agencyId, projectId } = req.params;
  const includeShots = req.query.shots !== '0';       // default: true
  const includeSb    = req.query.sb    === '1';        // default: false
  try {
    const { data: state, error: stateErr } = await supabaseAdmin.from('app_state')
      .select('projects,clients,brand').eq('agency_id', agencyId).maybeSingle();
    if (stateErr) log('❌', `app_state query error: ${stateErr.message}`);
    if (!state) return res.status(404).send('Project not found');
    // Parse projects — sometimes JSONB comes back as string from service key
    let rawProjects = state.projects;
    if (typeof rawProjects === 'string') {
      try { rawProjects = JSON.parse(rawProjects); } catch(e) { rawProjects = []; }
    }
    const allProjects = Array.isArray(rawProjects) ? rawProjects : [];
    const proj = allProjects.find(p => String(p.id) === String(projectId));
    if (!proj) return res.status(404).send('Project not found');
    // Access: the project's share link token (?token=, same tokens as
    // /project-share) for client viewers, or a studio member's bearer token.
    const qToken = typeof req.query.token === 'string' ? req.query.token : '';
    const viaShareToken = qToken.length >= 10 && (qToken === proj.shareViewToken || qToken === proj.shareEditToken);
    if (!viaShareToken) {
      const user = await requireUser(req);
      if (!user) return res.status(401).send('This report link needs a share token.');
      if (!(await requireMember(user.id, String(agencyId)))) return res.status(404).send('Project not found');
    }
    const client  = (state.clients||[]).find(c => String(c.id) === String(proj.clientId));
    const brand   = state.brand || {};
    // Get team members from agency_members (users is not in app_state)
    let users = [];
    try {
      const { data: members } = await supabaseAdmin.from('agency_members')
        .select('id,name,email,role,initials,color,active').eq('agency_id', agencyId);
      // Active members only; share-link viewers don't get staff emails.
      users = (members || []).filter(m => m && m.active !== false)
        .map(m => viaShareToken ? Object.assign({}, m, { email: '' }) : m);
    } catch(e) { /* team members are optional */ }
    const rs      = proj.runsheet || {};
    const timeline    = rs.timeline || rs.rows || [];
    const crew        = rs.crew || [];
    const equipment   = rs.equipment || [];
    const notes       = rs.notes || '';
    const hs          = rs.healthSafety || rs.hs || '';
    const shotList    = (proj.shotList||[]).filter(s => !s.isScene);
    const allShotItems = proj.shotList || [];
    // Storyboard panels — only needed if sb=1
    const sbPanels    = includeSb ? (proj.panels||[]).filter(p => !p.isScene) : [];
    const sbScenes    = includeSb ? (proj.panels||[]).filter(p => p.isScene)  : [];
    const allTasks    = (proj.stages||[]).flatMap(s => (s.tasks||[]).map(t => ({...t, stageName:s.name})));
    const doneTasks   = allTasks.filter(t => t.done);

    // Studio branding
    const accent  = '#7c6fff';
    const accentBg = 'rgba(124,111,255,0.12)';
    const studioName = brand.appName || brand.name || 'BSMNT';
    const logoHtml = brand.logoBase64
      ? `<img src="${brand.logoBase64}" style="height:22px;max-width:120px;object-fit:contain;vertical-align:middle;"/>`
      : `<span style="font-family:'DM Mono',monospace;font-size:10px;font-weight:500;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.5);">${studioName}</span>`;

    // Group timeline by day
    const days = [...new Set(timeline.map(r => r.day||'').filter(Boolean))];
    const useDays = days.length > 0;
    const scheduleGroups = useDays
      ? days.map(d => ({ day: d, rows: timeline.filter(r => r.day === d) }))
      : [{ day: '', rows: timeline }];

    // Duration bar width as % of 12h workday
    function barPct(time) {
      if (!time) return 50;
      const parts = String(time).match(/(\d+):(\d+)/);
      if (!parts) return 50;
      const mins = parseInt(parts[1])*60 + parseInt(parts[2]);
      return Math.min(100, Math.max(8, Math.round((mins - 360) / 720 * 100)));
    }

    // Generate schedule rows HTML
    function schedRows(rows) {
      return rows.map((row, i) => {
        const time  = row.time || row.startTime || '';
        const loc   = row.location || row.desc || row.item || '';
        const notes = row.notes || '';
        const crew  = row.crew || '';
        const isKey = row.isKey || i === 0 || String(loc).toLowerCase().includes('wrap') || String(loc).toLowerCase().includes('crew call');
        // Build the slash-separated detail line: location / notes / crew
        const parts = [loc, notes, crew].filter(Boolean);
        const detail = parts.join(' <span style="color:#ccc;margin:0 3px;">/</span> ');
        return `<div style="display:flex;align-items:baseline;gap:10px;padding:6px 0;border-bottom:1px solid #ebebeb;">
          <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;color:${isKey ? accent : '#888'};width:38px;flex-shrink:0;white-space:nowrap;">${time}</div>
          <div style="flex:1;font-size:10.5px;color:#333;line-height:1.5;">${detail}</div>
        </div>`;
      }).join('');
    }

    // Schedule section (with day headers if multi-day)
    const schedHtml = scheduleGroups.map(g => `
      ${g.day ? `<div style="font-family:'DM Mono',monospace;font-size:7px;letter-spacing:2px;text-transform:uppercase;color:#888;margin:8px 0 6px;padding-bottom:4px;border-bottom:1px solid #e8e8e8;">${g.day}</div>` : ''}
      ${schedRows(g.rows)}
    `).join('');

    // Shot list — scene-grouped
    let shotsHtml = '';
    if (includeShots) {
      let shotNum = 0;
      shotsHtml = (proj.shotList||[]).map(s => {
        if (s.isScene) {
          return `<div class="shot-scene-hdr" style="font-family:'DM Mono',monospace;font-size:7px;letter-spacing:1.5px;text-transform:uppercase;color:#888;margin:10px 0 5px;padding-bottom:3px;border-bottom:1px solid #e8e8e8;">${s.desc||'Scene'}</div>`;
        }
        shotNum++;
        return `<div style="display:flex;gap:7px;margin-bottom:6px;align-items:flex-start;">
          <div style="font-family:'DM Mono',monospace;font-size:8px;color:${accent};width:18px;flex-shrink:0;margin-top:1px;">${String(shotNum).padStart(2,'0')}</div>
          <div style="flex:1;">
            <div style="font-size:10.5px;font-weight:500;color:#111;${s.done?'text-decoration:line-through;color:#aaa;':''}">${s.desc||''}</div>
            ${[s.type,s.angle,s.movement].filter(Boolean).length ? `<div style="font-family:'DM Mono',monospace;font-size:7.5px;color:#aaa;margin-top:1px;">${[s.type,s.angle,s.movement].filter(Boolean).join(' · ')}</div>` : ''}
          </div>
          <div style="width:12px;height:12px;border:1.5px solid ${s.done?accent:'#ddd'};border-radius:3px;flex-shrink:0;margin-top:1px;background:${s.done?accentBg:'transparent'};"></div>
        </div>`;
      }).join('');
    }

    // Storyboard panels — only if sb=1
    let storyboardHtml = '';
    if (includeSb && sbPanels.length > 0) {
      const panelCards = (proj.panels||[]).map(panel => {
        if (panel.isScene) {
          return `<div style="grid-column:1/-1;font-family:'DM Mono',monospace;font-size:7px;letter-spacing:2px;text-transform:uppercase;color:${accent};margin:12px 0 6px;padding-bottom:4px;border-bottom:1px solid #e8e8e8;">${panel.sceneLabel||panel.desc||'Scene'}</div>`;
        }
        return `<div style="border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;break-inside:avoid;">
          ${panel.imageUrl ? `<img src="${panel.imageUrl}" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;"/>` : `<div style="width:100%;aspect-ratio:16/9;background:#f5f5f5;display:flex;align-items:center;justify-content:center;"><span style="font-size:10px;color:#ccc;">No image</span></div>`}
          <div style="padding:6px 8px;">
            ${panel.desc ? `<div style="font-size:9.5px;font-weight:500;color:#111;margin-bottom:2px;">${panel.desc}</div>` : ''}
            ${[panel.shotType,panel.cameraMove,panel.lens].filter(Boolean).length ? `<div style="font-family:'DM Mono',monospace;font-size:7.5px;color:#aaa;">${[panel.shotType,panel.cameraMove,panel.lens].filter(Boolean).join(' · ')}</div>` : ''}
          </div>
        </div>`;
      }).join('');
      storyboardHtml = `<div style="margin:12px 0 8px;font-family:'DM Mono',monospace;font-size:7px;letter-spacing:1.5px;text-transform:uppercase;color:#888;">Storyboard</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">${panelCards}</div>`;
    }

    // Crew cards
    const crewHtml = crew.map(c => `
      <div style="background:#fff;border-radius:5px;padding:8px 10px;border-left:2px solid ${accent};">
        <div style="font-family:'DM Mono',monospace;font-size:7px;letter-spacing:1px;text-transform:uppercase;color:${accent};margin-bottom:3px;">${c.role||''}</div>
        <div style="font-size:11px;font-weight:600;color:#111;">${c.name||''}</div>
        <div style="font-family:'DM Mono',monospace;font-size:8px;color:#888;margin-top:2px;line-height:1.5;">
          ${c.phone ? `${c.phone}<br/>` : ''}${c.company||''}${c.email ? `<br/>${c.email}` : ''}
        </div>
      </div>`).join('');

    // Team members from BSMNT users (as fallback if no runsheet crew)
    const teamHtml = users.slice(0,6).map(u => `
      <div style="background:#fff;border-radius:5px;padding:8px 10px;border-left:2px solid ${accent};">
        <div style="font-family:'DM Mono',monospace;font-size:7px;letter-spacing:1px;text-transform:uppercase;color:${accent};margin-bottom:3px;">${u.role||'Team'}</div>
        <div style="font-size:11px;font-weight:600;color:#111;">${u.name||u.email||''}</div>
        <div style="font-family:'DM Mono',monospace;font-size:8px;color:#888;margin-top:2px;">${u.email||''}</div>
      </div>`).join('');

    const crewSection = crew.length ? crewHtml : teamHtml;

    // Equipment
    const equipHtml = equipment.map(eq => `
      <div style="display:flex;align-items:center;gap:6px;padding:5px 7px;background:#fff;border-radius:4px;">
        <div style="width:10px;height:10px;border:1.5px solid ${eq.packed ? accent : '#ccc'};border-radius:2px;flex-shrink:0;background:${eq.packed ? accentBg : 'transparent'};"></div>
        <span style="font-size:10px;color:#333;flex:1;">${eq.item||''}</span>
        <span style="font-family:'DM Mono',monospace;font-size:7px;color:#aaa;">${eq.category||''}</span>
      </div>`).join('');

    // Shot scenes as section separators (allShotItems already declared above)
    const sceneGroups = [];
    let currentScene = { name: '', shots: [] };
    allShotItems.forEach(s => {
      if (s.isScene) {
        if (currentScene.shots.length || currentScene.name) sceneGroups.push(currentScene);
        currentScene = { name: s.desc || '', shots: [] };
      } else {
        currentScene.shots.push(s);
      }
    });
    if (currentScene.shots.length || !sceneGroups.length) sceneGroups.push(currentScene);

    const date = new Date().toLocaleDateString('en-NZ', { day:'numeric', month:'long', year:'numeric' });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${proj.name||'Runsheet'} — ${studioName}</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=Outfit:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Space Grotesk',sans-serif;background:#f9f9f6;color:#111;font-size:11px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
@media print{
  body{background:#f9f9f6;}
  .no-print{display:none!important;}
  .page-break,.sec-page{page-break-before:always;}
}
.topbar{background:#111;padding:9px 22px;display:flex;align-items:center;justify-content:space-between;}
.hero{padding:16px 22px;border-bottom:1px solid #e4e4e0;display:flex;align-items:flex-end;justify-content:space-between;}
.body-grid{display:grid;grid-template-columns:1fr 36px 1fr;border-bottom:1px solid #e4e4e0;}
.col{padding:14px 20px;}
.divider-col{background:#f2f2ee;border-left:1px solid #e4e4e0;border-right:1px solid #e4e4e0;}
.col-lbl{font-family:'DM Mono',monospace;font-size:7px;letter-spacing:1.5px;text-transform:uppercase;color:#888;margin-bottom:10px;}
.bottom-grid{border-bottom:1px solid #e4e4e0;display:grid;grid-template-columns:1fr 1fr;}
.bottom-col{padding:14px 20px;}
.bottom-col:first-child{border-right:1px solid #e4e4e0;}
.crew-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px;}
.equip-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;}
.notes-row{padding:12px 20px;border-bottom:1px solid #e4e4e0;display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.bottombar{background:#111;padding:7px 22px;display:flex;align-items:center;justify-content:space-between;}
.print-btn{position:fixed;bottom:24px;right:24px;background:#111;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,0.3);}
.print-btn:hover{background:#333;}
.tick{flex:1;width:1px;background:repeating-linear-gradient(to bottom,#bbb 0,#bbb 1px,transparent 1px,transparent 7px);margin:0 auto;}
.section{padding:14px 22px;border-bottom:1px solid #e4e4e0;}
.crew-grid>div,.equip-grid>div{break-inside:avoid;}
.shots-wrap>div{break-inside:avoid;}
.shot-scene-hdr{break-after:avoid;}
</style>
</head>
<body>

<!-- TOP BAR -->
<div class="topbar">
  <div style="display:flex;align-items:center;gap:14px;">
    ${logoHtml}
    <div style="width:1px;height:11px;background:rgba(255,255,255,0.15);"></div>
    <span style="font-size:11px;font-weight:600;color:#fff;">${rs.title || proj.name || ''}</span>
  </div>
  <div style="font-family:'DM Mono',monospace;font-size:8px;color:rgba(255,255,255,0.3);">RS-${String(projectId).slice(-4).toUpperCase()} · ${useDays ? days.length+' DAY'+( days.length>1?'S':'') : 'RUNSHEET'}</div>
</div>

<!-- HERO -->
<div class="hero">
  <div style="flex:1;min-width:0;">
    <div style="font-family:'DM Mono',monospace;font-size:7px;letter-spacing:2px;text-transform:uppercase;color:${accent};margin-bottom:6px;">Production Runsheet</div>
    <div style="font-family:'Plus Jakarta Sans',sans-serif;font-size:24px;font-weight:700;letter-spacing:-0.3px;line-height:1.1;margin-bottom:6px;">${rs.title || proj.name || ''}</div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;font-family:'DM Mono',monospace;font-size:8px;color:#999;margin-bottom:${notes ? '10px' : '0'};">
      ${client ? `<span>${client.name}</span>` : ''}
      ${rs.location ? `<span style="color:#777;">📍 ${rs.location}</span>` : ''}
      ${rs.date ? `<span>📅 ${rs.date}</span>` : ''}
      ${rs.jobType ? `<span>· ${rs.jobType}</span>` : ''}
    </div>
    ${notes ? `<div style="font-size:10px;color:#555;line-height:1.7;max-width:520px;border-left:2px solid ${accent};padding-left:10px;">${notes}</div>` : ''}
  </div>
  <div style="text-align:right;font-family:'DM Mono',monospace;font-size:8px;color:#bbb;line-height:2;flex-shrink:0;margin-left:16px;">
    <div>${date}</div>
    ${timeline.length ? `<div>Call: ${timeline[0].time||timeline[0].startTime||''}</div>` : ''}
    <div style="color:#aaa;">${crew.length ? crew.length+' crew' : ''} ${(includeShots && shotList.length) ? '· '+shotList.length+' shots' : ''}</div>
  </div>
</div>

<!-- CREW (first) -->
${crewSection ? `<div class="section">
  <div class="col-lbl">Crew${crew.length ? ' &middot; ' + crew.length + ' member' + (crew.length>1?'s':'') : ''}</div>
  <div class="crew-grid">${crewSection}</div>
</div>` : ''}

<!-- SCHEDULE -->
<div class="section">
  <div class="col-lbl">Schedule${useDays ? ' &middot; ' + days.length + ' day' + (days.length>1?'s':'') : ''}</div>
  ${schedHtml || '<div style="color:#aaa;font-size:11px;">No schedule added yet.</div>'}
</div>

<!-- EQUIPMENT -->
${equipHtml ? `<div class="section">
  <div class="col-lbl">Equipment checklist</div>
  <div class="equip-grid">${equipHtml}</div>
</div>` : ''}

<!-- HEALTH & SAFETY -->
${hs ? `<div class="section">
  <div class="col-lbl">Health &amp; Safety</div>
  <div style="font-size:10.5px;color:#555;line-height:1.7;max-width:640px;">${hs}</div>
</div>` : ''}

<!-- SHOT LIST (own page) -->
${(includeShots && shotList.length) ? `<div class="section sec-page">
  <div class="col-lbl">Shot list &middot; ${shotList.length} shot${shotList.length!==1?'s':''}</div>
  <div class="shots-wrap">${shotsHtml}</div>
</div>` : ''}

<!-- STORYBOARD (own page) -->
${storyboardHtml ? `<div class="section sec-page">${storyboardHtml}</div>` : ''}
<!-- BOTTOM BAR -->
<div class="bottombar">
  <div style="font-family:'DM Mono',monospace;font-size:7px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,0.2);">
    <div style="width:5px;height:5px;border-radius:50%;background:${accent};display:inline-block;margin-right:5px;"></div>
    ${studioName} · bsmnt.co.nz
  </div>
  <div style="font-family:'DM Mono',monospace;font-size:8px;color:rgba(255,255,255,0.3);"></div>
</div>

<button class="print-btn no-print" onclick="window.print()">⎙ Print / Save PDF</button>

</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\nBSMNT sync server · port ${PORT}`);
  console.log(`Persistence: ${DATA_FILE}`);
  console.log(`State seeded: ${appState.seeded}`);
  console.log(`Resend: ${RESEND_KEY ? 'configured ✓' : 'NO API KEY — emails disabled'}`);
  console.log(`Billing: ${BILLING_ENABLED ? (stripe ? 'enabled, Stripe configured ✓' : 'enabled but STRIPE_SECRET_KEY missing') : 'archived (BILLING_ENABLED != true)'}`);
  console.log(`Supabase: ${supabaseAdmin ? 'configured ✓' : 'not configured — add SUPABASE_URL + SUPABASE_SERVICE_KEY'}`);
  // APNs status — print on boot so misconfig is obvious in Railway logs.
  // Touch the provider once to flip its status flags.
  getApnProvider();
  if (_apnProvider) {
    const prodFlag = _apnEnv('PRODUCTION');
    const isProduction = prodFlag === '' ? true : prodFlag !== 'false';
    console.log(`APNs: configured ✓ (bundle=${_apnEnv('BUNDLE_ID') || 'nz.co.belowstudios.bsmnt1'}, production=${isProduction})`);
  } else {
    console.log(`APNs: ${_apnProviderError || 'not configured'}`);
  }
  console.log('');
});

// Daily retainer-spawn check. Bootstrapped directly here — it used to be nested
// inside the (now-retired) Monday recap timer, which delayed it until the first
// Monday after boot. Weekly recaps run via scheduleFridayRecaps() (multi-tenant).
scheduleRetainerCheck();
