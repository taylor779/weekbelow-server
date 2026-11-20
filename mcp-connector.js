/**
 * BSMNT — AI connector (remote MCP server) for Claude and Grok
 * ────────────────────────────────────────────
 * Lets Claude (claude.ai / desktop / mobile) or Grok (grok.com ▸ Connectors), added as a custom
 * connector, read the studio's data and create/edit projects, tasks, time, clients, client
 * requests, shot lists, run sheets and storyboards, without driving the app's UI. Nothing is deleted.
 *
 * Endpoints (all mounted by server.js via mountMcpConnector):
 *   POST /mcp                                   MCP Streamable HTTP (JSON responses, stateless)
 *   GET  /.well-known/oauth-protected-resource  RFC 9728 metadata (also /mcp suffix variant)
 *   GET  /.well-known/oauth-authorization-server RFC 8414 metadata
 *   POST /oauth/register                        RFC 7591 dynamic client registration (stateless, signed client_id)
 *   GET  /oauth/authorize                       sign-in page (Supabase email/password or Google)
 *   POST /oauth/authorize/complete              page posts the Supabase session here, gets the redirect
 *   POST /oauth/token                           authorization_code (PKCE S256) + refresh_token grants
 *   GET  /mcp/upload/:token                     drop page for one PDF (from bsmnt_create_upload_link)
 *   PUT|POST /mcp/upload/:token                 raw upload of that file
 *
 * Auth model
 *   The access token Claude holds IS the user's Supabase access token (1 h), and the refresh
 *   token is their Supabase refresh token; /oauth/token refreshes through Supabase Auth.
 *   Every MCP call is verified with userFromToken() and every tool checks agency membership
 *   (and can_manage_projects / budget rights for writes), exactly like the other studio routes.
 *   Writes go through casUpdateAppState() and broadcast state_update, so open web/native
 *   apps refetch within a second. Free text is stripped of < and > before it's stored.
 *   PDFs are parsed in a worker thread with memory/time caps (mcp-pdf-frames.js).
 *
 * Runs on ONE instance: OAuth codes (5 min) and upload links (2 h) live in memory, so a
 * restart only means "connect again" / "make a new upload link".
 *
 * Env
 *   MCP_OAUTH_SECRET     required. Long random string (signs client_ids). Without it the
 *                        OAuth routes answer 503 and the connector is off.
 *   SUPABASE_ANON_KEY    required. The public anon key (the sign-in page uses supabase-js).
 *   PUBLIC_URL           required. https://weekbelow-server-production.up.railway.app
 *                        (never derived from request headers, which can be spoofed).
 *   MCP_REDIRECT_URIS    optional. Extra allowed OAuth redirect URIs, comma separated.
 *                        Claude's and Grok's (https on grok.com / x.ai) callbacks and loopback
 *                        (localhost) URIs are always allowed.
 */

const crypto = require('crypto');
const { extractFramesIsolated } = require('./mcp-pdf-frames');

const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CLAUDE_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
// Grok's connector callback lives on xAI's own domains (exact path not published): any https URL there.
const XAI_HOSTS = ['grok.com', 'x.ai'];
const VIA = ' (via AI assistant)';
const CODE_TTL_MS = 5 * 60 * 1000;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const UPLOAD_MAX_BYTES = 60 * 1024 * 1024;
const UPLOAD_TOTAL_MAX = 400 * 1024 * 1024;
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';

const STATUS_PHASE = { upcoming: 'Upcoming', preproduction: 'Pre-Production', production: 'Production', postproduction: 'Post Production', done: 'Completed' };
const SB_SHOT_TYPES = ['', 'ECU', 'CU', 'MCU', 'MS', 'MWS', 'WS', 'EWS', 'OTS', 'POV', 'Aerial'];
const SB_MOVES = ['static', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'dolly-in', 'dolly-out', 'handheld', 'crane', 'drone'];

// ── small helpers ─────────────────────────────────────────────────────────────
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const rand36 = (n) => { let s = ''; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const str = (v, max) => (v == null ? '' : String(v)).slice(0, max || 4000);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
const plain = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
// Free text written into studio data: strip angle brackets so nothing can become a tag in the
// web app, but keep & and quotes as typed (the native app shows these strings verbatim).
const clean = (v, max) => str(v, max).replace(/[<>]/g, '');
const richNotes = (s) => clean(s).replace(/\r?\n/g, '<br>');
const safeHttpsUrl = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' && !/["'<>\s]/.test(u.href) ? u.href.slice(0, 1000) : null; } catch (e) { return null; } };
const same = (a, b) => String(a) === String(b);
const nowIso = () => new Date().toISOString();

function shootRangeText(a, b) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = (s, year) => { if (!isDate(s)) return s; const [y, m, d] = s.split('-').map(Number); return d + ' ' + M[m - 1] + (year ? ' ' + y : ''); };
  if (!a && !b) return '';
  if (a && (!b || b === a)) return fmt(a, true);
  if (!a) return fmt(b, true);
  return fmt(a, false) + ' - ' + fmt(b, true);
}

// "7:30AM" / "07:30" / "12.30pm" -> "HH:mm" (or '' when not a time)
function toHHmm(t) {
  const m = String(t || '').trim().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return '';
  let h = Number(m[1]); const min = Number(m[2] || 0);
  const ap = m[3] ? m[3][0].toLowerCase() : '';
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || min > 59) return '';
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}
function displayTime(t) {
  const hm = toHHmm(t);
  if (!hm) return str(t, 40);
  let [h, m] = hm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + String(m).padStart(2, '0') + ap;
}

function normShotType(t) {
  const s = String(t || '').trim();
  if (!s) return '';
  const hit = SB_SHOT_TYPES.find(x => x.toLowerCase() === s.toLowerCase());
  if (hit !== undefined) return hit;
  const map = { 'wide': 'WS', 'wide shot': 'WS', 'extreme wide': 'EWS', 'medium wide': 'MWS', 'medium-wide': 'MWS', 'medium': 'MS', 'medium shot': 'MS',
    'medium two-shot': 'MS', 'two-shot': 'MS', 'medium close-up': 'MCU', 'close-up': 'CU', 'close up': 'CU', 'extreme close-up': 'ECU',
    'over the shoulder': 'OTS', 'over-the-shoulder': 'OTS', 'point of view': 'POV', 'drone': 'Aerial', 'aerial': 'Aerial' };
  return map[s.toLowerCase()] || '';
}
function normMove(m) {
  const s = String(m || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!s) return 'static';
  if (SB_MOVES.includes(s)) return s;
  const map = { 'pan-l': 'pan-left', 'pan-r': 'pan-right', 'tilt-u': 'tilt-up', 'tilt-d': 'tilt-down', 'tracking': 'handheld', 'track': 'handheld', 'gimbal': 'handheld', 'push-in': 'dolly-in', 'pull-out': 'dolly-out', 'aerial': 'drone', 'locked-off': 'static', 'tripod': 'static' };
  return map[s] || 'static';
}

// ── the module ────────────────────────────────────────────────────────────────
module.exports = function mountMcpConnector(deps) {
  const { app, express, supaRest, casUpdateAppState, broadcastStateUpdate, userFromToken, memberships, log, pushToAdmins, SUPA_URL, SUPA_KEY, rateLimit } = deps;
  const SECRET = process.env.MCP_OAUTH_SECRET || '';
  const ANON = process.env.SUPABASE_ANON_KEY || '';
  const PUBLIC = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const enabled = !!(SECRET && ANON && SUPA_URL && SUPA_KEY && /^https?:\/\//.test(PUBLIC));
  const say = (m) => (log ? log('🔌', '[mcp] ' + m) : console.log('[mcp] ' + m));
  if (!enabled) say('connector OFF: set MCP_OAUTH_SECRET, SUPABASE_ANON_KEY and PUBLIC_URL to enable');
  else say('connector on at ' + PUBLIC + '/mcp');

  const limitAuth = rateLimit ? rateLimit({ name: 'mcp-auth', windowMs: 60 * 1000, max: 30, by: 'ip' }) : (q, r, n) => n();
  const limitMcp = rateLimit ? rateLimit({ name: 'mcp-call', windowMs: 60 * 1000, max: 240, by: 'ip' }) : (q, r, n) => n();
  const limitUpload = rateLimit ? rateLimit({ name: 'mcp-upload', windowMs: 60 * 1000, max: 20, by: 'ip' }) : (q, r, n) => n();

  // Never derived from request headers (Host / X-Forwarded-Host can be spoofed).
  const baseUrl = () => PUBLIC;
  const off = (res) => res.status(503).json({ error: 'temporarily_unavailable', error_description: 'The BSMNT connector is not configured on this server.' });

  // ── OAuth: client registration (stateless, HMAC-signed client_id) ──────────
  const hmac = (s) => b64url(crypto.createHmac('sha256', SECRET).update(s).digest()).slice(0, 22);
  const extraRedirects = String(process.env.MCP_REDIRECT_URIS || '').split(',').map(s => s.trim()).filter(Boolean);
  function redirectAllowed(uri) {
    if (CLAUDE_REDIRECTS.includes(uri) || extraRedirects.includes(uri)) return true;
    try {
      const u = new URL(uri);
      if (u.protocol === 'https:' && !u.username && !u.password && XAI_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return true;
      return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
    } catch (e) { return false; }
  }
  function makeClientId(uris, name) {
    const payload = b64url(JSON.stringify({ u: uris, n: str(name, 80) }));
    return 'bsmnt.' + payload + '.' + hmac(payload);
  }
  function readClientId(id) {
    const m = String(id || '').match(/^bsmnt\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!m || !SECRET) return null;
    const want = hmac(m[1]);
    if (want.length !== m[2].length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]))) return null;
    try { return JSON.parse(fromB64url(m[1]).toString('utf8')); } catch (e) { return null; }
  }

  const codes = new Map(); // code -> { clientId, redirectUri, challenge, session, exp }
  setInterval(() => { const t = Date.now(); for (const [k, v] of codes) if (v.exp < t) codes.delete(k); }, 60 * 1000).unref();

  function protectedResourceMeta(req, res) {
    const base = baseUrl(req);
    res.json({ resource: base + '/mcp', authorization_servers: [base], bearer_methods_supported: ['header'], resource_name: 'BSMNT' });
  }
  app.get('/.well-known/oauth-protected-resource', protectedResourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMeta);
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = baseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: base + '/oauth/authorize',
      token_endpoint: base + '/oauth/token',
      registration_endpoint: base + '/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['bsmnt'],
    });
  });

  app.post('/oauth/register', limitAuth, (req, res) => {
    if (!enabled) return off(res);
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (!uris.length) return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris required' });
    const bad = uris.filter(u => !redirectAllowed(u));
    if (bad.length) return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'Redirect URI not allowed: ' + bad[0] });
    res.status(201).json({
      client_id: makeClientId(uris, b.client_name),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: str(b.client_name || 'AI assistant', 80),
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  function checkAuthorizeParams(q) {
    const client = readClientId(q.client_id);
    if (!client) return 'Unknown client. Remove the BSMNT connector in your AI app and add it again.';
    if (!q.redirect_uri || !client.u.includes(q.redirect_uri) || !redirectAllowed(q.redirect_uri)) return 'Redirect URI not registered for this client.';
    if (q.response_type !== 'code') return 'Only response_type=code is supported.';
    if (!q.code_challenge || (q.code_challenge_method || 'plain') !== 'S256') return 'PKCE (S256) is required.';
    return null;
  }

  app.get('/oauth/authorize', limitAuth, (req, res) => {
    if (!enabled) return off(res);
    const q = req.query || {};
    const problem = checkAuthorizeParams(q);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    if (problem) return res.status(400).send(page('Can’t connect', '<p class="err">' + esc(problem) + '</p>'));
    const cfg = {
      supabaseUrl: SUPA_URL, anonKey: ANON,
      params: { client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state || '', code_challenge: q.code_challenge },
      completeUrl: baseUrl(req) + '/oauth/authorize/complete',
      selfUrl: baseUrl(req) + req.originalUrl,
    };
    res.send(page('Connect your AI assistant to BSMNT', loginBody(), cfg));
  });

  app.post('/oauth/authorize/complete', limitAuth, async (req, res) => {
    if (!enabled) return off(res);
    try {
      const b = req.body || {};
      const problem = checkAuthorizeParams({ ...b, response_type: 'code', code_challenge_method: 'S256' });
      if (problem) return res.status(400).json({ error: problem });
      const user = await userFromToken(String(b.access_token || ''));
      if (!user) return res.status(401).json({ error: 'Sign-in expired. Try again.' });
      if (!b.refresh_token) return res.status(400).json({ error: 'Missing refresh token.' });
      const mine = await memberships(user.id);
      if (!mine.length) return res.status(403).json({ error: 'This account isn’t a member of any BSMNT studio.' });
      const code = b64url(crypto.randomBytes(32));
      codes.set(code, {
        clientId: b.client_id, redirectUri: b.redirect_uri, challenge: b.code_challenge, exp: Date.now() + CODE_TTL_MS,
        session: { access_token: String(b.access_token), refresh_token: String(b.refresh_token), expires_in: Number(b.expires_in) || 3600 },
      });
      const u = new URL(b.redirect_uri);
      u.searchParams.set('code', code);
      if (b.state) u.searchParams.set('state', String(b.state));
      say('authorized ' + (user.email || user.id));
      res.json({ redirect: u.toString() });
    } catch (e) {
      say('authorize/complete failed: ' + e.message);
      res.status(500).json({ error: 'Could not finish connecting. Try again.' });
    }
  });

  app.post('/oauth/token', limitAuth, express.urlencoded({ extended: false }), async (req, res) => {
    if (!enabled) return off(res);
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    try {
      if (b.grant_type === 'authorization_code') {
        const c = codes.get(String(b.code || ''));
        codes.delete(String(b.code || ''));
        if (!c || c.exp < Date.now()) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired or already used' });
        if (b.client_id !== c.clientId) return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
        if (b.redirect_uri && b.redirect_uri !== c.redirectUri) return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        const verifier = String(b.code_verifier || '');
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid code_verifier' });
        const want = Buffer.from(b64url(crypto.createHash('sha256').update(verifier).digest()));
        const got = Buffer.from(String(c.challenge));
        if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return res.json({ access_token: c.session.access_token, token_type: 'Bearer', expires_in: c.session.expires_in, refresh_token: c.session.refresh_token, scope: 'bsmnt' });
      }
      if (b.grant_type === 'refresh_token') {
        if (!b.refresh_token) return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token required' });
        const r = await fetch(SUPA_URL.replace(/\/$/, '') + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON },
          body: JSON.stringify({ refresh_token: String(b.refresh_token) }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.access_token) return res.status(400).json({ error: 'invalid_grant', error_description: 'Session expired. Reconnect BSMNT in your AI app.' });
        return res.json({ access_token: j.access_token, token_type: 'Bearer', expires_in: j.expires_in || 3600, refresh_token: j.refresh_token, scope: 'bsmnt' });
      }
      return res.status(400).json({ error: 'unsupported_grant_type' });
    } catch (e) {
      say('token failed: ' + e.message);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ── PDF uploads (one-time links) ───────────────────────────────────────────
  const uploads = new Map(); // token -> { userId, agencyId, projectId, exp, name, bytes }
  const uploadBytesTotal = () => { let n = 0; for (const u of uploads.values()) n += u.bytes ? u.bytes.length : 0; return n; };
  setInterval(() => { const t = Date.now(); for (const [k, v] of uploads) if (v.exp < t) uploads.delete(k); }, 5 * 60 * 1000).unref();

  app.get('/mcp/upload/:token', limitUpload, (req, res) => {
    const u = uploads.get(req.params.token);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (!u || u.exp < Date.now()) return res.status(404).send(page('Link expired', '<p class="err">This upload link has expired. Ask your AI assistant for a new one.</p>'));
    res.send(page('Send a PDF to your AI assistant', uploadBody(u), { uploadUrl: baseUrl(req) + '/mcp/upload/' + req.params.token }));
  });
  const rawUpload = express.raw({ type: () => true, limit: UPLOAD_MAX_BYTES });
  let uploadsInFlight = 0;
  // Runs before the body is read: unknown/expired links and oversized or parallel floods are
  // refused without buffering anything.
  const preUpload = (req, res, next) => {
    const u = uploads.get(req.params.token);
    if (!u || u.exp < Date.now()) return res.status(404).json({ error: 'Upload link expired' });
    const len = Number(req.headers['content-length'] || 0);
    if (len > UPLOAD_MAX_BYTES) return res.status(413).json({ error: 'That file is over 60 MB' });
    if (uploadsInFlight >= 4) return res.status(503).json({ error: 'Busy · try again in a moment' });
    uploadsInFlight++;
    let done = false;
    const release = () => { if (!done) { done = true; uploadsInFlight--; } };
    res.on('finish', release); res.on('close', release);
    next();
  };
  const receiveUpload = (req, res) => {
    const u = uploads.get(req.params.token);
    if (!u || u.exp < Date.now()) return res.status(404).json({ error: 'Upload link expired' });
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || !buf.length) return res.status(400).json({ error: 'Empty upload' });
    if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return res.status(415).json({ error: 'That file isn’t a PDF' });
    if (uploadBytesTotal() + buf.length > UPLOAD_TOTAL_MAX) return res.status(507).json({ error: 'Server is busy, try again in a few minutes' });
    u.bytes = buf;
    u.name = str(req.headers['x-file-name'] ? decodeURIComponent(String(req.headers['x-file-name'])) : (u.name || 'upload.pdf'), 160);
    u.uploadedAt = nowIso();
    res.json({ ok: true, upload_id: req.params.token, bytes: buf.length, name: u.name });
  };
  app.put('/mcp/upload/:token', limitUpload, preUpload, rawUpload, receiveUpload);
  app.post('/mcp/upload/:token', limitUpload, preUpload, rawUpload, receiveUpload);

  // ── MCP endpoint ───────────────────────────────────────────────────────────
  async function mcpAuth(req, res, next) {
    if (!enabled) return off(res);
    const h = String(req.headers.authorization || '');
    const tok = (h.match(/^Bearer\s+(.+)$/i) || [])[1];
    const user = tok ? await userFromToken(tok.trim()).catch(() => null) : null;
    if (!user) {
      res.set('WWW-Authenticate', 'Bearer resource_metadata="' + baseUrl(req) + '/.well-known/oauth-protected-resource"');
      return res.status(401).json({ error: 'invalid_token', error_description: 'Sign in to BSMNT' });
    }
    req.authUser = user;
    next();
  }

  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST' }));
  app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Stateless server' }));
  app.post('/mcp', limitMcp, mcpAuth, async (req, res) => {
    const body = req.body;
    const batch = Array.isArray(body);
    if (batch && body.length > 10) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are limited to 10 messages' } });
    const msgs = batch ? body : [body];
    const out = [];
    for (const m of msgs) {
      if (m && m.jsonrpc === '2.0' && m.method === undefined && ('result' in m || 'error' in m)) continue; // a client response: nothing to answer
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
        out.push({ jsonrpc: '2.0', id: (m && m.id) ?? null, error: { code: -32600, message: 'Invalid Request' } });
        continue;
      }
      if (m.id === undefined || m.id === null) continue; // notification: no response
      try {
        out.push({ jsonrpc: '2.0', id: m.id, result: await rpc(m.method, m.params || {}, req) });
      } catch (e) {
        out.push({ jsonrpc: '2.0', id: m.id, error: { code: e.rpcCode || -32603, message: e.message || 'Internal error' } });
      }
    }
    if (!out.length) return res.status(202).end();
    res.json(batch ? out : out[0]);
  });

  async function rpc(method, params, req) {
    if (method === 'initialize') {
      const asked = params.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'bsmnt', title: 'BSMNT', version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) };
    if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) { const e = new Error('Unknown tool: ' + params.name); e.rpcCode = -32602; throw e; }
      try {
        const result = await tool.run(params.arguments || {}, { user: req.authUser, req });
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 1) }], structuredContent: typeof result === 'object' ? result : undefined };
      } catch (e) {
        if (!e.userFacing) say(params.name + ' failed: ' + (e.stack || e.message));
        return { content: [{ type: 'text', text: 'Error: ' + (e.userFacing ? e.message : 'Something went wrong in BSMNT (' + (e.message || 'unknown') + ').') }], isError: true };
      }
    }
    if (method === 'resources/list') return { resources: [] };
    if (method === 'prompts/list') return { prompts: [] };
    const e = new Error('Method not found: ' + method); e.rpcCode = -32601; throw e;
  }

  // ── studio data helpers ────────────────────────────────────────────────────
  const fail = (msg) => { const e = new Error(msg); e.userFacing = true; return e; };

  async function myStudios(user) {
    const mine = await memberships(user.id);
    if (!mine.length) throw fail('Your account isn’t a member of any BSMNT studio.');
    const ids = [...new Set(mine.map(m => String(m.agency_id)))];
    const agencies = await supaRest('GET', 'agencies', 'id=in.(' + ids.map(encodeURIComponent).join(',') + ')&select=id,name', null).catch(() => []);
    return mine.map(m => ({ agency_id: String(m.agency_id), studio: ((agencies || []).find(a => same(a.id, m.agency_id)) || {}).name || 'Studio', member_id: String(m.id), role: m.role }));
  }

  async function studio(ctx, agencyId) {
    const list = await myStudios(ctx.user);
    let s;
    if (agencyId) s = list.find(x => same(x.agency_id, agencyId));
    else if (list.length === 1) s = list[0];
    else throw fail('You’re in more than one studio. Call bsmnt_list_studios and pass agency_id. Studios: ' + list.map(x => x.studio + ' (' + x.agency_id + ')').join(', '));
    if (!s) throw fail('You’re not a member of that studio.');
    const rows = await supaRest('GET', 'agency_members', 'id=eq.' + encodeURIComponent(s.member_id) + '&select=id,name,role,color,can_manage_projects,can_edit_budgets,can_access_reports,active&limit=1', null);
    const me = (rows || [])[0] || {};
    const role = ['admin', 'manager'].includes(me.role) ? me.role : 'user';
    return {
      agencyId: s.agency_id, studioName: s.studio, memberId: String(me.id || s.member_id), memberName: me.name || 'AI assistant', memberColor: me.color || '#7c6fff',
      canManage: role === 'admin' || role === 'manager' || me.can_manage_projects === true,
      canBudget: role === 'admin' || me.can_edit_budgets === true,
      isAdmin: role === 'admin',
      canReports: role === 'admin' || me.can_access_reports === true,
    };
  }
  const needManage = (st) => { if (!st.canManage) throw fail('You need “manage projects” permission in ' + st.studioName + ' to do that.'); };

  async function readState(agencyId, cols) {
    const rows = await supaRest('GET', 'app_state', 'agency_id=eq.' + encodeURIComponent(agencyId) + '&select=' + cols + '&limit=1', null);
    const row = (rows || [])[0];
    if (!row) throw fail('Studio data not found.');
    return row;
  }

  const tombstoned = (row, kind) => new Set([...(row['deleted_' + kind] || []), ...(((row.brand || {})._deletedIds || {})[kind] || [])].map(String));
  function liveProjects(row, includeArchived) {
    const dead = tombstoned(row, 'projects');
    const a = (row.projects || []).filter(p => p && !p._shared && !dead.has(String(p.id))).map(p => ({ p, list: 'projects' }));
    const b = includeArchived ? (row.archived || []).filter(p => p && !dead.has(String(p.id))).map(p => ({ p, list: 'archived' })) : [];
    return a.concat(b);
  }
  // Reads accept an id, exact name or unique partial name; writes (exact=true) only an id or exact name.
  function findProject(row, ref, includeArchived, exact) {
    const all = liveProjects(row, includeArchived !== false);
    const r = String(ref || '').trim();
    if (!r) throw fail('project_id is required.');
    let hit = all.find(x => same(x.p.id, r));
    if (!hit) {
      const q = r.toLowerCase();
      const exactHits = all.filter(x => String(x.p.name || '').toLowerCase() === q);
      const part = exactHits.length || exact ? exactHits : all.filter(x => String(x.p.name || '').toLowerCase().includes(q));
      if (part.length === 1) hit = part[0];
      else if (part.length > 1) throw fail('More than one project matches “' + r + '”: ' + part.slice(0, 8).map(x => x.p.name + ' (' + x.p.id + ')').join(', ') + '. Pass the id.');
    }
    if (!hit) throw fail('No project matches “' + r + '”.');
    return hit;
  }
  const clientName = (row, id) => { const c = (row.clients || []).find(c => same(c.id, id)); return c ? c.name : ''; };

  async function writeProjects(st, cols, mutate) {
    const result = await casUpdateAppState(st.agencyId, cols, mutate, st.memberId);
    if (result.written) await broadcastStateUpdate(st.agencyId, st.memberId, { device_id: 'ai-connector', local_version: result.local_version });
    return result;
  }
  // Apply `edit(project)` to one project inside a CAS write. Returns the edited project.
  async function editProject(st, projectRef, edit) {
    let edited = null;
    await writeProjects(st, 'projects,archived,deleted_projects', (row) => {
      const hit = findProject(row, projectRef, true, true);
      const list = (row[hit.list] || []).slice();
      const i = list.findIndex(p => same(p.id, hit.p.id));
      const p = JSON.parse(JSON.stringify(list[i]));
      edit(p, row);
      list[i] = p;
      edited = p;
      return { [hit.list]: list };
    });
    return edited;
  }

  function projectActivity(st, kind, summary) {
    return { id: 'act' + Date.now() + rand36(3), ts: Date.now(), userId: st.memberId, userName: st.memberName, userColor: st.memberColor, kind, summary: summary + VIA, meta: null };
  }
  const pushActivity = (p, entry) => { p.activity = [entry].concat(Array.isArray(p.activity) ? p.activity : []).slice(0, 200); };

  function summary(row, p) {
    const shots = (p.shotList || []);
    return {
      id: p.id, name: p.name, client: clientName(row, p.clientId), status: p.status, phase: p.phase,
      start_date: p.startDate || '', delivery_date: p.endDate || '', shoot_start: p.shootStart || '', shoot_end: p.shootEnd || '',
      shots: shots.filter(s => !s.isScene).length, runsheet_slots: ((p.runsheet || {}).timeline || []).length,
    };
  }

  // ── storyboards table ──────────────────────────────────────────────────────
  async function loadStoryboard(agencyId, projectId) {
    const rows = await supaRest('GET', 'storyboards', 'agency_id=eq.' + encodeURIComponent(agencyId) + '&project_id=eq.' + encodeURIComponent(String(projectId)) + '&select=*&order=updated_at.desc&limit=1', null);
    return (rows || [])[0] || null;
  }
  async function saveStoryboard(agencyId, projectId, existing, fields) {
    const ts = nowIso();
    if (existing && existing.id != null) {
      await supaRest('PATCH', 'storyboards', 'id=eq.' + encodeURIComponent(existing.id), Object.assign({}, fields, { updated_at: ts }));
      return existing.id;
    }
    const out = await supaRest('POST', 'storyboards', null, Object.assign({ agency_id: agencyId, project_id: String(projectId), characters: [], scene: '', style: 'upload' }, fields, { created_at: ts, updated_at: ts }));
    return Array.isArray(out) && out[0] ? out[0].id : null;
  }

  async function storagePut(bucket, path, bytes, mime) {
    const r = await fetch(SUPA_URL.replace(/\/$/, '') + '/storage/v1/object/' + bucket + '/' + path.split('/').map(encodeURIComponent).join('/'), {
      method: 'POST', headers: { Authorization: 'Bearer ' + SUPA_KEY, apikey: SUPA_KEY, 'Content-Type': mime, 'Cache-Control': '31536000', 'x-upsert': 'false' }, body: bytes,
    });
    if (!r.ok) throw new Error('storage upload ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
    return SUPA_URL.replace(/\/$/, '') + '/storage/v1/object/public/' + bucket + '/' + path;
  }
  async function storageGet(bucket, path) {
    const r = await fetch(SUPA_URL.replace(/\/$/, '') + '/storage/v1/object/' + bucket + '/' + path.split('/').map(encodeURIComponent).join('/'), { headers: { Authorization: 'Bearer ' + SUPA_KEY, apikey: SUPA_KEY } });
    if (!r.ok) throw fail('Couldn’t download that document (' + r.status + ').');
    if (Number(r.headers.get('content-length') || 0) > UPLOAD_MAX_BYTES) throw fail('That document is over 60 MB.');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > UPLOAD_MAX_BYTES) throw fail('That document is over 60 MB.');
    return buf;
  }

  // ── studio-wide sections for bsmnt_read_studio_data ────────────────────────
  // Long data: URLs (logos, pasted images) would swamp the answer.
  function stripBlobs(v, depth) {
    depth = depth || 0;
    if (typeof v === 'string') return v.startsWith('data:') && v.length > 200 ? '[image]' : v;
    if (Array.isArray(v)) return depth > 12 ? '[…]' : v.map(x => stripBlobs(x, depth + 1));
    if (v && typeof v === 'object') { if (depth > 12) return '[…]'; const o = {}; for (const k of Object.keys(v)) o[k] = stripBlobs(v[k], depth + 1); return o; }
    return v;
  }
  async function teamOf(agencyId, withRates) {
    const cols = 'id,name,role,email,initials,color,active,can_manage_projects,can_edit_budgets,can_access_reports' + (withRates ? ',cost_rate,charge_rate,charge_rate_prep,charge_rate_shoot,charge_rate_edit' : '');
    return (await supaRest('GET', 'agency_members', 'agency_id=eq.' + encodeURIComponent(agencyId) + '&select=' + cols + '&order=name.asc', null)) || [];
  }
  async function checkMember(st, id) {
    const team = await teamOf(st.agencyId);
    const m = team.find(m => same(m.id, id) && m.active !== false);
    if (!m) throw fail('No active team member with id ' + id + '. Use bsmnt_read_studio_data section "team".');
    return String(m.id);
  }
  const stateCol = (col) => async (st) => (await readState(st.agencyId, col))[col];
  const brandKey = (key) => async (st) => ((await readState(st.agencyId, 'brand')).brand || {})[key];
  const table = (name, order) => async (st) => (await supaRest('GET', name, 'agency_id=eq.' + encodeURIComponent(st.agencyId) + '&select=*' + (order ? '&order=' + order : '') + '&limit=1000', null)) || [];
  const SECTIONS = {
    tasks: { load: stateCol('tasks') },
    clients: { load: async (st) => { const row = await readState(st.agencyId, 'clients,deleted_clients'); const dead = tombstoned(row, 'clients'); return (row.clients || []).filter(c => c && !dead.has(String(c.id))); } },
    team: { load: async (st) => teamOf(st.agencyId, st.isAdmin) },
    crew_directory: { load: stateCol('crew_directory') },
    retainers: { load: stateCol('retainers') },
    business_costs: { load: stateCol('business_costs'), admin: true },
    project_templates: { load: stateCol('templates') },
    task_templates: { load: stateCol('task_templates') },
    activity: { load: stateCol('activity') },
    whiteboard: { load: stateCol('wb_state') },
    quotes: { load: brandKey('_quotes') },
    equipment: { load: brandKey('_equipment_library') },
    prospects: { load: brandKey('_prospects') },
    contractors: { load: brandKey('_contractors') },
    decks: { load: brandKey('_decks') },
    work_library: { load: brandKey('_worklib') },
    data_library: { load: brandKey('_datalib') },
    client_briefs: { load: table('client_briefs', 'submitted_at.desc') },
    client_messages: { load: table('client_messages', 'created_at.desc') },
    flight_operations: { load: table('uas_operations') },
    flight_aircraft: { load: table('uas_aircraft') },
    flight_batteries: { load: table('uas_batteries') },
    flight_personnel: { load: table('uas_personnel') },
    flight_hazard_analyses: { load: table('uas_jha') },
    flight_records: { load: table('uas_flight_records') },
    flight_maintenance: { load: table('uas_maintenance') },
    flight_occurrences: { load: table('uas_occurrences') },
    flight_hazard_register: { load: table('uas_hazard_register') },
  };

  // ── tools ──────────────────────────────────────────────────────────────────
  const agencyProp = { agency_id: { type: 'string', description: 'Studio id. Only needed if you belong to more than one studio (see bsmnt_list_studios).' } };
  const projectProp = { project_id: { type: 'string', description: 'Project id (preferred) or exact/unique project name.' } };
  const RO = { readOnlyHint: true, openWorldHint: false };
  const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const RWX = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

  const TOOLS = [
    {
      name: 'bsmnt_list_studios', title: 'List studios', annotations: RO,
      description: 'List the BSMNT studios you belong to, with your role in each.',
      inputSchema: { type: 'object', properties: {} },
      async run(a, ctx) { return { studios: await myStudios(ctx.user) }; },
    },
    {
      name: 'bsmnt_list_clients', title: 'List clients', annotations: RO,
      description: 'List clients in the studio (id and name). Use before creating a project to reuse an existing client.',
      inputSchema: { type: 'object', properties: { ...agencyProp, query: { type: 'string', description: 'Optional name filter' } } },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        const row = await readState(st.agencyId, 'clients,deleted_clients');
        const dead = tombstoned(row, 'clients');
        const q = String(a.query || '').toLowerCase();
        return { studio: st.studioName, clients: (row.clients || []).filter(c => c && !dead.has(String(c.id)) && (!q || String(c.name || '').toLowerCase().includes(q))).map(c => ({ id: c.id, name: c.name })) };
      },
    },
    {
      name: 'bsmnt_list_projects', title: 'List projects', annotations: RO,
      description: 'List projects in the studio with status, client and key dates.',
      inputSchema: { type: 'object', properties: { ...agencyProp, query: { type: 'string', description: 'Optional name/client filter' }, include_archived: { type: 'boolean' } } },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        const row = await readState(st.agencyId, 'projects,archived,clients,deleted_projects');
        const q = String(a.query || '').toLowerCase();
        const list = liveProjects(row, !!a.include_archived).map(x => summary(row, x.p))
          .filter(s => !q || s.name.toLowerCase().includes(q) || s.client.toLowerCase().includes(q));
        return { studio: st.studioName, count: list.length, projects: list.slice(0, 200) };
      },
    },
    {
      name: 'bsmnt_get_project', title: 'Get project', annotations: RO,
      description: 'Full detail for one project: fields, shot list, run sheet and storyboard panels (text only).',
      inputSchema: { type: 'object', properties: { ...agencyProp, ...projectProp }, required: ['project_id'] },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        const row = await readState(st.agencyId, 'projects,archived,clients,deleted_projects');
        const { p } = findProject(row, a.project_id, true);
        const rs = p.runsheet || {};
        const sb = await loadStoryboard(st.agencyId, p.id).catch(() => null);
        const out = Object.assign(summary(row, p), {
          description: p.description || '', brief: p.brief || {}, team_notes: plain(p.teamNotes || ''), assigned_member_ids: p.assigned || [],
          stages: (p.stages || []).map(sg => ({ name: sg.name, tasks: (sg.tasks || []).map(t => ({ id: t.id, name: t.name, done: !!t.done, assignee: t.assignee || t.assignedTo || '', due_date: t.dueDate || '', notes: plain(t.notes || '') })) })),
          client_requests: (p.clientRequests || []).map(r => ({ id: r.id, text: r.text, done: !!r.done, assignee: r.assignee || '' })),
          hours_logged: Math.round((p.timeLog || []).reduce((s, e) => s + (Number(e.hours) || 0), 0) * 100) / 100,
          deliverables: p.deliverables || [], docs: (p.docs || []).map(d => ({ name: d.name, url: d.url })),
          budget: st.canBudget ? { total: p.budget || 0, shoot: p.shootBudget || 0, edit: p.editBudget || 0 } : 'hidden (no budget permission)',
          shot_list: (p.shotList || []).map(s => s.isScene ? { kind: s.isTitle ? 'title' : 'scene', desc: plain(s.desc) } : { kind: 'shot', id: s.id, desc: plain(s.desc), type: s.shotType || s.type || '', notes: plain(s.notes), done: !!s.done }),
          runsheet: { title: rs.title || '', location: rs.location || '', shoot_dates: rs.shootDates || '', notes: plain(rs.notes), crew: rs.crew || [],
            timeline: (rs.timeline || rs.rows || []).map(r => ({ day: r.day || 'Day 1', time: r.time || '', title: plain(r.location || r.desc), notes: plain(r.notes), crew: r.crew || '', place: r.place || '', duration_min: r.duration || null, done: !!r.done })) },
          storyboard: sb ? { title: sb.title, style: sb.style, panels: (sb.panels || []).map((x, i) => x.isScene ? { scene: x.sceneLabel || '' } : { n: i + 1, id: x.id, desc: x.desc, shot_type: x.shotType, camera_move: x.cameraMove, duration: x.duration, narration: x.narration, has_image: !!x.imageUrl }) } : null,
        });
        return out;
      },
    },
    {
      name: 'bsmnt_create_project', title: 'Create project', annotations: RW,
      description: 'Create a project. Reuses an existing client when client_name matches one (case-insensitive), otherwise creates the client. Budgets are numbers excluding GST. Dates are YYYY-MM-DD.',
      inputSchema: {
        type: 'object', required: ['name'],
        properties: {
          ...agencyProp,
          name: { type: 'string' },
          client_id: { type: 'string', description: 'Existing client id (from bsmnt_list_clients)' },
          client_name: { type: 'string', description: 'Client name; matched to an existing client or created' },
          status: { type: 'string', enum: Object.keys(STATUS_PHASE), description: 'Default upcoming' },
          start_date: { type: 'string' }, delivery_date: { type: 'string', description: 'Delivery due date' },
          shoot_start: { type: 'string' }, shoot_end: { type: 'string' },
          budget: { type: 'number' }, shoot_budget: { type: 'number' }, edit_budget: { type: 'number' },
          description: { type: 'string', description: 'Brief overview shown on the project' },
          brief: { type: 'object', properties: { mood: { type: 'string' }, tone: { type: 'string' }, refs: { type: 'string' }, formats: { type: 'string' } } },
          assigned_member_ids: { type: 'array', items: { type: 'string' } },
        },
      },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        needManage(st);
        const name = clean(a.name, 200).trim();
        if (!name) throw fail('name is required.');
        for (const k of ['start_date', 'delivery_date', 'shoot_start', 'shoot_end']) if (a[k] && !isDate(a[k])) throw fail(k + ' must be YYYY-MM-DD.');
        const status = STATUS_PHASE[a.status] ? a.status : 'upcoming';
        const ms = Date.now();
        let newClient = null, created = null, clientLabel = '';
        await writeProjects(st, 'projects,clients,activity,deleted_projects,deleted_clients', (row) => {
          newClient = null; created = null; clientLabel = '';
          const clients = (row.clients || []).slice();
          const deadC = tombstoned(row, 'clients');
          let clientId = null;
          if (a.client_id) {
            const c = clients.find(c => same(c.id, a.client_id) && !deadC.has(String(c.id)));
            if (!c) throw fail('client_id not found. Use bsmnt_list_clients.');
            clientId = c.id; clientLabel = c.name;
          } else if (a.client_name && String(a.client_name).trim()) {
            const nm = String(a.client_name).trim();
            const c = clients.find(c => !deadC.has(String(c.id)) && String(c.name || '').trim().toLowerCase() === nm.toLowerCase());
            if (c) { clientId = c.id; clientLabel = c.name; }
            else {
              newClient = { id: ms + 1, name: clean(nm, 120), contact: '', email: '', phone: '', logo: '' };
              clients.push(newClient); clientId = newClient.id; clientLabel = newClient.name;
            }
          }
          let id = ms;
          const used = new Set([...(row.projects || []), ...(row.archived || [])].map(p => String(p && p.id)));
          while (used.has(String(id))) id++;
          const shootStart = a.shoot_start || '', shootEnd = a.shoot_end || a.shoot_start || '';
          const p = {
            id, name, clientId, status, phase: STATUS_PHASE[status],
            budget: st.canBudget ? Number(a.budget) || 0 : 0, shootBudget: st.canBudget ? Number(a.shoot_budget) || 0 : 0, editBudget: st.canBudget ? Number(a.edit_budget) || 0 : 0,
            budgetSpent: { shoot: 0, edit: 0 }, hardCosts: [], budgetEntries: [],
            assigned: Array.isArray(a.assigned_member_ids) ? a.assigned_member_ids.map(String) : [],
            description: clean(a.description, 8000),
            stages: ['Pre-Production', 'Production', 'Post Production'].map((n, i) => ({ id: 's' + (i + 1), name: n, tasks: [] })),
            shotList: [], timeLog: [], deliverables: [],
            brief: { mood: clean((a.brief || {}).mood, 500), tone: clean((a.brief || {}).tone, 500), refs: clean((a.brief || {}).refs, 2000), formats: clean((a.brief || {}).formats, 500) },
            cover: '', startDate: a.start_date || '', endDate: a.delivery_date || '', shootStart, shootEnd,
            runsheet: { crew: [], timeline: [], equipment: [], notes: '', shotListOrdered: [], shootDates: shootRangeText(shootStart, shootEnd), location: '', jobType: '', days: [] },
          };
          pushActivity(p, projectActivity(st, 'project.create', 'created the project'));
          created = p;
          const activity = [{ icon: '📁', text: 'created project "' + name + '"' + VIA, user: st.memberName, time: nowIso(), read: false }].concat(row.activity || []).slice(0, 50);
          const patch = { projects: [p].concat(row.projects || []), activity };
          if (newClient) patch.clients = clients;
          return patch;
        });
        if (pushToAdmins) {
          setTimeout(() => {
            pushToAdmins(st.agencyId, 'pushAdminNewProject', 'New project: ' + name, st.memberName + ' added it' + VIA, { kind: 'admin_new_project', projectId: String(created.id) }, st.memberId)
              .catch(e => say('push failed: ' + e.message));
          }, 4000);
        }
        return { ok: true, project_id: created.id, name, client: clientLabel || null, client_created: !!newClient, status, budgets_set: st.canBudget, studio: st.studioName };
      },
    },
    {
      name: 'bsmnt_update_project', title: 'Update project', annotations: RW,
      description: 'Change project fields. Only the fields you pass are changed.',
      inputSchema: {
        type: 'object', required: ['project_id'],
        properties: {
          ...agencyProp, ...projectProp,
          name: { type: 'string' }, status: { type: 'string', enum: Object.keys(STATUS_PHASE) },
          client_id: { type: 'string' },
          start_date: { type: 'string' }, delivery_date: { type: 'string' }, shoot_start: { type: 'string' }, shoot_end: { type: 'string' },
          budget: { type: 'number' }, shoot_budget: { type: 'number' }, edit_budget: { type: 'number' },
          description: { type: 'string' }, team_notes: { type: 'string' },
          brief: { type: 'object', properties: { mood: { type: 'string' }, tone: { type: 'string' }, refs: { type: 'string' }, formats: { type: 'string' } } },
        },
      },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        needManage(st);
        for (const k of ['start_date', 'delivery_date', 'shoot_start', 'shoot_end']) if (a[k] && !isDate(a[k])) throw fail(k + ' must be YYYY-MM-DD.');
        if ((a.budget != null || a.shoot_budget != null || a.edit_budget != null) && !st.canBudget) throw fail('You don’t have budget permission in ' + st.studioName + '.');
        const changed = [];
        const p = await editProject(st, a.project_id, (p, row) => {
          changed.length = 0;
          if (a.name) { p.name = clean(a.name, 200); changed.push('name'); }
          if (a.status && STATUS_PHASE[a.status]) { p.status = a.status; p.phase = STATUS_PHASE[a.status]; changed.push('status'); }
          if (a.client_id) { if (!(row.clients || []).some(c => same(c.id, a.client_id))) throw fail('client_id not found.'); p.clientId = (row.clients.find(c => same(c.id, a.client_id))).id; changed.push('client'); }
          if (a.start_date != null) { p.startDate = a.start_date; changed.push('start_date'); }
          if (a.delivery_date != null) { p.endDate = a.delivery_date; changed.push('delivery_date'); }
          if (a.shoot_start != null || a.shoot_end != null) {
            p.shootStart = a.shoot_start != null ? a.shoot_start : (p.shootStart || '');
            p.shootEnd = a.shoot_end != null ? a.shoot_end : (p.shootEnd || p.shootStart || '');
            if (p.shootStart && p.shootEnd && p.shootEnd < p.shootStart) p.shootEnd = p.shootStart;
            p.runsheet = Object.assign({}, p.runsheet || {}, { shootDates: shootRangeText(p.shootStart, p.shootEnd) });
            changed.push('shoot_dates');
          }
          if (a.budget != null) { p.budget = Number(a.budget) || 0; changed.push('budget'); }
          if (a.shoot_budget != null) { p.shootBudget = Number(a.shoot_budget) || 0; changed.push('shoot_budget'); }
          if (a.edit_budget != null) { p.editBudget = Number(a.edit_budget) || 0; changed.push('edit_budget'); }
          if (a.description != null) { p.description = clean(a.description, 8000); changed.push('description'); }
          if (a.team_notes != null) { p.teamNotes = clean(a.team_notes, 8000); changed.push('team_notes'); }
          if (a.brief) { p.brief = Object.assign({}, p.brief || {}, Object.fromEntries(['mood', 'tone', 'refs', 'formats'].filter(k => a.brief[k] != null).map(k => [k, clean(a.brief[k], 2000)]))); changed.push('brief'); }
          if (changed.length) pushActivity(p, projectActivity(st, 'project.update', 'updated ' + changed.join(', ')));
        });
        return { ok: true, project_id: p.id, name: p.name, changed };
      },
    },
    {
      name: 'bsmnt_set_shot_list', title: 'Set shot list', annotations: RWX,
      description: 'Write the project shot list. Items are in display order. kind "scene" makes a scene divider (a real section, not a tickable shot); kind "title" makes a title card; kind "shot" is a shot. mode "replace" (default) replaces the whole list; "append" adds to the end.',
      inputSchema: {
        type: 'object', required: ['project_id', 'items'],
        properties: {
          ...agencyProp, ...projectProp,
          mode: { type: 'string', enum: ['replace', 'append'] },
          replace_captured: { type: 'boolean', description: 'Required to replace a list that already has shots ticked as captured' },
          items: { type: 'array', items: { type: 'object', required: ['desc'], properties: {
            kind: { type: 'string', enum: ['shot', 'scene', 'title'] }, desc: { type: 'string' },
            type: { type: 'string', description: 'Shot size, e.g. WS, MWS, MS, MCU, CU, ECU, Aerial, or free text like "Medium-wide"' },
            notes: { type: 'string' } } } },
        },
      },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        needManage(st);
        const items = Array.isArray(a.items) ? a.items.slice(0, 500) : [];
        if (!items.length) throw fail('items is empty.');
        const ms = Date.now();
        const built = items.map((it, i) => {
          const kind = it.kind || 'shot';
          if (kind === 'scene') return { id: 'sc' + ms.toString(36) + i + rand36(3), isScene: true, desc: clean(it.desc, 500), done: false, type: '' };
          if (kind === 'title') return { id: 'ti' + ms + i, isTitle: true, isScene: true, desc: clean(it.desc, 500), done: false, type: '' };
          const s = { id: 'sh' + (ms + i) + rand36(6), desc: clean(it.desc, 2000), type: clean(it.type, 40), done: false };
          if (it.notes) s.notes = clean(it.notes, 2000);
          return s;
        });
        const mode = a.mode === 'append' ? 'append' : 'replace';
        const p = await editProject(st, a.project_id, (p) => {
          const cur = Array.isArray(p.shotList) ? p.shotList : [];
          if (mode === 'replace' && cur.some(s => s && !s.isScene && s.done) && !a.replace_captured) throw fail('This shot list already has shots ticked as captured. Pass replace_captured: true to replace it anyway, or use mode "append".');
          p.shotList = mode === 'append' ? cur.concat(built) : built;
          pushActivity(p, projectActivity(st, 'shot.add', (mode === 'append' ? 'added ' : 'set the shot list to ') + built.filter(s => !s.isScene).length + ' shots'));
        });
        return { ok: true, project_id: p.id, mode, shots: p.shotList.filter(s => !s.isScene).length, scenes: p.shotList.filter(s => s.isScene).length };
      },
    },
    {
      name: 'bsmnt_set_runsheet', title: 'Set run sheet', annotations: RWX,
      description: 'Write the run sheet: header fields, crew contacts and the timeline. Only fields you pass change. timeline_mode "replace" (default) replaces the timeline; "append" adds rows. Each row: time like "7:30AM", title = what is happening, optional notes (plain text), crew, place, duration_min, day label (default "Day 1").',
      inputSchema: {
        type: 'object', required: ['project_id'],
        properties: {
          ...agencyProp, ...projectProp,
          title: { type: 'string', description: 'Run sheet title; blank uses the project name' },
          location: { type: 'string' }, job_type: { type: 'string' },
          notes: { type: 'string', description: 'General notes (plain text, newlines kept): call times, parking, safety, contacts' },
          include_health_safety: { type: 'boolean' },
          crew: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, name: { type: 'string' }, company: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } } } },
          crew_mode: { type: 'string', enum: ['replace', 'append'] },
          timeline: { type: 'array', items: { type: 'object', required: ['time', 'title'], properties: {
            day: { type: 'string' }, time: { type: 'string' }, title: { type: 'string' }, notes: { type: 'string' },
            crew: { type: 'string' }, place: { type: 'string' }, duration_min: { type: 'number' } } } },
          timeline_mode: { type: 'string', enum: ['replace', 'append'] },
        },
      },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        needManage(st);
        const ms = Date.now();
        const rows = Array.isArray(a.timeline) ? a.timeline.slice(0, 300).map((r, i) => {
          const hm = toHHmm(r.time);
          const row = { id: 'rsr' + (ms + i) + rand36(3), day: clean(r.day || 'Day 1', 80), time: clean(displayTime(r.time), 40), location: clean(r.title, 300), notes: richNotes(str(r.notes, 4000)), crew: clean(r.crew, 300), done: false };
          if (hm) row.timeStart = hm;
          if (r.place) row.place = clean(r.place, 300);
          if (r.duration_min != null && Number(r.duration_min) > 0) row.duration = Math.round(Number(r.duration_min));
          return row;
        }) : null;
        const p = await editProject(st, a.project_id, (p) => {
          const rs = Object.assign({ crew: [], timeline: [], equipment: [], notes: '', shotListOrdered: [], shootDates: shootRangeText(p.shootStart || '', p.shootEnd || ''), location: '', jobType: '', days: [] }, p.runsheet || {});
          if (a.title != null) rs.title = clean(a.title, 200);
          if (a.location != null) rs.location = clean(a.location, 300);
          if (a.job_type != null) rs.jobType = clean(a.job_type, 100);
          if (a.notes != null) rs.notes = richNotes(str(a.notes, 12000));
          if (a.include_health_safety != null) rs.includeHS = !!a.include_health_safety;
          if (Array.isArray(a.crew)) {
            const crew = a.crew.slice(0, 100).map(c => ({ role: clean(c.role, 80), name: clean(c.name, 120), company: clean(c.company, 120), phone: clean(c.phone, 60), email: clean(c.email, 160) }));
            rs.crew = a.crew_mode === 'append' ? (rs.crew || []).concat(crew) : crew;
          }
          if (rows) {
            const cur = Array.isArray(rs.timeline) ? rs.timeline : [];
            rs.timeline = a.timeline_mode === 'append' ? cur.concat(rows) : rows;
            pushActivity(p, projectActivity(st, 'rsRow.add', (a.timeline_mode === 'append' ? 'added ' : 'set the run sheet to ') + rows.length + ' slots'));
          }
          p.runsheet = rs;
        });
        const rs = p.runsheet || {};
        return { ok: true, project_id: p.id, timeline_slots: (rs.timeline || []).length, crew: (rs.crew || []).length, location: rs.location || '' };
      },
    },
    {
      name: 'bsmnt_set_storyboard', title: 'Set storyboard', annotations: RWX,
      description: 'Write the project storyboard (upload mode) in script order. Panels: desc, shot_type (ECU, CU, MCU, MS, MWS, WS, EWS, OTS, POV, Aerial), camera_move (static, pan-left, pan-right, tilt-up, tilt-down, dolly-in, dolly-out, handheld, crane, drone), duration in seconds, narration (VO/dialogue). A panel with scene_label instead of desc is a scene divider. Replacing keeps existing images by position unless keep_images is false. Add images afterwards with bsmnt_import_storyboard_images.',
      inputSchema: {
        type: 'object', required: ['project_id', 'panels'],
        properties: {
          ...agencyProp, ...projectProp,
          title: { type: 'string', description: 'Default "<project name> Storyboard"' },
          keep_images: { type: 'boolean', description: 'Default true' },
          send_to_runsheet: { type: 'boolean', description: 'Also show the panels on the run sheet (like “Send to Run Sheet”). Default false.' },
          panels: { type: 'array', items: { type: 'object', properties: {
            desc: { type: 'string' }, shot_type: { type: 'string' }, camera_move: { type: 'string' }, duration: { type: 'string' },
            narration: { type: 'string' }, image_url: { type: 'string', description: 'Optional public https image URL' },
            scene_label: { type: 'string' }, scene: { type: 'string', description: 'Scene description (scene dividers only)' } } } },
        },
      },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        needManage(st);
        const row = await readState(st.agencyId, 'projects,archived,deleted_projects');
        const { p } = findProject(row, a.project_id, true, true);
        const input = Array.isArray(a.panels) ? a.panels.slice(0, 200) : [];
        if (!input.length) throw fail('panels is empty.');
        const existing = await loadStoryboard(st.agencyId, p.id);
        const oldShots = ((existing && existing.panels) || []).filter(x => x && !x.isScene);
        const keep = a.keep_images !== false;
        const ms = Date.now();
        let shotIdx = 0;
        const panels = input.map((x, i) => {
          if (x.scene_label && !x.desc) return { id: ms + i, isScene: true, sceneLabel: clean(x.scene_label, 200), scene: clean(x.scene, 2000), sceneRefImageUrl: null, sceneGenerating: false, sceneCharacters: [] };
          const old = oldShots[shotIdx++];
          const img = (x.image_url && safeHttpsUrl(x.image_url)) || (keep && old && /^https?:\/\//.test(old.imageUrl || '') ? old.imageUrl : null);
          const dur = x.duration != null ? String(x.duration).replace(/[^\d.]/g, '') : '';
          return { id: ms + i, desc: clean(x.desc, 2000), shotType: normShotType(x.shot_type), cameraMove: normMove(x.camera_move), duration: dur.slice(0, 8), narration: clean(x.narration, 2000), imageUrl: img, generating: false };
        });
        const title = a.title ? clean(a.title, 200) : ((existing && existing.title) || (p.name + ' Storyboard'));
        await saveStoryboard(st.agencyId, p.id, existing, { title, panels, style: (existing && existing.style) || 'upload' });
        if (a.send_to_runsheet) await sendToRunsheet(st, p.id, panels, title);
        const shots = panels.filter(x => !x.isScene);
        return { ok: true, project_id: p.id, title, panels: shots.length, scenes: panels.length - shots.length, with_images: shots.filter(x => x.imageUrl).length, sent_to_runsheet: !!a.send_to_runsheet };
      },
    },
    {
      name: 'bsmnt_create_upload_link', title: 'Create PDF upload link', annotations: RW,
      description: 'Get a one-time link (2 hours) for sending a PDF (e.g. a storyboard) to BSMNT, because files in the chat can’t be passed to tools directly. If you have a shell with internet access, upload the file yourself: curl -sS -T "file.pdf" -H "X-File-Name: file.pdf" "<upload_url>". Otherwise give the user the link to open and drop the file. Then call bsmnt_import_storyboard_images with the upload_id.',
      inputSchema: { type: 'object', properties: { ...agencyProp, project_id: { type: 'string', description: 'Optional: the project the PDF is for' } } },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        let projectId = null;
        if (a.project_id) { const row = await readState(st.agencyId, 'projects,archived,deleted_projects'); projectId = findProject(row, a.project_id, true, true).p.id; }
        const token = b64url(crypto.randomBytes(18));
        uploads.set(token, { userId: ctx.user.id, agencyId: st.agencyId, projectId, exp: Date.now() + UPLOAD_TTL_MS, name: null, bytes: null });
        const url = baseUrl(ctx.req) + '/mcp/upload/' + token;
        return { upload_id: token, upload_url: url, expires_in_minutes: UPLOAD_TTL_MS / 60000 };
      },
    },
    {
      name: 'bsmnt_import_storyboard_images', title: 'Import storyboard frames from PDF', annotations: RWX,
      description: 'Pull the frame images out of a storyboard PDF and attach them to the project’s storyboard panels in order. Source: upload_id (from bsmnt_create_upload_link) or doc_id (a PDF already in the project’s Documents). Run with dry_run: true first: it lists every image found (page, slot = left-to-right/top-to-bottom position on the page, size) without changing anything. Then call again with frames: [{page, slot}, ...] in panel order (or omit frames to use the most common frame size, which usually skips covers, logos and photos). panel_numbers chooses which panels (1-based, counting shot panels only) get the frames; default is 1, 2, 3, ...',
      inputSchema: {
        type: 'object', required: ['project_id'],
        properties: {
          ...agencyProp, ...projectProp,
          upload_id: { type: 'string' }, doc_id: { type: 'string' },
          dry_run: { type: 'boolean' },
          frames: { type: 'array', items: { type: 'object', required: ['page', 'slot'], properties: { page: { type: 'number' }, slot: { type: 'number' } } } },
          panel_numbers: { type: 'array', items: { type: 'number' } },
          save_pdf_to_docs: { type: 'boolean', description: 'When the PDF came from an upload link, also add it to the project’s Documents. Default true.' },
        },
      },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        needManage(st);
        const row = await readState(st.agencyId, 'projects,archived,deleted_projects');
        const { p } = findProject(row, a.project_id, true, true);
        let pdf = null, pdfName = 'storyboard.pdf', fromUpload = null;
        if (a.upload_id) {
          const u = uploads.get(String(a.upload_id));
          if (!u || u.exp < Date.now()) throw fail('That upload link has expired. Create a new one.');
          if (!same(u.agencyId, st.agencyId) || !same(u.userId, ctx.user.id)) throw fail('That upload belongs to a different account or studio.');
          if (!u.bytes) throw fail('Nothing has been uploaded to that link yet.');
          pdf = u.bytes; pdfName = u.name || pdfName; fromUpload = u;
        } else if (a.doc_id) {
          const doc = (p.docs || []).find(d => same(d.id, a.doc_id));
          if (!doc || !doc.path) throw fail('No document with that id on this project.');
          const segs = String(doc.path).split('/');
          if (segs[0] !== String(st.agencyId) || segs.some(x => x === '' || x === '.' || x === '..' || x.includes('\\'))) throw fail('That document isn’t stored in this studio.');
          pdf = await storageGet('project-files', doc.path); pdfName = doc.name || pdfName;
        } else throw fail('Pass upload_id or doc_id.');

        let found;
        try { found = await extractFramesIsolated(pdf); } catch (e) { throw fail('Couldn’t read that PDF (' + e.message + ').'); }
        const listing = found.frames.map(f => ({ page: f.page, slot: f.slot, width: f.width, height: f.height, type: f.mime === 'image/png' ? 'png' : 'jpeg' }));
        const sizeKey = (f) => Math.round(f.width / 16) + 'x' + Math.round(f.height / 16);
        const counts = {}; found.frames.forEach(f => { counts[sizeKey(f)] = (counts[sizeKey(f)] || 0) + 1; });
        const dominant = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0];
        if (a.dry_run) {
          return { pdf_pages: found.pages, images_found: listing, most_common_size_count: dominant ? counts[dominant] : 0, skipped_images: found.skipped.length, next: 'Call again with frames: [{page, slot}, ...] in storyboard panel order.' };
        }
        let chosen;
        if (Array.isArray(a.frames) && a.frames.length) {
          chosen = a.frames.map((sel, i) => {
            const f = found.frames.find(f => f.page === Number(sel.page) && f.slot === Number(sel.slot));
            if (!f) throw fail('No image at page ' + sel.page + ' slot ' + sel.slot + ' (item ' + (i + 1) + '). Use dry_run to list them.');
            return f;
          });
        } else {
          chosen = found.frames.filter(f => sizeKey(f) === dominant);
        }
        if (!chosen.length) throw fail('No frames found in that PDF.');

        const sb = await loadStoryboard(st.agencyId, p.id);
        if (!sb || !(sb.panels || []).some(x => x && !x.isScene)) throw fail('This project has no storyboard panels yet. Call bsmnt_set_storyboard first.');
        const shotPanels = sb.panels.filter(x => x && !x.isScene);
        const wanted = Array.isArray(a.panel_numbers) && a.panel_numbers.length ? a.panel_numbers.length : shotPanels.length;
        if (!(Array.isArray(a.frames) && a.frames.length) && chosen.length !== wanted) {
          throw fail('Auto-pick found ' + chosen.length + ' same-size images but there are ' + wanted + ' panels to fill, so it could pick the wrong ones. Run with dry_run: true and pass frames: [{page, slot}, ...] in panel order.');
        }
        const targets = (Array.isArray(a.panel_numbers) && a.panel_numbers.length ? a.panel_numbers.map(Number) : chosen.map((_, i) => i + 1)).slice(0, chosen.length);
        for (const n of targets) if (!(n >= 1 && n <= shotPanels.length)) throw fail('panel number ' + n + ' is out of range (1-' + shotPanels.length + ').');

        const assigned = [];
        const sbKey = sb.id != null ? String(sb.id) : 'sb_' + Date.now();
        for (let i = 0; i < targets.length; i++) {
          const f = chosen[i];
          const ext = f.mime === 'image/png' ? 'png' : 'jpg';
          const path = st.agencyId + '/' + sbKey + '_panel' + targets[i] + '_' + Date.now() + rand36(4) + '.' + ext;
          const url = await storagePut('storyboard-images', path, f.bytes, f.mime);
          assigned.push({ panel: targets[i], panel_id: shotPanels[targets[i] - 1].id, page: f.page, slot: f.slot, url });
        }
        // Re-read and patch only imageUrl by panel id (someone may have edited text meanwhile).
        const fresh = await loadStoryboard(st.agencyId, p.id) || sb;
        const byId = new Map(assigned.map(x => [String(x.panel_id), x.url]));
        const panels = (fresh.panels || []).map(x => (x && byId.has(String(x.id)) ? Object.assign({}, x, { imageUrl: byId.get(String(x.id)) }) : x));
        await saveStoryboard(st.agencyId, p.id, fresh, { panels });
        // Panels already sent to the run sheet: update their images too.
        const rsIds = new Set(((p.runsheet || {}).sbPanels || []).map(x => String(x.id)));
        if ([...byId.keys()].some(id => rsIds.has(id))) {
          await editProject(st, p.id, (pp) => {
            pp.runsheet = Object.assign({}, pp.runsheet || {});
            pp.runsheet.sbPanels = (pp.runsheet.sbPanels || []).map(x => (byId.has(String(x.id)) ? Object.assign({}, x, { imageUrl: byId.get(String(x.id)) }) : x));
          });
        }
        let savedDoc = null;
        if (fromUpload && a.save_pdf_to_docs !== false && !fromUpload.savedDocId) {
          savedDoc = await saveDoc(st, p.id, pdf, pdfName).catch(e => { say('save doc failed: ' + e.message); return null; });
          if (savedDoc) fromUpload.savedDocId = savedDoc.id;
        }
        return { ok: true, project_id: p.id, attached: assigned.map(x => ({ panel: x.panel, page: x.page, slot: x.slot })), frames_in_pdf: found.frames.length, unmatched_panels: shotPanels.length - assigned.length, pdf_saved_to_docs: savedDoc ? savedDoc.name : false };
      },
    },
    // ── everything else: read any studio section; add/edit tasks, time, clients, requests ──
    {
      name: 'bsmnt_read_studio_data', title: 'Read studio data', annotations: RO,
      description: 'Read one section of the studio\'s data as JSON. Sections: ' + Object.keys(SECTIONS).join(', ') +
        '. Large lists are paged with offset/limit (default 100). Images are replaced with "[image]". Team rates and business costs are admin-only.',
      inputSchema: {
        type: 'object', required: ['section'],
        properties: {
          ...agencyProp,
          section: { type: 'string', enum: Object.keys(SECTIONS) },
          query: { type: 'string', description: 'Optional text filter (matches anywhere in an item)' },
          offset: { type: 'number' }, limit: { type: 'number', description: '1-200, default 100' },
        },
      },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        const sec = SECTIONS[a.section];
        if (!sec) throw fail('Unknown section. Use one of: ' + Object.keys(SECTIONS).join(', '));
        if (sec.admin && !st.isAdmin) throw fail('Only studio admins can read ' + a.section + '.');
        let items = await sec.load(st);
        if (!Array.isArray(items)) items = items == null ? [] : [items];
        const q = String(a.query || '').toLowerCase().trim();
        if (q) items = items.filter(x => JSON.stringify(x).toLowerCase().includes(q));
        const offset = Math.max(0, Math.floor(Number(a.offset) || 0));
        const limit = Math.min(200, Math.max(1, Math.floor(Number(a.limit) || 100)));
        return { studio: st.studioName, section: a.section, total: items.length, offset, returned: Math.min(limit, Math.max(0, items.length - offset)),
          items: items.slice(offset, offset + limit).map(stripBlobs) };
      },
    },
    {
      name: 'bsmnt_get_time_logs', title: 'Get time logs', annotations: RO,
      description: 'Time entries across all projects (and loose tasks) with totals by person and project. Without reports permission you only see your own time. Dates YYYY-MM-DD.',
      inputSchema: { type: 'object', properties: { ...agencyProp, from: { type: 'string' }, to: { type: 'string' }, member_id: { type: 'string' }, project_id: { type: 'string', description: 'Project id or name' } } },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        for (const k of ['from', 'to']) if (a[k] && !isDate(a[k])) throw fail(k + ' must be YYYY-MM-DD.');
        const row = await readState(st.agencyId, 'projects,archived,tasks,clients,deleted_projects,brand');
        const team = await teamOf(st.agencyId);
        const dead = new Set((((row.brand || {})._deletedIds || {}).timeLogs || []).map(String));
        const who = st.canReports ? (a.member_id ? String(a.member_id) : null) : st.memberId;
        const onlyProject = a.project_id ? String(findProject(row, a.project_id, true).p.id) : null;
        const out = [];
        const take = (e, extra) => {
          if (!e || dead.has(String(e.id))) return;
          if (who && !same(e.user, who)) return;
          if (a.from && String(e.date || '') < a.from) return;
          if (a.to && String(e.date || '') > a.to) return;
          out.push(Object.assign({ id: e.id, date: e.date || '', hours: Number(e.hours) || 0, member_id: e.user, member: (team.find(m => same(m.id, e.user)) || {}).name || '', phase: e.phase || '', notes: plain(e.notes || '') }, extra));
        };
        for (const { p } of liveProjects(row, true)) {
          if (onlyProject && !same(p.id, onlyProject)) continue;
          for (const e of p.timeLog || []) take(e, { project_id: p.id, project: p.name, client: clientName(row, p.clientId) });
        }
        if (!onlyProject) for (const t of row.tasks || []) for (const e of (t && t.timeLog) || []) take(e, { task_id: t.id, task: t.name });
        out.sort((x, y) => String(y.date).localeCompare(String(x.date)));
        const sum = (key) => Object.entries(out.reduce((m, e) => { const k = e[key] || '(none)'; m[k] = (m[k] || 0) + e.hours; return m; }, {})).map(([k, h]) => ({ [key]: k, hours: Math.round(h * 100) / 100 })).sort((x, y) => y.hours - x.hours);
        return { studio: st.studioName, scope: who ? 'one person' : 'everyone', entries: out.length, total_hours: Math.round(out.reduce((s, e) => s + e.hours, 0) * 100) / 100,
          by_member: sum('member'), by_project: sum('project'), items: out.slice(0, 500) };
      },
    },
    {
      name: 'bsmnt_add_task', title: 'Add task', annotations: RW,
      description: 'Add a task. With project_id it goes into that project\'s stage (stage name, default the first stage); without, it is a loose studio task (whiteboard / dashboard).',
      inputSchema: {
        type: 'object', required: ['name'],
        properties: { ...agencyProp, project_id: { type: 'string', description: 'Optional project id or exact name' }, stage: { type: 'string', description: 'e.g. Pre-Production, Production, Post Production' },
          name: { type: 'string' }, assignee_member_id: { type: 'string' }, due_date: { type: 'string' }, notes: { type: 'string' } },
      },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        const name = clean(a.name, 300).trim();
        if (!name) throw fail('name is required.');
        if (a.due_date && !isDate(a.due_date)) throw fail('due_date must be YYYY-MM-DD.');
        const assignee = a.assignee_member_id ? await checkMember(st, a.assignee_member_id) : null;
        if (a.project_id) {
          needManage(st);
          let id = null, stageName = '';
          const p = await editProject(st, a.project_id, (p) => {
            const stages = Array.isArray(p.stages) && p.stages.length ? p.stages : [{ id: 's1', name: 'Pre-Production', tasks: [] }];
            const want = String(a.stage || '').trim().toLowerCase();
            let sIdx = want ? stages.findIndex(s => String(s.name || '').toLowerCase() === want) : 0;
            if (sIdx < 0) sIdx = stages.findIndex(s => String(s.name || '').toLowerCase().includes(want));
            if (sIdx < 0) throw fail('No stage “' + a.stage + '”. Stages: ' + stages.map(s => s.name).join(', '));
            id = 't' + Date.now() + rand36(3);
            const task = { id, name, done: false, assignee: assignee || '', assignedTo: assignee || '', dueDate: a.due_date || '', notes: clean(a.notes, 4000) };
            stages[sIdx] = Object.assign({}, stages[sIdx], { tasks: (stages[sIdx].tasks || []).concat([task]) });
            stageName = stages[sIdx].name;
            p.stages = stages;
            pushActivity(p, projectActivity(st, 'task.add', 'added task “' + name + '”'));
          });
          return { ok: true, task_id: id, project_id: p.id, project: p.name, stage: stageName };
        }
        const id = 'task-' + Date.now();
        await writeProjects(st, 'tasks', (row) => ({ tasks: (row.tasks || []).concat([{ id, name, desc: clean(a.notes, 4000), dueDate: a.due_date || '', userId: assignee, done: false, timeLog: [], notes: [], social: false, hold: false, createdAt: nowIso(), dependsOn: [] }]) }));
        return { ok: true, task_id: id, loose_task: true };
      },
    },
    {
      name: 'bsmnt_update_task', title: 'Update task', annotations: RW,
      description: 'Edit a task: tick it done or not, rename, reassign, change due date or notes. Pass project_id for a project task; leave it out for a loose studio task.',
      inputSchema: {
        type: 'object', required: ['task_id'],
        properties: { ...agencyProp, task_id: { type: 'string' }, project_id: { type: 'string' }, name: { type: 'string' }, done: { type: 'boolean' },
          assignee_member_id: { type: 'string', description: 'Member id, or "" to unassign' }, due_date: { type: 'string' }, notes: { type: 'string' } },
      },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        if (a.due_date && !isDate(a.due_date)) throw fail('due_date must be YYYY-MM-DD.');
        const assignee = a.assignee_member_id ? await checkMember(st, a.assignee_member_id) : (a.assignee_member_id === '' ? '' : undefined);
        const apply = (t, loose) => {
          if (a.name) t.name = clean(a.name, 300);
          if (a.done != null) t.done = !!a.done;
          if (assignee !== undefined) { if (loose) t.userId = assignee || null; else { t.assignee = assignee; t.assignedTo = assignee; } }
          if (a.due_date != null) t.dueDate = a.due_date;
          if (a.notes != null) { if (loose) t.desc = clean(a.notes, 4000); else t.notes = clean(a.notes, 4000); }
        };
        if (a.project_id) {
          let found = null;
          const p = await editProject(st, a.project_id, (p) => {
            found = null;
            p.stages = (p.stages || []).map(s => Object.assign({}, s, { tasks: (s.tasks || []).map(t => { if (!same(t.id, a.task_id)) return t; const c = Object.assign({}, t); apply(c, false); found = c; return c; }) }));
            if (!found) throw fail('No task ' + a.task_id + ' in that project.');
            pushActivity(p, projectActivity(st, 'task.update', (a.done === true ? 'completed' : 'updated') + ' task “' + found.name + '”'));
          });
          return { ok: true, task_id: found.id, project: p.name, done: !!found.done };
        }
        let found = null;
        await writeProjects(st, 'tasks', (row) => {
          found = null;
          const tasks = (row.tasks || []).map(t => { if (!t || !same(t.id, a.task_id)) return t; const c = Object.assign({}, t); apply(c, true); found = c; return c; });
          if (!found) throw fail('No loose task ' + a.task_id + '. For a project task pass project_id.');
          return { tasks };
        });
        return { ok: true, task_id: found.id, done: !!found.done };
      },
    },
    {
      name: 'bsmnt_log_time', title: 'Log time', annotations: RW,
      description: 'Add a time entry to a project. Defaults to you; logging for someone else needs admin. phase is a stage name (e.g. Production) or General.',
      inputSchema: {
        type: 'object', required: ['project_id', 'hours', 'date'],
        properties: { ...agencyProp, ...projectProp, hours: { type: 'number' }, date: { type: 'string' }, member_id: { type: 'string' }, phase: { type: 'string' }, notes: { type: 'string' } },
      },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        const hours = Math.round((Number(a.hours) || 0) * 100) / 100;
        if (!(hours > 0 && hours <= 24)) throw fail('hours must be between 0 and 24.');
        if (!isDate(a.date)) throw fail('date must be YYYY-MM-DD.');
        let user = st.memberId;
        if (a.member_id && !same(a.member_id, st.memberId)) {
          if (!st.isAdmin) throw fail('Only admins can log time for someone else.');
          user = await checkMember(st, a.member_id);
        }
        const entry = { id: 'tl' + Date.now().toString(36) + rand36(5), user, phase: clean(a.phase || 'General', 80), hours, date: a.date };
        if (a.notes) entry.notes = clean(a.notes, 1000);
        const p = await editProject(st, a.project_id, (p) => {
          p.timeLog = (Array.isArray(p.timeLog) ? p.timeLog : []).concat([entry]);
          pushActivity(p, projectActivity(st, 'time.add', 'logged ' + hours + 'h'));
        });
        return { ok: true, entry_id: entry.id, project: p.name, hours, date: a.date };
      },
    },
    {
      name: 'bsmnt_save_client', title: 'Create or update client', annotations: RW,
      description: 'Create a client, or update one when client_id is given. Only the fields you pass change.',
      inputSchema: { type: 'object', properties: { ...agencyProp, client_id: { type: 'string' }, name: { type: 'string' }, contact: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, notes: { type: 'string' } } },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        needManage(st);
        let saved = null, created = false;
        await writeProjects(st, 'clients,deleted_clients', (row) => {
          const clients = (row.clients || []).slice();
          const dead = tombstoned(row, 'clients');
          const fields = {};
          for (const k of ['name', 'contact', 'email', 'phone', 'notes']) if (a[k] != null) fields[k] = clean(a[k], k === 'notes' ? 4000 : 200);
          if (a.client_id) {
            const i = clients.findIndex(c => c && same(c.id, a.client_id) && !dead.has(String(c.id)));
            if (i < 0) throw fail('client_id not found. Use bsmnt_list_clients.');
            clients[i] = Object.assign({}, clients[i], fields); saved = clients[i]; created = false;
          } else {
            const nm = String(fields.name || '').trim();
            if (!nm) throw fail('name is required for a new client.');
            const dup = clients.find(c => c && !dead.has(String(c.id)) && String(c.name || '').trim().toLowerCase() === nm.toLowerCase());
            if (dup) throw fail('A client called “' + dup.name + '” already exists (id ' + dup.id + '). Pass client_id to update it.');
            saved = Object.assign({ id: Date.now(), name: nm, contact: '', email: '', phone: '', logo: '' }, fields); clients.push(saved); created = true;
          }
          return { clients };
        });
        return { ok: true, client_id: saved.id, name: saved.name, created };
      },
    },
    {
      name: 'bsmnt_add_client_request', title: 'Add client request', annotations: RW,
      description: 'Add a client request to a project (“Client has asked for…”), optionally assigned to a team member. Shows on the project and its dashboard tile.',
      inputSchema: { type: 'object', required: ['project_id', 'text'], properties: { ...agencyProp, ...projectProp, text: { type: 'string' }, assignee_member_id: { type: 'string' } } },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        const text = clean(a.text, 1000).trim();
        if (!text) throw fail('text is required.');
        const assignee = a.assignee_member_id ? await checkMember(st, a.assignee_member_id) : null;
        const rq = { id: 'rq' + Date.now() + rand36(4), text, done: false, assignee, createdAt: nowIso(), createdBy: st.memberId };
        const p = await editProject(st, a.project_id, (p) => {
          p.clientRequests = (Array.isArray(p.clientRequests) ? p.clientRequests : []).concat([rq]);
          pushActivity(p, projectActivity(st, 'request.add', 'added client request “' + text.slice(0, 60) + '”'));
        });
        return { ok: true, request_id: rq.id, project: p.name };
      },
    },
    {
      name: 'bsmnt_set_client_request_done', title: 'Tick client request', annotations: RW,
      description: 'Mark a project\'s client request done or not done (ids from bsmnt_get_project → client_requests).',
      inputSchema: { type: 'object', required: ['project_id', 'request_id', 'done'], properties: { ...agencyProp, ...projectProp, request_id: { type: 'string' }, done: { type: 'boolean' } } },
      async run(a, ctx) {
        const st = await studio(ctx, a.agency_id);
        let hit = null;
        const p = await editProject(st, a.project_id, (p) => {
          hit = null;
          p.clientRequests = (p.clientRequests || []).map(r => { if (!r || !same(r.id, a.request_id)) return r; hit = Object.assign({}, r, { done: !!a.done, doneAt: a.done ? nowIso() : null, doneBy: a.done ? st.memberId : null }); return hit; });
          if (!hit) throw fail('No request ' + a.request_id + ' on that project.');
        });
        return { ok: true, request_id: hit.id, done: hit.done, project: p.name };
      },
    },
  ];

  async function sendToRunsheet(st, projectId, panels, title) {
    await editProject(st, projectId, (p) => {
      const rs = Object.assign({}, p.runsheet || {});
      const oldById = new Map(((rs.sbPanels || [])).map(x => [String(x.id), x]));
      rs.sbPanels = panels.filter(x => !x.isScene && x.desc).map(x => {
        const o = { id: x.id, desc: x.desc, shotType: x.shotType, cameraMove: x.cameraMove, duration: x.duration, narration: x.narration, imageUrl: /^https?:\/\//.test(x.imageUrl || '') ? x.imageUrl : null };
        const old = oldById.get(String(x.id));
        if (old && Array.isArray(old.comments)) o.comments = old.comments;
        return o;
      });
      rs.sbTitle = title || 'Storyboard';
      p.runsheet = rs;
    });
  }

  async function saveDoc(st, projectId, bytes, name) {
    const safe = String(name || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_') || 'document.pdf';
    const path = st.agencyId + '/' + projectId + '/docs/' + Date.now() + '_' + rand36(5) + '_' + safe;
    const url = await storagePut('project-files', path, bytes, 'application/pdf');
    const doc = { id: 'doc_' + Date.now() + '_' + rand36(4), name: clean(name, 160), url, path, size: bytes.length, uploadedAt: nowIso(), uploadedBy: st.memberId, uploadedByName: st.memberName };
    await editProject(st, projectId, (p) => {
      p.docs = (Array.isArray(p.docs) ? p.docs : []).concat([doc]);
      pushActivity(p, projectActivity(st, 'doc.add', 'added ' + doc.name));
    });
    return doc;
  }

  // ── HTML pages (sign-in + upload) ──────────────────────────────────────────
  function page(title, bodyHtml, cfg) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(title) + ' · BSMNT</title><style>' + CSS + '</style></head><body><main class="card">' +
      '<div class="brand"><span class="logo"></span>BSMNT</div><h1>' + esc(title) + '</h1>' + bodyHtml + '</main>' +
      (cfg ? '<script>window.BSMNT_CFG=' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';</script>' : '') +
      (cfg && cfg.anonKey ? '<script src="' + SUPABASE_JS + '"></script><script>' + LOGIN_JS + '</script>' : '') +
      (cfg && cfg.uploadUrl ? '<script>' + UPLOAD_JS + '</script>' : '') +
      '</body></html>';
  }
  function loginBody() {
    return '<p class="sub">Your AI assistant (Claude or Grok) will be able to read everything in your studios that you can see, including budgets and rates if you’re an admin, and create or edit projects, tasks, time, clients and requests. It can’t delete anything. Disconnect any time in the assistant’s connector settings.</p>' +
      '<button id="google" class="btn ghost" type="button">Continue with Google</button><div class="or">or</div>' +
      '<form id="pw"><label>Email<input id="email" type="email" autocomplete="email" required></label>' +
      '<label>Password<input id="password" type="password" autocomplete="current-password" required></label>' +
      '<button class="btn" type="submit">Sign in and connect</button></form><p id="msg" class="msg" role="status"></p>';
  }
  function uploadBody(u) {
    return '<p class="sub">Drop the PDF here. When it says “Sent”, go back to your AI assistant and say it’s uploaded.</p>' +
      '<label id="drop" class="drop"><input id="file" type="file" accept="application/pdf"><span id="dropText">Drop a PDF or click to choose</span></label>' +
      '<p id="msg" class="msg" role="status">' + (u.bytes ? 'A file is already here: ' + esc(u.name || 'PDF') + '. Dropping another replaces it.' : '') + '</p>';
  }

  return { tools: TOOLS, enabled };
};

const INSTRUCTIONS = [
  'BSMNT is a production management app for video studios. Use these tools to set up and update projects instead of asking the user to type into the app.',
  'Typical job: the user shares a runsheet / call sheet and a storyboard / script PDF and asks you to set up the project.',
  '1. Read the PDFs yourself. Check bsmnt_list_clients so you reuse an existing client.',
  '2. bsmnt_create_project with name, client, status (preproduction for an upcoming shoot), shoot dates, budgets (numbers excluding GST) and a short description.',
  '3. bsmnt_set_shot_list: one item per shot in the order they will be filmed on the day (group with kind "scene" dividers named after each shoot block and time), or script order when there is no runsheet.',
  '4. bsmnt_set_runsheet: location, notes (parking, call times, outfits, every contact with phone and call time), crew, and one timeline row per block.',
  '5. bsmnt_set_storyboard: panels in script order with shot_type, camera_move, duration, narration.',
  '6. Images: bsmnt_create_upload_link, upload the PDF (yourself with curl if you have a shell, otherwise give the user the link), bsmnt_import_storyboard_images with dry_run: true, then again with frames [{page, slot}] matching the panels.',
  'In text you write into BSMNT, use a middle dot (·) as a separator, never an em dash. Keep descriptions short and practical for a crew on set.',
  'Ask before replacing a shot list, run sheet or storyboard that already has content the user did not give you.',
  'Everything else (tasks, time, team, quotes, equipment, crew, briefs, client messages, flight ops, etc.): bsmnt_read_studio_data with a section; time sheets: bsmnt_get_time_logs.',
  'You can add and edit tasks, time entries, clients and client requests. Nothing can be deleted through these tools: tell the user to delete in the app.',
].join('\n');

const CSS = [
  ':root{color-scheme:dark;--bg:#0f0d0c;--card:#1a1716;--line:#2c2725;--text:#f4efe9;--muted:#a59c94;--accent:#ff6a3d}',
  '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(120% 80% at 50% 0%,#3a1a10 0%,var(--bg) 60%);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;padding:16px}',
  '.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px}',
  '.brand{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:.18em;font-size:12px;color:var(--muted)}',
  '.logo{width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,#7c6fff,#4b3bd6)}',
  'h1{font-size:22px;margin:14px 0 6px}.sub{color:var(--muted);margin:0 0 20px}',
  'label{display:block;font-size:12px;color:var(--muted);margin-bottom:12px}input[type=email],input[type=password]{display:block;width:100%;margin-top:6px;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:#120f0e;color:var(--text);font:inherit}',
  '.btn{display:block;width:100%;padding:12px;border:0;border-radius:10px;background:var(--accent);color:#fff;font:600 15px/1 inherit;cursor:pointer;font-family:inherit}',
  '.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}.btn:disabled{opacity:.5;cursor:default}',
  '.or{text-align:center;color:var(--muted);font-size:12px;margin:14px 0}.msg{min-height:1.5em;margin:14px 0 0;color:var(--muted)}.msg.ok{color:#5fd38d}.err,.msg.err{color:#ff8a7a}',
  '.drop{display:grid;place-items:center;height:160px;border:1.5px dashed var(--line);border-radius:14px;color:var(--muted);cursor:pointer;text-align:center;padding:12px}.drop.on{border-color:var(--accent);color:var(--text)}.drop input{display:none}',
].join('');

// Runs in the browser. Signs in with Supabase (email/password or Google), then hands the
// session to /oauth/authorize/complete and follows the redirect back to Claude.
const LOGIN_JS = `(function(){
var C=window.BSMNT_CFG,msg=document.getElementById('msg');
function say(t,cls){msg.textContent=t;msg.className='msg '+(cls||'');}
var sb=window.supabase.createClient(C.supabaseUrl,C.anonKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:true,flowType:'implicit'}});
var done=false;
function finish(s){
  if(done||!s)return;done=true;say('Connecting…');
  fetch(C.completeUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({},C.params,{access_token:s.access_token,refresh_token:s.refresh_token,expires_in:s.expires_in}))})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
  .then(function(x){if(x.ok&&x.j.redirect){say('Connected · returning to your AI app','ok');location.replace(x.j.redirect);}else{done=false;say(x.j.error||'Could not connect','err');}})
  .catch(function(){done=false;say('Network error · try again','err');});
}
sb.auth.onAuthStateChange(function(ev,s){if(s&&(ev==='SIGNED_IN'||ev==='INITIAL_SESSION'))finish(s);});
sb.auth.getSession().then(function(r){if(r.data&&r.data.session)finish(r.data.session);});
document.getElementById('pw').addEventListener('submit',function(e){
  e.preventDefault();say('Signing in…');
  sb.auth.signInWithPassword({email:document.getElementById('email').value.trim(),password:document.getElementById('password').value})
  .then(function(r){if(r.error)say(r.error.message,'err');else finish(r.data.session);});
});
document.getElementById('google').addEventListener('click',function(){
  sb.auth.signInWithOAuth({provider:'google',options:{redirectTo:C.selfUrl}}).then(function(r){if(r.error)say(r.error.message,'err');});
});
})();`;

const UPLOAD_JS = `(function(){
var C=window.BSMNT_CFG,msg=document.getElementById('msg'),drop=document.getElementById('drop'),input=document.getElementById('file'),txt=document.getElementById('dropText');
function say(t,cls){msg.textContent=t;msg.className='msg '+(cls||'');}
function send(f){
  if(!f)return;if(f.type&&f.type!=='application/pdf'){say('That isn’t a PDF','err');return;}
  txt.textContent=f.name;say('Uploading…');
  fetch(C.uploadUrl,{method:'PUT',headers:{'Content-Type':'application/pdf','X-File-Name':encodeURIComponent(f.name)},body:f})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
  .then(function(x){if(x.ok)say('Sent · '+f.name+' · go back to your AI assistant','ok');else say(x.j.error||'Upload failed','err');})
  .catch(function(){say('Network error · try again','err');});
}
input.addEventListener('change',function(){send(input.files[0]);});
['dragenter','dragover'].forEach(function(t){drop.addEventListener(t,function(e){e.preventDefault();drop.classList.add('on');});});
['dragleave','drop'].forEach(function(t){drop.addEventListener(t,function(e){e.preventDefault();drop.classList.remove('on');});});
drop.addEventListener('drop',function(e){send(e.dataTransfer.files[0]);});
})();`;
