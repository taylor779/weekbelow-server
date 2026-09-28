/**
 * BSMNT — server-side Anthropic proxy  (POST /ai/claude)
 * ──────────────────────────────────────────────────────
 * Replaces client-side Anthropic calls that used agency_settings.anthropic_key.
 * Mounted behind requireAuth in server.js; see NATIVE_AI_PROXY.md for the
 * full request/response contract and token pricing.
 *
 * Key selection:
 *   agency_settings.use_own_key === true AND anthropic_key set
 *        -> agency's own key, used server-side only, no studio tokens charged
 *   otherwise
 *        -> platform key (env ANTHROPIC_API_KEY), studio tokens charged from
 *           agency_settings.token_balance
 *
 * Studio token cost (platform key only):
 *   tokens = max(1, ceil(estimated_usd_cost / STUDIO_TOKEN_USD))
 *   STUDIO_TOKEN_USD = $0.10 (the cheapest a studio token is ever sold for:
 *   400 tokens / $40), so a call is never billed below Anthropic cost.
 *   1 token is reserved up-front (402 if balance < 1) and refunded if the
 *   upstream call fails; any extra is deducted after the response, clamped at 0.
 *   In practice nearly every call costs 1 token (the same as one image).
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const UPSTREAM_TIMEOUT_MS = 180 * 1000;

const MAX_TOKENS_CAP = 8000;
const MAX_TOKENS_DEFAULT = 4096;
const MAX_MESSAGES = 200;
const MAX_TOOLS = 20;
const WEB_SEARCH_MAX_USES_CAP = 5;

const STUDIO_TOKEN_USD = 0.10;
const MIN_CHARGE = 1;

// USD per million tokens. Unknown newer ids fall back to their family price.
const PRICING = {
  sonnet: { in: 3.0, out: 15.0 },
  haiku:  { in: 1.0, out: 5.0 },
};
const WEB_SEARCH_USD = 0.01; // $10 / 1,000 searches

// Per-user in-memory rate limits (reset on redeploy; fine for one instance).
const RATE_LIMITS = [
  { windowMs: 60 * 1000,      max: 20  },
  { windowMs: 60 * 60 * 1000, max: 300 },
];

// ── Model whitelist ──────────────────────────────────────────────────────────
// Allowed: claude-sonnet-4-6 and any newer Sonnet; claude-haiku-4-5 and any
// newer Haiku. Optional -YYYYMMDD snapshot suffix. Opus is intentionally
// excluded (cost). Examples: claude-sonnet-4-6, claude-sonnet-5,
// claude-haiku-4-5, claude-haiku-4-5-20251001.
const MIN_VERSION = { sonnet: [4, 6], haiku: [4, 5] };
function parseModel(model) {
  if (typeof model !== 'string') return null;
  const m = model.match(/^claude-(sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?:-(\d{8}))?$/);
  if (!m) return null;
  const family = m[1];
  const major = parseInt(m[2], 10);
  const minor = m[3] != null ? parseInt(m[3], 10) : 0;
  const [minMajor, minMinor] = MIN_VERSION[family];
  if (major < minMajor || (major === minMajor && minor < minMinor)) return null;
  return { family };
}

// ── Tool whitelist ───────────────────────────────────────────────────────────
// Allowed: Anthropic's server-side web_search tool (any web_search_YYYYMMDD
// version, max_uses capped) and plain client-defined tools (name +
// input_schema; they only describe a schema, so they cost nothing extra).
// Every other server tool (code execution, web fetch, computer use, ...) is rejected.
function sanitizeTools(tools) {
  if (tools == null) return { tools: undefined };
  if (!Array.isArray(tools)) return { error: 'tools must be an array' };
  if (tools.length > MAX_TOOLS) return { error: 'too many tools (max ' + MAX_TOOLS + ')' };
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') return { error: 'invalid tool' };
    if (typeof t.type === 'string' && /^web_search_\d{8}$/.test(t.type)) {
      const tool = { ...t, name: 'web_search' };
      const mu = parseInt(tool.max_uses, 10);
      tool.max_uses = Math.min(Number.isFinite(mu) && mu > 0 ? mu : WEB_SEARCH_MAX_USES_CAP, WEB_SEARCH_MAX_USES_CAP);
      out.push(tool);
      continue;
    }
    if ((t.type == null || t.type === 'custom') && typeof t.name === 'string' && t.input_schema && typeof t.input_schema === 'object') {
      out.push(t);
      continue;
    }
    return { error: 'tool not allowed: ' + String(t.type || t.name || 'unknown') };
  }
  return { tools: out };
}

function estimateUsd(family, usage) {
  const p = PRICING[family] || PRICING.sonnet;
  const u = usage || {};
  const inTok = (u.input_tokens || 0)
    + 1.25 * (u.cache_creation_input_tokens || 0)
    + 0.10 * (u.cache_read_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  return (inTok * p.in + outTok * p.out) / 1e6 + searches * WEB_SEARCH_USD;
}

module.exports = function makeAiProxy({ supabaseAdmin, requireMember, log }) {
  const hits = new Map(); // userId -> [timestamps]

  function rateLimited(userId) {
    const now = Date.now();
    const longest = Math.max(...RATE_LIMITS.map(r => r.windowMs));
    const arr = (hits.get(userId) || []).filter(t => now - t < longest);
    for (const r of RATE_LIMITS) {
      const inWindow = arr.filter(t => now - t < r.windowMs);
      if (inWindow.length >= r.max) {
        hits.set(userId, arr);
        return Math.ceil((inWindow[0] + r.windowMs - now) / 1000);
      }
    }
    arr.push(now);
    hits.set(userId, arr);
    return 0;
  }
  // Prune idle users so the map can't grow without bound.
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) if (!arr.length || now - arr[arr.length - 1] > 60 * 60 * 1000) hits.delete(k);
  }, 10 * 60 * 1000).unref();

  // Atomically add `delta` (negative = charge) to token_balance using an
  // optimistic compare-and-set on the previous value. Clamps at 0 when
  // `clamp` is set. Returns the new balance, or null if the row is missing
  // or contention persisted.
  async function adjustBalance(agencyId, delta, { clamp = false, requireFunds = false } = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: row, error } = await supabaseAdmin.from('agency_settings')
        .select('token_balance').eq('agency_id', agencyId).maybeSingle();
      if (error) throw new Error('balance read failed: ' + error.message);
      if (!row) return null;
      const cur = typeof row.token_balance === 'number' ? row.token_balance : 0;
      if (requireFunds && cur + delta < 0) return { insufficient: true, balance: cur };
      let next = cur + delta;
      if (clamp && next < 0) next = 0;
      if (next === cur) return { balance: cur };
      const { data: upd, error: uerr } = await supabaseAdmin.from('agency_settings')
        .update({ token_balance: next })
        .eq('agency_id', agencyId).eq('token_balance', cur);
      if (uerr) throw new Error('balance update failed: ' + uerr.message);
      if (Array.isArray(upd) && upd.length) return { balance: next };
      // Lost the race to a concurrent charge; re-read and retry.
    }
    throw new Error('balance update contention');
  }

  async function handleClaude(req, res) {
    const started = Date.now();
    const user = req.authUser;
    const b = req.body || {};
    const agencyId = b.agencyId != null ? String(b.agencyId) : '';

    if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
    if (!agencyId) return res.status(400).json({ error: 'agencyId required' });

    // ── validate request ────────────────────────────────────────────────────
    const modelInfo = parseModel(b.model);
    if (!modelInfo) return res.status(400).json({ error: 'model not allowed: ' + String(b.model) + ' (use claude-sonnet-4-6 or newer Sonnet/Haiku)' });
    if (!Array.isArray(b.messages) || !b.messages.length) return res.status(400).json({ error: 'messages must be a non-empty array' });
    if (b.messages.length > MAX_MESSAGES) return res.status(400).json({ error: 'too many messages (max ' + MAX_MESSAGES + ')' });
    if (b.system != null && typeof b.system !== 'string' && !Array.isArray(b.system)) {
      return res.status(400).json({ error: 'system must be a string or an array of content blocks' });
    }
    let maxTokens = parseInt(b.max_tokens, 10);
    if (!Number.isFinite(maxTokens) || maxTokens < 1) maxTokens = MAX_TOKENS_DEFAULT;
    maxTokens = Math.min(maxTokens, MAX_TOKENS_CAP);
    const toolRes = sanitizeTools(b.tools);
    if (toolRes.error) return res.status(400).json({ error: toolRes.error });

    // ── membership + rate limit ─────────────────────────────────────────────
    let member;
    try { member = await requireMember(user.id, agencyId); }
    catch (e) { return res.status(500).json({ error: 'Membership check failed' }); }
    if (!member) return res.status(403).json({ error: 'Not a member of this agency' });

    const retryAfter = rateLimited(user.id);
    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many AI requests. Try again in ' + retryAfter + 's.' });
    }

    // ── key selection ───────────────────────────────────────────────────────
    // select('*') so a missing use_own_key column doesn't break the lookup.
    const { data: settings, error: sErr } = await supabaseAdmin.from('agency_settings')
      .select('*').eq('agency_id', agencyId).maybeSingle();
    if (sErr) return res.status(500).json({ error: 'Could not load agency settings' });

    const ownKey = settings && settings.use_own_key === true
      && typeof settings.anthropic_key === 'string' && settings.anthropic_key.trim()
      ? settings.anthropic_key.trim() : null;
    const keySource = ownKey ? 'own' : 'platform';
    const apiKey = ownKey || process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });

    // ── reserve 1 studio token (platform key only) ──────────────────────────
    let reserved = 0;
    let balance = null;
    if (!ownKey) {
      let r;
      try { r = await adjustBalance(agencyId, -MIN_CHARGE, { requireFunds: true }); }
      catch (e) { return res.status(500).json({ error: 'Could not charge studio tokens' }); }
      if (!r || r.insufficient) {
        return res.status(402).json({ error: 'No studio tokens remaining. Purchase more tokens in the app, or add your own Anthropic key in Settings.', tokenBalance: r ? r.balance : 0 });
      }
      reserved = MIN_CHARGE;
      balance = r.balance;
    }
    const refund = async () => {
      if (!reserved) return;
      try { await adjustBalance(agencyId, reserved); } catch (e) { log('⚠', '[ai] refund failed for ' + agencyId + ': ' + e.message); }
      reserved = 0;
    };

    // ── upstream call ───────────────────────────────────────────────────────
    const payload = { model: b.model, max_tokens: maxTokens, messages: b.messages };
    if (b.system != null) payload.system = b.system;
    if (toolRes.tools && toolRes.tools.length) payload.tools = toolRes.tools;

    let upstream, data;
    try {
      upstream = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const text = await upstream.text();
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    } catch (e) {
      await refund();
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      log('⚠', `[ai] upstream ${timeout ? 'timeout' : 'network error'} user=${String(user.id).slice(0, 8)} agency=${agencyId} model=${b.model}`);
      return res.status(timeout ? 504 : 502).json({ error: timeout ? 'AI request timed out' : 'Could not reach AI provider' });
    }

    if (!upstream.ok) {
      await refund();
      const upMsg = (data && data.error && data.error.message) || ('HTTP ' + upstream.status);
      log('⚠', `[ai] upstream ${upstream.status} user=${String(user.id).slice(0, 8)} agency=${agencyId} model=${b.model} key=${keySource}`);
      let status = 502, msg = 'AI provider error: ' + upMsg;
      if (upstream.status === 400 || upstream.status === 413 || upstream.status === 404) { status = upstream.status; msg = upMsg; }
      else if (upstream.status === 401 || upstream.status === 403) {
        msg = ownKey ? 'Your agency\'s Anthropic key was rejected. Check it in Settings.' : 'AI provider authentication error';
      }
      else if (upstream.status === 429) { status = 429; msg = 'AI provider rate limit hit. Please wait a moment and try again.'; }
      else if (upstream.status === 529 || upstream.status === 503) { status = 503; msg = 'AI provider is overloaded. Please try again shortly.'; }
      return res.status(status).json({ error: msg });
    }

    if (!data || typeof data !== 'object') {
      await refund();
      return res.status(502).json({ error: 'AI provider returned an unreadable response' });
    }

    // ── settle the charge ───────────────────────────────────────────────────
    let charged = 0;
    const usage = (data && data.usage) || {};
    if (!ownKey) {
      const usd = estimateUsd(modelInfo.family, usage);
      const total = Math.max(MIN_CHARGE, Math.ceil(usd / STUDIO_TOKEN_USD - 1e-9));
      charged = total;
      const extra = total - reserved;
      if (extra > 0) {
        try {
          const r = await adjustBalance(agencyId, -extra, { clamp: true });
          if (r && typeof r.balance === 'number') balance = r.balance;
        } catch (e) { log('⚠', '[ai] extra charge failed for ' + agencyId + ': ' + e.message); }
      }
      reserved = 0;
      res.set('X-Studio-Tokens-Charged', String(charged));
      if (balance != null) res.set('X-Studio-Token-Balance', String(balance));
    }
    res.set('X-AI-Key-Source', keySource);

    // Usage log — never includes prompt or completion content.
    const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
    log('🤖', `[ai] user=${String(user.id).slice(0, 8)} agency=${agencyId} model=${b.model} key=${keySource} ` +
      `in=${usage.input_tokens || 0} out=${usage.output_tokens || 0} ` +
      `cache_r=${usage.cache_read_input_tokens || 0} cache_w=${usage.cache_creation_input_tokens || 0} ` +
      `search=${searches} charged=${charged}${balance != null ? ' bal=' + balance : ''} ms=${Date.now() - started}`);

    return res.status(200).json(data);
  }

  return { handleClaude, _test: { parseModel, sanitizeTools, estimateUsd } };
};
