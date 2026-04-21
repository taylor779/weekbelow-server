/**
 * BSMNT — Live Sync WebSocket Server + Token Payment API
 * ────────────────────────────────────────────────────────
 * Requirements:  Node.js 20+
 * Install:       npm install ws stripe @supabase/supabase-js
 * Run:           node server.js
 *
 * Railway env vars:
 *   RESEND_API_KEY        — Resend API key
 *   STRIPE_SECRET_KEY     — Stripe secret key
 *   STRIPE_WEBHOOK_SECRET — Stripe webhook signing secret
 *   GEMINI_API_KEY        — Platform Gemini key (never sent to client)
 *   SUPABASE_URL          — https://fdjnzzrrodrjkngqzewy.supabase.co
 *   SUPABASE_SERVICE_KEY  — Supabase service_role key (bypasses RLS)
 *   ADMIN_EMAIL           — taylor@below.co.nz
 */

const { WebSocketServer, WebSocket } = require('ws');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── Stripe (token payments) ──────────────────────────────────────────────────
const Stripe = require('stripe');

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

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
    const headers = {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      ...(extraHeaders || {}),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': 'return=representation',
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
        try { resolve(data ? JSON.parse(data) : null); }
        catch { resolve(data); }
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
    select(cols) { s.cols = cols || '*'; s.method = 'GET'; return q; },
    eq(col, val) { s.filters.push(`${col}=eq.${encodeURIComponent(val)}`); return q; },
    in(col, vals) { s.filters.push(`${col}=in.(${vals.map(v => encodeURIComponent(v)).join(',')})`); return q; },
    order(col, opts) { s.orderBy = `${col}.${(opts && opts.ascending === false) ? 'desc' : 'asc'}`; return q; },
    limit(n) { s.limitN = n; return q; },
    range(from, to) { s.limitN = (to - from + 1); return q; },
    update(body) { s.method = 'PATCH'; s.body = body; return q; },
    insert(body) { s.method = 'POST'; s.body = body; return q; },
    upsert(body, opts) { s.method = 'POST'; s.body = body; s.upsertConflict = (opts && opts.onConflict) ? opts.onConflict : ''; return q; },
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
      if (s.upsertConflict != null) parts.push(`on_conflict=${encodeURIComponent(s.upsertConflict)}`);
      return parts.join('&') || null;
    },
    async _exec() {
      const extraH = {};
      if (s.upsertConflict != null) extraH['Prefer'] = 'resolution=merge-duplicates,return=representation';
      return supaRest(s.method, s.table, q._qs(), s.body, extraH);
    },
  };
  return q;
}
const supabaseAdmin = SUPA_URL && SUPA_KEY ? { from: (table) => _makeSupaQuery(table) } : null;

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
let appState = loadState();
const clients = new Set();

function log(icon, msg) {
  console.log(`[${new Date().toTimeString().slice(0,8)}] ${icon}  ${msg}`);
}

// ── Express + HTTP server ─────────────────────────────────────────────────────
const express = require('express');
const app = express();

// Stripe webhook MUST use raw body — register BEFORE express.json()
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '20mb' }));

// CORS — must be first middleware so preflight OPTIONS always gets headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Max-Age', '86400'); // cache preflight 24h
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/', (req, res) => res.send('BSMNT OK'));
app.post('/create-checkout',      handleCreateCheckout);
app.post('/create-subscription',  handleCreateSubscription);
app.get('/customer-portal',       handleCustomerPortal);
app.post('/cancel-subscription',  handleCancelSubscription);
app.post('/generate-image',       handleGenerateImage);
app.post('/briefing',             handleBriefing);
app.post('/ai-brainstorm',        handleAIBrainstorm);
app.post('/send-project-invite',  handleSendProjectInvite);
app.post('/invite-member',         handleInviteMember);
app.post('/accept-project-invite',handleAcceptProjectInvite);
app.get('/project-invites/:email', handleGetProjectInvites);
app.get('/project-invites/id/:inviteId', handleGetInviteById);
app.post('/gift-tokens-email',    handleGiftTokensEmail);
app.post('/bulk-email',           handleBulkEmail);
app.post('/save-user-pref',       handleSaveUserPref);
app.post('/link-preview',         handleLinkPreview);
app.post('/set-member-active',    handleSetMemberActive);
app.post('/append-time-log',      handleAppendTimeLog);
app.post('/send-recap',           handleSendRecapNow);
app.get('/project-report/:agencyId/:projectId', handleProjectReport);
app.get('/project-share/:token',        handleGetProjectShare);
app.post('/project-share/:token/edit',  handleEditProjectShare);

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, maxPayload: 5 * 1024 * 1024 });

function broadcast(payload, excludeSocket = null) {
  const msg = JSON.stringify(payload);
  for (const c of clients) {
    if (c !== excludeSocket && c.readyState === WebSocket.OPEN) c.send(msg);
  }
}

function sendSnapshot(socket) {
  const safeUsers = (appState.users || []).map(u => { const { pin, ...rest } = u; return rest; });
  socket.send(JSON.stringify({ type:'snapshot', timers:Object.values(activeTimers), appState: { ...appState, users: safeUsers } }));
}

// ── Token / Payment handlers ──────────────────────────────────────────────────



// ── Friday 3PM recap scheduler ────────────────────────────────────────
const _sentThisWeek = new Set();

function _getWeekKey() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  return now.getFullYear() + '_w' + Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
}

function _buildUserRecap(user, state) {
  const projects = state.projects || [];
  const now = new Date();
  const weekAgo = new Date(now - 7 * 86400000);
  const myProjects = projects.filter(p => {
    const ws = (state.wbState || {})[p.id] || {};
    return String(ws.userId) === String(user.id) || (ws.split || []).map(String).includes(String(user.id));
  });
  const completedThisWeek = projects.filter(p => p.status === 'done' && p.endDate && new Date(p.endDate) >= weekAgo);
  const hoursLastWeek = (state.projects || []).flatMap(p => p.timeLog || [])
    .filter(l => String(l.user) === String(user.id) && new Date(l.date) >= weekAgo)
    .reduce((s, l) => s + l.hours, 0);
  const dueItems = myProjects.filter(p => {
    if (!p.endDate || p.status === 'done') return false;
    const d = new Date(p.endDate + 'T23:59:59');
    return d >= now && d <= new Date(now.getTime() + 7 * 86400000);
  });
  const overdueItems = myProjects.filter(p => {
    if (!p.endDate || p.status === 'done') return false;
    return new Date(p.endDate + 'T23:59:59') < now;
  });
  return { myProjects, completedThisWeek, hoursLastWeek, dueItems, overdueItems };
}

function scheduleFridayRecaps() {
  setInterval(async function() {
    try {
      const { data: states } = await supabaseAdmin.from('app_state').select('agency_id,users,brand');
      if (!states) return;
      for (const state of states) {
        const users = state.users || [];
        for (const user of users) {
          if (!user.email || !user.email.includes('@')) continue;
          if (user.active === false) continue;
          const tz = state.brand?.timezone || 'Pacific/Auckland';
          const userNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
          const dayOfWeek = userNow.getDay();
          const hour = userNow.getHours();
          const minute = userNow.getMinutes();
          if (dayOfWeek === 5 && hour === 15 && minute < 5) {
            const weekKey = 'recap_' + state.agency_id + '_' + user.id + '_' + _getWeekKey();
            if (_sentThisWeek.has(weekKey)) continue;
            _sentThisWeek.add(weekKey);
            const { data: agData } = await supabaseAdmin.from('app_state').select('*').eq('agency_id', state.agency_id).maybeSingle();
            if (agData) {
              const recapData = _buildUserRecap(user, agData);
              await sendEmail(await weeklyEmail(user, {...recapData, agencyId: agency.agency_id}));
              log('📬', `Friday recap sent to ${user.email} (${tz})`);
            }
          }
        }
      }
    } catch(e) { log('⚠', 'Friday scheduler: ' + e.message); }
  }, 5 * 60 * 1000);
}
scheduleFridayRecaps();

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
    log('🎁', `Gift email sent to ${recipient.email} (${tokens} tokens)`);
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
    const { agencyId, adminEmail } = req.body;
    if (adminEmail !== (process.env.ADMIN_EMAIL || 'taylor@below.co.nz'))
      return res.status(403).json({ error: 'Admin only' });

    const { data: agData } = await supabaseAdmin
      .from('app_state').select('*').eq('agency_id', agencyId).maybeSingle();
    if (!agData) return res.status(404).json({ error: 'Agency not found' });

    const users = agData.users || [];
    let sent = 0;
    for (const user of users) {
      if (!user.email || !user.email.includes('@') || user.active === false) continue;
      const recapData = _buildUserRecap(user, agData);
      await sendEmail(await weeklyEmail(user, {...recapData, agencyId: agency.agency_id}));
      sent++;
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
        log('🪙', `Credited ${tokensToAdd} tokens to ${agencyId}`);
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

async function handleGenerateImage(req, res) {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const { prompt, agencyId, refImages, refImageData } = req.body;
    if (!prompt || !agencyId) return res.status(400).json({ error: 'prompt and agencyId required' });
    // Support both single refImageData (legacy) and refImages array
    const imageRefs = refImages ? (Array.isArray(refImages) ? refImages : [refImages])
                     : refImageData ? [refImageData] : [];

    // Read token balance — handle missing row gracefully
    const settingsResult = await supabaseAdmin.from('agency_settings')
      .select('token_balance').eq('agency_id', agencyId).maybeSingle();
    const settings = settingsResult?.data;
    const balance = (settings && typeof settings.token_balance === 'number') ? settings.token_balance : 0;
    if (balance <= 0) return res.status(402).json({ error: 'No tokens remaining. Purchase more in the app.' });

    const newBalance = balance - 1;
    // Upsert so it works even if the row doesn't exist yet
    await supaRest('POST', 'agency_settings', null, { agency_id: agencyId, token_balance: newBalance });

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
      // Refund the token since generation failed
      await supaRest('POST', 'agency_settings', null, { agency_id: agencyId, token_balance: balance });
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
      // Refund the token
      await supaRest('POST', 'agency_settings', null, { agency_id: agencyId, token_balance: balance });
      const reason = geminiData?.candidates?.[0]?.finishReason || 'unknown';
      return res.status(500).json({ error: 'No image returned from Gemini (finish reason: ' + reason + ')' });
    }

    log('🎬', `Generated image for ${agencyId} — ${newBalance} tokens remaining`);
    res.json({ imageUrl: 'data:' + imgPart.inlineData.mimeType + ';base64,' + imgPart.inlineData.data, tokenBalance: newBalance });
  } catch (e) {
    console.error('generate-image error:', e.message);
    res.status(500).json({ error: e.message });
  }
}


// ── AI Briefing (text-only, for dashboard insight) ───────────────────────────
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
    console.error('briefing error:', e.message);
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

    console.log('[share] Scanning', rows.length, 'row(s) for token:', token.slice(0,8) + '...');

    for (const row of rows) {
      let projects = row.projects;
      if (typeof projects === 'string') {
        try { projects = JSON.parse(projects); } catch(e) { continue; }
      }
      if (!Array.isArray(projects)) {
        console.log('[share] agency', row.agency_id, '— projects is', typeof projects, '(not array)');
        continue;
      }
      console.log('[share] agency', row.agency_id, '—', projects.length, 'projects, checking tokens...');
      const tokenProjects = projects.filter(p => p && (p.shareViewToken || p.shareEditToken));
      console.log('[share]  projects with tokens:', tokenProjects.map(p => p.name + ':' + (p.shareViewToken||'').slice(0,6) + '/' + (p.shareEditToken||'').slice(0,6)));

      const proj = projects.find(p =>
        p && (p.shareViewToken === token || p.shareEditToken === token)
      );
      if (proj) {
        let brand = row.brand;
        if (typeof brand === 'string') { try { brand = JSON.parse(brand); } catch(e) { brand = {}; } }
        console.log('[share] ✅ Token matched project:', proj.name);
        return {
          project: proj,
          agencyId: row.agency_id,
          brand: brand || {},
          type: proj.shareViewToken === token ? 'view' : 'edit'
        };
      }
    }
    console.log('[share] ❌ Token not found in any project');
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

    // Load full current state
    const { data: stateRow } = await supabaseAdmin
      .from('app_state')
      .select('*')
      .eq('agency_id', found.agencyId)
      .maybeSingle();
    if (!stateRow) return res.status(404).json({ error: 'State not found' });

    const projects = Array.isArray(stateRow.projects) ? [...stateRow.projects] : [];
    const projIdx = projects.findIndex(p => p.id === found.project.id);
    if (projIdx < 0) return res.status(404).json({ error: 'Project not found in state' });

    let proj = { ...projects[projIdx] };
    const guest = (guestName || 'External').slice(0, 40);

    // ── Apply the operation ───────────────────────────────────────────────────
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

      default:
        return res.status(400).json({ error: 'Unknown operation: ' + op });
    }

    // Write back to Supabase
    projects[projIdx] = proj;
    const { error: writeErr } = await supabaseAdmin
      .from('app_state')
      .update({ projects, updated_by: 'share:' + guest, local_version: Date.now() })
      .eq('agency_id', found.agencyId);

    if (writeErr) return res.status(500).json({ error: writeErr.message });

    // The Supabase DB write above triggers postgres_changes on the studio side automatically

    log('✏️', `Share edit [${op}] on project ${found.project.name} by ${guest}`);
    res.json({ ok: true, project: sanitizeProject(proj) });

  } catch(e) {
    console.error('[share] EDIT error:', e.message);
    res.status(500).json({ error: e.message });
  }
}


// ── Project Collaboration Invites ─────────────────────────────────────────────


async function handleInviteMember(req, res) {
  const { agencyId, email, role, memberData } = req.body || {};
  if (!agencyId || !email) return res.status(400).json({ error: 'agencyId and email required' });
  try {
    const expires = new Date(Date.now() + 7*24*60*60*1000).toISOString();
    const { error } = await supabaseAdmin.from('invites').insert({
      agency_id: agencyId,
      email: email.toLowerCase().trim(),
      role: role || 'member',
      expires_at: expires,
      member_name:       memberData?.name       || email.split('@')[0],
      member_initials:   memberData?.initials   || email.slice(0,2).toUpperCase(),
      member_color:      memberData?.color      || '#7c6fff',
      cost_rate:         memberData?.costRate   || 0,
      charge_rate:       memberData?.chargeRate || 0,
      can_access_reports: memberData?.canAccessReports || false,
      can_edit_budgets:   memberData?.canEditBudgets   || false,
    });
    if (error) throw error;
    log('✉', `Member invite created: ${email} → agency ${agencyId}`);
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
    const firstName = (guestMember.name || 'there').split(' ')[0];
    const pn = projectName || 'a project';
    const inn = inviterName || 'Someone';
    sendEmail({
      to: invitedEmail,
      subject: `${inn} invited you to collaborate on "${pn}"`,
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="background:#0c0c0e;margin:0;padding:0;font-family:'DM Sans',system-ui,sans-serif;"><div style="max-width:500px;margin:40px auto;background:#131316;border:1px solid #2c2c36;border-radius:16px;overflow:hidden;"><div style="background:linear-gradient(135deg,rgba(124,111,255,0.3),rgba(192,132,252,0.15));padding:32px;text-align:center;border-bottom:1px solid #2c2c36;"><div style="font-size:48px;margin-bottom:12px;">🎬</div><h1 style="color:#eeeef2;font-size:22px;margin:0 0 4px;font-weight:700;">Project Invite</h1><p style="color:#9898aa;font-size:13px;margin:0;">via BSMNT</p></div><div style="padding:28px 32px;"><p style="color:#c8c8d8;font-size:15px;margin:0 0 16px;">Hey ${firstName},</p><p style="color:#c8c8d8;font-size:15px;margin:0 0 20px;"><strong style="color:#eeeef2;">${inn}</strong> has invited you to collaborate on <strong style="color:#7c6fff;">${pn}</strong>.</p><p style="color:#9898aa;font-size:13px;margin:0 0 24px;">Open BSMNT to accept or decline — the invite is waiting in your notifications.</p><a href="https://bsmnt.co.nz/app.html?accept_invite=${inviteId}" style="display:block;background:#7c6fff;color:#fff;text-decoration:none;padding:14px;border-radius:8px;text-align:center;font-weight:600;font-size:15px;">Accept project invite \u2192</a><p style="color:#55556a;font-size:12px;margin:16px 0 0;text-align:center;">You can also decline from within the BSMNT app.</p></div><div style="padding:16px 32px;border-top:1px solid #2c2c36;text-align:center;"><p style="color:#55556a;font-size:11px;margin:0;">BSMNT \u00b7 Week Below</p></div></div></body></html>`,
    }).catch(e => log('invite email err', e.message));
    log('🤝', `Project invite sent: ${invitedEmail} to ${pn}`);
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
    const newStatus = accept ? 'accepted' : 'declined';
    await supabaseAdmin.from('project_invites').update({ status: newStatus }).eq('id', inviteId);
    let projectData = null;
    if (accept) {
      // Create collaboration link
      await supabaseAdmin.from('shared_projects').upsert({
        project_id: invite.project_id, owner_agency_id: invite.owner_agency_id, guest_agency_id: guestAgencyId,
      }, { onConflict: 'project_id,guest_agency_id' });
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
    res.json({ invite });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

async function handleGetProjectInvites(req, res) {
  const { email } = req.params;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const { data } = await supabaseAdmin.from('project_invites')
      .select('*').eq('invited_email', decodeURIComponent(email)).eq('status', 'pending')
      .order('created_at', { ascending: false });
    res.json({ invites: data || [] });
  } catch(e) {
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
  try {
    // Read current projects
    const { data: row, error: readErr } = await supabaseAdmin
      .from('app_state')
      .select('projects')
      .eq('agency_id', agencyId)
      .maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    if (!row) return res.status(404).json({ error: 'Agency state not found' });

    // Find the project and append the entry atomically on the server
    const projects = (row.projects || []).map(function(p) {
      if (String(p.id) !== String(projectId)) return p;
      const timeLog = Array.isArray(p.timeLog) ? p.timeLog : [];
      return Object.assign({}, p, { timeLog: timeLog.concat([entry]) });
    });

    // Write back — using service key so RLS is bypassed
    const { error: writeErr } = await supabaseAdmin
      .from('app_state')
      .update({ projects })
      .eq('agency_id', agencyId);
    if (writeErr) return res.status(500).json({ error: writeErr.message });

    log('⏱', `Time log appended: ${entry.hours}h to project ${projectId} for agency ${agencyId}`);
    res.json({ ok: true });
  } catch(e) {
    log('⏱ append-time-log error:', e.message);
    res.status(500).json({ error: e.message });
  }
}


async function handleSetMemberActive(req, res) {
  const { userId, agencyId, active } = req.body || {};
  if (!userId || !agencyId || active === undefined) {
    return res.status(400).json({ error: 'userId, agencyId, active required' });
  }
  try {
    const { error } = await supabaseAdmin
      .from('agency_members')
      .update({ active: !!active })
      .eq('id', userId)
      .eq('agency_id', agencyId);
    if (error) return res.status(500).json({ error: error.message });
    log('👤', `Member ${userId} active=${active} in agency ${agencyId}`);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}


async function handleLinkPreview(req, res) {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BSMNT/1.0)' },
      signal: AbortSignal.timeout(5000)
    });
    const html = await resp.text();
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
  const { userId, agencyId, key, value } = req.body || {};
  if (!userId || !agencyId || !key) return res.status(400).json({ error: 'userId, agencyId, key required' });
  // Whitelist allowed pref keys — never let clients write arbitrary fields
  const ALLOWED = ['uiTheme', 'cardStyle', 'bgTheme', 'accentColor', 'navOrder', 'lightMode'];
  if (!ALLOWED.includes(key)) return res.status(400).json({ error: 'Key not allowed: ' + key });
  try {
    // Fetch current preferences first
    const { data: row } = await supabaseAdmin
      .from('agency_members')
      .select('preferences')
      .eq('id', userId)
      .eq('agency_id', agencyId)
      .maybeSingle();
    if (!row) return res.status(404).json({ error: 'Member not found' });
    const prefs = Object.assign({}, row.preferences || {}, { [key]: value });
    const { error } = await supabaseAdmin
      .from('agency_members')
      .update({ preferences: prefs })
      .eq('id', userId)
      .eq('agency_id', agencyId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

async function handleBulkEmail(req, res) {
  const { subject, body, senderName, agencyId } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
  // Only allow Taylor to send bulk emails
  if (agencyId !== 'b29ba033-e4a6-4e61-a7c4-1ec3a6c6708f') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

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
        log('✉ bulk-email error for', r.email, e.message);
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
  if (!RESEND_KEY) { log('✉', `[no key] Would send to ${to}: ${subject}`); return Promise.resolve(); }
  if (!to || !to.includes('@')) { log('✉', `Skipping — invalid address: ${to}`); return Promise.resolve(); }
  const body = JSON.stringify({ from: FROM_EMAIL, to, subject, html });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { log('✉', `Sent to ${to} — ${subject}`); resolve({ ok:true }); }
        else { log('✉', `Failed (${res.statusCode}) to ${to}: ${data}`); resolve({ ok:false, error:`HTTP ${res.statusCode}`, detail:data }); }
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
  const firstName = user.name.split(' ')[0];
  const projRows = myProjects.map(p => {
    const cls = p.budgetPct < 70 ? 'ok' : p.budgetPct < 100 ? 'warn' : 'over';
    const label = p.budgetPct < 70 ? 'On track' : p.budgetPct < 100 ? 'Watch budget' : 'Over budget';
    const dueFmt = p.endDate ? new Date(p.endDate+'T12:00:00').toLocaleDateString('en-NZ',{day:'numeric',month:'short'}) : null;
    return `<div class="prow"><div><div class="pname">${p.name}</div><div class="pmeta">${p.client}${dueFmt?' · Due '+dueFmt:''}</div></div><span class="badge ${cls}">${label}</span></div>`;
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

function assignmentEmail(user, project, byName, logoHtml) {
  const firstName = (user.name || 'there').split(' ')[0];
  const dueFmt = project.endDate ? new Date(project.endDate+'T12:00:00').toLocaleDateString('en-NZ',{day:'numeric',month:'long',year:'numeric'}) : null;
  return {
    subject: `You've been added to "${project.name}"`,
    html: wrap(`<h2>You're on a new project</h2>
      <p class="sub">${byName} has assigned you to a project.</p>
      <div class="proj-card">
        <div class="proj-card-name">${project.name}</div>
        ${project.client?`<div class="proj-card-client">${project.client}</div>`:''}
        ${dueFmt?`<div class="proj-card-due">📅 Due ${dueFmt}</div>`:''}
        ${project.description?`<div class="proj-card-desc">${project.description}</div>`:''}
      </div>
      <p style="font-size:13px;color:#8080a0;line-height:1.7;margin:0;">Log in to BSMNT to view the full brief, track your time, and check the run sheet.</p>`, logoHtml),
  };
}

// ── Weekly recap ──────────────────────────────────────────────────────────────

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

function notifyAssignments(newProjects, prevProjects, triggerName) {
  if(!Array.isArray(newProjects))return;
  newProjects.forEach(newP=>{
    const oldP=(prevProjects||[]).find(p=>String(p.id)===String(newP.id));
    const oldIds=(oldP?oldP.assigned||[]:[]).map(String);
    const newIds=(newP.assigned||[]).map(String);
    const added=newIds.filter(id=>!oldIds.includes(id));
    log('🔍',`Assignment check "${newP.name}": added=[${added}]`);
    if(!added.length)return;
    const cl=(appState.clients||[]).find(c=>c.id===newP.clientId);
    const proj={name:newP.name,client:cl?cl.name:'',endDate:newP.endDate,description:newP.description};
    added.forEach(uid=>{
      const user=(appState.users||[]).find(u=>String(u.id)===uid);
      if(!user||!user.email||!user.email.includes('@')||user.emailAssign===false)return;
      const{subject,html}=assignmentEmail(user,proj,triggerName||'Someone');
      log('✉',`Assignment email → ${user.email} for "${newP.name}"`);
      sendEmail({to:user.email,subject,html});
    });
  });
}

// ── WebSocket handler ─────────────────────────────────────────────────────────

wss.on('connection', socket => {
  clients.add(socket);
  log('+', `Client connected (total: ${clients.size})`);
  log('🔑', `RESEND_API_KEY: ${RESEND_KEY ? 'SET (' + RESEND_KEY.slice(0,8) + '...)' : 'NOT SET'}`);
  socket._lastSync = 0; socket._syncCount = 0;
  sendSnapshot(socket);

  socket.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {

      case 'timer_start': {
        const { userId, userName, userColor, userInitials, projectId, projectName, taskId, phase } = msg;
        if (!userId) return;
        activeTimers[String(userId)] = { userId, userName, userColor, userInitials, projectId, projectName, taskId, phase, startedAt: new Date().toISOString() };
        broadcast({ type:'timer_start', timer:activeTimers[String(userId)] }, socket);
        log('▶', `${userName} started timer on "${projectName}"`);
        break;
      }

      case 'timer_stop': {
        const { userId } = msg;
        if (!userId) return;
        const timer = activeTimers[String(userId)];
        delete activeTimers[String(userId)];
        broadcast({ type:'timer_stop', userId, timer }, socket);
        if (timer) log('■', `${timer.userName} stopped timer`);
        break;
      }

      case 'app_sync': {
        const now = Date.now();
        if (now - (socket._lastSync||0) < 500) {
          socket._syncCount = (socket._syncCount||0) + 1;
          if (socket._syncCount > 5) { log('⚠','Rate limit: app_sync throttled'); break; }
        } else { socket._syncCount = 0; }
        socket._lastSync = now;
        const { projects, clients:cls, users, archived, tasks, wbState, templates, brand, userName } = msg;
        const prevProjects = JSON.parse(JSON.stringify(appState.projects||[]));
        if (projects  !== undefined) appState.projects  = projects;
        if (cls       !== undefined) appState.clients   = cls;
        if (users     !== undefined) appState.users = users.map(u => { const { pin, ...rest } = u; return rest; });
        if (archived  !== undefined) appState.archived  = archived;
        if (tasks     !== undefined) appState.tasks     = tasks;
        if (wbState   !== undefined) appState.wbState   = wbState;
        if (templates !== undefined) appState.templates = templates;
        if (msg.taskTemplates  !== undefined) appState.taskTemplates  = msg.taskTemplates;
        if (msg.businessCosts  !== undefined) appState.businessCosts  = msg.businessCosts;
        if (msg.retainers      !== undefined) appState.retainers      = msg.retainers;
        if (brand     !== undefined) appState.brand     = brand;
        appState.seeded = true;
        scheduleSave();
        broadcast({ type:'app_sync', appState, triggeredBy:userName||'?' }, socket);
        log('🔄', `State updated by ${userName||'unknown'}`);
        if (projects !== undefined) notifyAssignments(projects, prevProjects, userName);
        break;
      }

      case 'wb_sync': {
        appState.wbState = msg.wbState||appState.wbState;
        appState.seeded = true; scheduleSave();
        broadcast({ type:'wb_sync', wbState:appState.wbState, triggeredBy:msg.userName||'?' }, socket);
        break;
      }

      case 'tasks_sync': {
        appState.tasks = msg.tasks||appState.tasks;
        appState.seeded = true; scheduleSave();
        broadcast({ type:'tasks_sync', tasks:appState.tasks, triggeredBy:msg.userName||'?' }, socket);
        break;
      }

      case 'ping': { sendSnapshot(socket); break; }

      case 'test_email': {
        const to = msg.to;
        if (!to||!to.includes('@')) { socket.send(JSON.stringify({type:'email_result',ok:false,error:'No valid email address.'})); break; }
        if (!RESEND_KEY) { socket.send(JSON.stringify({type:'email_result',ok:false,to,error:'RESEND_API_KEY not set.'})); break; }
        sendEmail({ to, subject:'✅ BSMNT — email test', html:wrap(`
          <h2>Test email ✓</h2>
          <p class="sub">BSMNT emails are working correctly.</p>
          <p style="font-size:13px;color:#8080a0;">Sent: ${new Date().toISOString()}</p>
        `) }).then(r => socket.send(JSON.stringify({type:'email_result',ok:r.ok,to,error:r.error||null})));
        log('✉', `Test email → ${to}`);
        break;
      }

      case 'send_recap_now': {
        log('✉', `Manual recap by ${msg.userName||'?'}`);
        const withEmail=(appState.users||[]).filter(u=>u.active!==false&&u.email&&u.email.includes('@'));
        try { sendWeeklyRecaps(); socket.send(JSON.stringify({type:'recap_result',ok:true,count:withEmail.length})); }
        catch(e) { socket.send(JSON.stringify({type:'recap_result',ok:false,error:e.message})); }
        break;
      }

      case 'feedback_reply': {
        const { userEmail, subject, replyText, senderName } = msg;
        if (!userEmail||!userEmail.includes('@')||!RESEND_KEY||!replyText?.trim()) break;
        sendEmail({ to:userEmail, subject:subject||'Re: your feedback', html:wrap(`
          <h2>✉ Reply to your feedback</h2>
          <p class="sub">Re: <strong>${subject||'your feedback'}</strong></p>
          <div style="background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:20px 24px;margin:20px 0;border-left:3px solid #7c6fff;">
            <div style="font-size:14px;color:#e0e0ec;line-height:1.75;white-space:pre-wrap;">${replyText.trim()}</div>
          </div>
          <p style="font-size:13px;color:#8080a0;margin:0;">— ${senderName||'The BSMNT team'}</p>
        `) });
        log('✉', `Feedback reply → ${userEmail}`);
        break;
      }

      case 'project_assigned': {
        const { to, userName:uName, projectName, assignedBy } = msg;
        if (!to||!to.includes('@')||!RESEND_KEY) break;
        const proj=(appState.projects||[]).find(p=>p.name===projectName);
        const user=(appState.users||[]).find(u=>u.email===to)||{name:uName};
        if (proj) {
          const cl=(appState.clients||[]).find(c=>c.id===proj.clientId);
          const{subject,html}=assignmentEmail(user,{name:proj.name,client:cl?cl.name:'',endDate:proj.endDate,description:proj.description},assignedBy||'Someone');
          sendEmail({to,subject,html});
        } else {
          sendEmail({to,subject:`You've been added to "${projectName}"`,html:wrap(`
            <h2>You're on a new project</h2>
            <p class="sub">${assignedBy||'Someone'} added you to <strong>${projectName}</strong>.</p>
            <p style="font-size:13px;color:#8080a0;line-height:1.7;margin:0;">Log in to BSMNT to view the full brief.</p>
          `)});
        }
        log('✉', `project_assigned → ${to} for "${projectName}"`);
        break;
      }

      case 'feedback_submitted': {
        const fb=msg.entry||{};
        log('💬', `Feedback from ${fb.user_name||'?'}: [${fb.type}] ${fb.subject}`);
        const adminEmail=process.env.ADMIN_EMAIL||'';
        if (adminEmail&&adminEmail.includes('@')&&RESEND_KEY) {
          const typeEmoji={bug:'🐛',feature:'💡',general:'💬'}[fb.type]||'💬';
          sendEmail({to:adminEmail,subject:`${typeEmoji} [${fb.type}] ${fb.subject||'Feedback'}`,html:wrap(`
            <h2>${typeEmoji} New ${fb.type} feedback</h2>
            <p class="sub">From <strong>${fb.user_name||'Unknown'}</strong> (${fb.user_email||'no email'}) on ${fb.page||'unknown page'}</p>
            <div style="background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:20px 24px;margin:20px 0;border-left:4px solid #7c6fff;">
              <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:8px;">${fb.subject||'(no subject)'}</div>
              <div style="font-size:14px;color:#8080a0;line-height:1.7;white-space:pre-wrap;">${fb.message||''}</div>
            </div>
          `)});
        }
        break;
      }

      case 'feedback_status_update': {
        const { to, subject, status, userName:uName2, customMessage } = msg;
        if (!to||!to.includes('@')||!RESEND_KEY) break;
        const statusMsg=customMessage||{
          reviewing:"We're looking into this and will keep you posted.",
          shipped:"Great news — this has been shipped!",
          closed:"We've reviewed this and closed it out. Thanks for your time.",
        }[status]||`Status: ${status}`;
        const col=status==='shipped'?'#34d399':status==='reviewing'?'#fbbf24':'#7c6fff';
        sendEmail({to,subject:`Re: ${subject||'your feedback'}`,html:wrap(`
          <h2>Update on your feedback</h2>
          <p class="sub">Re: <strong>${subject||'your feedback'}</strong></p>
          <div style="background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:20px 24px;margin:20px 0;border-left:4px solid ${col};">
            <div style="font-size:14px;color:#e0e0ec;line-height:1.75;white-space:pre-wrap;">${statusMsg}</div>
          </div>
          <p style="font-size:13px;color:#8080a0;">— ${uName2||'The team'}</p>
        `)});
        log('✉', `Feedback reply → ${to}: ${status}`);
        break;
      }
    }
  });

  socket.on('close', () => { clients.delete(socket); log('-', `Client disconnected (total: ${clients.size})`); });
  socket.on('error', err => { console.error('Socket error:', err.message); clients.delete(socket); });
});

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
  try {
    const { data: state } = await supabaseAdmin.from('app_state')
      .select('projects,clients,users,brand').eq('agency_id', agencyId).maybeSingle();
    if (!state) return res.status(404).send('Studio not found');
    const proj = (state.projects||[]).find(p => String(p.id) === String(projectId));
    if (!proj) return res.status(404).send('Project not found');
    const client  = (state.clients||[]).find(c => String(c.id) === String(proj.clientId));
    const brand   = state.brand || {};
    const users   = state.users || [];
    const rs      = proj.runsheet || {};
    const timeline    = rs.timeline || rs.rows || [];
    const crew        = rs.crew || [];
    const equipment   = rs.equipment || [];
    const notes       = rs.notes || '';
    const hs          = rs.healthSafety || rs.hs || '';
    const shotList    = (proj.shotList||[]).filter(s => !s.isScene);
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
        const loc   = row.location || row.desc || row.item || '';
        const notes = row.crew || row.notes || '';
        const time  = row.time || row.startTime || '';
        const pct   = barPct(time);
        const isKey = row.isKey || i === 0 || String(loc).toLowerCase().includes('wrap') || String(loc).toLowerCase().includes('crew call');
        return `<div style="display:flex;gap:7px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #ebebeb;">
          <div style="font-family:'DM Mono',monospace;font-size:9px;color:#888;width:34px;flex-shrink:0;padding-top:1px;">${time}</div>
          <div style="flex:1;">
            <div style="font-size:11px;font-weight:600;color:#111;">${loc}</div>
            ${notes ? `<div style="font-size:9px;color:#888;margin-top:1px;font-family:'DM Mono',monospace;">${notes}</div>` : ''}
            <div style="height:2px;background:${isKey ? accent : '#ddd'};border-radius:1px;margin-top:4px;width:${pct}%;"></div>
          </div>
        </div>`;
      }).join('');
    }

    // Schedule section (with day headers if multi-day)
    const schedHtml = scheduleGroups.map(g => `
      ${g.day ? `<div style="font-family:'DM Mono',monospace;font-size:7px;letter-spacing:2px;text-transform:uppercase;color:#888;margin:8px 0 6px;padding-bottom:4px;border-bottom:1px solid #e8e8e8;">${g.day}</div>` : ''}
      ${schedRows(g.rows)}
    `).join('');

    // Shot list
    const shotsHtml = shotList.slice(0, 20).map((s, i) => `
      <div style="display:flex;gap:7px;margin-bottom:7px;align-items:flex-start;">
        <div style="font-family:'DM Mono',monospace;font-size:8px;color:${accent};width:22px;flex-shrink:0;margin-top:2px;">${String(i+1).padStart(2,'0')}</div>
        <div>
          <div style="font-size:11px;font-weight:500;color:#111;">${s.desc||''}</div>
          <div style="font-family:'DM Mono',monospace;font-size:8px;color:#888;margin-top:1px;">${[s.type,s.angle,s.movement].filter(Boolean).join(' · ')}</div>
        </div>
      </div>`).join('');

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

    // Shot scenes as section separators
    const allShotItems = (proj.shotList||[]);
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
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Space Grotesk',sans-serif;background:#f9f9f6;color:#111;font-size:11px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
@media print{
  body{background:#f9f9f6;}
  .no-print{display:none!important;}
  .page-break{page-break-before:always;}
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
</style>
</head>
<body>

<!-- TOP BAR -->
<div class="topbar">
  <div style="display:flex;align-items:center;gap:14px;">
    ${logoHtml}
    <div style="width:1px;height:11px;background:rgba(255,255,255,0.15);"></div>
    <span style="font-size:11px;font-weight:600;color:#fff;">${proj.name||''}</span>
  </div>
  <div style="font-family:'DM Mono',monospace;font-size:8px;color:rgba(255,255,255,0.3);">RS-${String(projectId).slice(-4).toUpperCase()} · ${useDays ? days.length+' DAY'+( days.length>1?'S':'') : 'RUNSHEET'}</div>
</div>

<!-- HERO -->
<div class="hero">
  <div>
    <div style="font-family:'DM Mono',monospace;font-size:7px;letter-spacing:2px;text-transform:uppercase;color:${accent};margin-bottom:6px;">Production Runsheet</div>
    <div style="font-family:'Syne',sans-serif;font-size:26px;font-weight:800;letter-spacing:-0.4px;line-height:1.1;margin-bottom:8px;">${proj.name||''}</div>
    <div style="font-size:10px;color:#888;">${client ? client.name+' · ' : ''}${rs.location||''}</div>
  </div>
  <div style="text-align:right;font-family:'DM Mono',monospace;font-size:8px;color:#bbb;line-height:2;">
    <div>${date}</div>
    ${timeline.length ? `<div>Call: ${timeline[0].time||timeline[0].startTime||''}</div>` : ''}
    <div>${crew.length || users.length} crew · ${shotList.length} shots</div>
    <div style="color:${accent};margin-top:3px;">${client ? client.name : ''}</div>
  </div>
</div>

<!-- SCHEDULE + SHOTS -->
<div class="body-grid">
  <div class="col">
    <div class="col-lbl">Schedule</div>
    ${schedHtml || '<div style="color:#aaa;font-size:11px;">No schedule added yet.</div>'}
  </div>
  <div class="divider-col" style="display:flex;flex-direction:column;align-items:center;padding:14px 0;">
    <div class="tick"></div>
  </div>
  <div class="col">
    <div class="col-lbl">Shot list</div>
    ${shotsHtml || '<div style="color:#aaa;font-size:11px;">No shots added yet.</div>'}
  </div>
</div>

<!-- CREW + EQUIPMENT -->
${(crewSection || equipHtml) ? `
<div class="bottom-grid">
  ${crewSection ? `
  <div class="bottom-col">
    <div class="col-lbl">Crew manifest</div>
    <div class="crew-grid">${crewSection}</div>
  </div>` : '<div class="bottom-col"></div>'}
  ${equipHtml ? `
  <div class="bottom-col">
    <div class="col-lbl">Equipment checklist</div>
    <div class="equip-grid">${equipHtml}</div>
  </div>` : '<div class="bottom-col"></div>'}
</div>` : ''}

<!-- NOTES + H&S -->
${(notes || hs) ? `
<div class="notes-row">
  ${notes ? `<div>
    <div class="col-lbl">Production notes</div>
    <div style="font-size:10px;color:#555;line-height:1.7;">${notes}</div>
  </div>` : '<div></div>'}
  ${hs ? `<div>
    <div class="col-lbl">Health &amp; Safety</div>
    <div style="font-size:10px;color:#555;line-height:1.7;">${hs}</div>
  </div>` : '<div></div>'}
</div>` : ''}

<!-- BOTTOM BAR -->
<div class="bottombar">
  <div style="font-family:'DM Mono',monospace;font-size:7px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,0.2);">
    <div style="width:5px;height:5px;border-radius:50%;background:${accent};display:inline-block;margin-right:5px;"></div>
    ${studioName} · bsmnt.co.nz
  </div>
  <div style="font-family:'DM Mono',monospace;font-size:8px;color:rgba(255,255,255,0.3);">Page 1</div>
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
  console.log(`Stripe: ${stripe ? 'configured ✓' : 'not configured — add STRIPE_SECRET_KEY'}`);
  console.log(`Supabase: ${supabaseAdmin ? 'configured ✓' : 'not configured — add SUPABASE_URL + SUPABASE_SERVICE_KEY'}\n`);
});

scheduleWeeklyRecap();
