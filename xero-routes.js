// ─────────────────────────────────────────────────────────────────────────────
// xero-routes.js  —  BSMNT one-click "Send to Xero"
//
// Drop this file next to your existing Railway server entry (e.g. server.js / index.js)
// and mount it:
//
//     const xeroRoutes = require('./xero-routes');
//     app.use(xeroRoutes);
//
// It adds four endpoints the BSMNT client already calls:
//     GET  /xero/connect?agency=<id>     -> redirects the user to Xero to authorise
//     GET  /xero/callback                -> Xero redirects back here; we store tokens
//     GET  /xero/status?agency=<id>      -> { connected, org }
//     POST /xero/invoice                 -> creates a DRAFT invoice, returns deep link
//
// Requirements: Node 18+ (uses global fetch), express. No other deps.
// Tokens are stored per-agency in a Supabase table `xero_connections` via the REST API
// using your service-role key (server-only).
//
// ENV VARS (set these in Railway):
//   XERO_CLIENT_ID            from your Xero app
//   XERO_CLIENT_SECRET        from your Xero app
//   XERO_REDIRECT_URI         https://weekbelow-server-production.up.railway.app/xero/callback
//   XERO_APP_RETURN_URL       https://bsmnt.co.nz/app           (where to send the user after connect)
//   SUPABASE_URL              (already set on your server)
//   SUPABASE_SERVICE_KEY      (already set on your server)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();

const XERO_CLIENT_ID     = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const XERO_REDIRECT_URI  = process.env.XERO_REDIRECT_URI;
const APP_RETURN_URL     = process.env.XERO_APP_RETURN_URL || 'https://bsmnt.co.nz/app';
const SUPABASE_URL       = process.env.SUPABASE_URL;
// Reuse the server's existing Supabase service key (it's named SUPABASE_SERVICE_KEY here).
const SUPABASE_KEY       = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Granular scopes (required for Xero apps created on/after 2 Mar 2026):
// accounting.invoices replaces the old broad accounting.transactions for writing invoices.
const SCOPES = 'openid profile email offline_access accounting.contacts accounting.invoices';

// NOTE: this router relies on the host app's existing global middleware:
//   app.use(express.json(...))   — so req.body is already parsed
//   the global CORS middleware   — so browser calls to /status and /invoice are allowed
// Mount it AFTER those (it is, if you add it with your other route registrations).

// ── Supabase token store (REST, service key) ─────────────────────────────────
function _sbHeaders() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
}
async function getConnection(agency) {
  const url = SUPABASE_URL + '/rest/v1/xero_connections?agency_id=eq.' +
              encodeURIComponent(agency) + '&select=*';
  const r = await fetch(url, { headers: _sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  return (rows && rows[0]) || null;
}
async function saveConnection(agency, data) {
  const row = {
    agency_id: agency,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    tenant_id: data.tenant_id,
    org_name: data.org_name,
    updated_at: new Date().toISOString()
  };
  // upsert (agency_id is the primary key)
  const r = await fetch(SUPABASE_URL + '/rest/v1/xero_connections?on_conflict=agency_id', {
    method: 'POST',
    headers: Object.assign(_sbHeaders(), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error('Token store failed: ' + r.status + ' ' + (await r.text()));
}

// ── Xero token helpers ───────────────────────────────────────────────────────
function _basicAuth() {
  return 'Basic ' + Buffer.from(XERO_CLIENT_ID + ':' + XERO_CLIENT_SECRET).toString('base64');
}
async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: XERO_REDIRECT_URI
  });
  const r = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Authorization': _basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error('Token exchange failed: ' + r.status + ' ' + (await r.text()));
  return r.json(); // { access_token, refresh_token, expires_in, ... }
}
async function refreshTokens(refresh_token) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token });
  const r = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Authorization': _basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) throw new Error('Token refresh failed: ' + r.status + ' ' + (await r.text()));
  return r.json();
}
async function getTenant(access_token) {
  const r = await fetch('https://api.xero.com/connections', {
    headers: { 'Authorization': 'Bearer ' + access_token, 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error('Connections lookup failed: ' + r.status);
  const conns = await r.json();
  return (conns && conns[0]) || null; // { tenantId, tenantName, ... }
}
// Return a valid access token for the agency. Refreshes when the stored token is
// within 60s of expiry, or unconditionally when opts.forceRefresh is set (used to
// recover when Xero rejects a token we believed was still valid). If the refresh
// itself fails (e.g. the refresh token expired after 60 days of inactivity or was
// revoked) it returns { needsReconnect:true } instead of throwing, so the caller
// can cleanly ask the client to reconnect rather than surfacing a 500.
async function validAccessToken(agency, opts) {
  opts = opts || {};
  const c = await getConnection(agency);
  if (!c) return null;
  const now = Date.now();
  // Robust expiry parse: numeric ms, numeric string, or ISO timestamp.
  let exp = Number(c.expires_at);
  if (!isFinite(exp) || exp <= 0) { const p = Date.parse(c.expires_at); exp = isFinite(p) ? p : 0; }

  let access_token = c.access_token;
  let refresh_token = c.refresh_token;
  let tenant_id = c.tenant_id;
  let expires_at = exp;

  if (opts.forceRefresh || !exp || now >= (exp - 60000)) {
    let t;
    try {
      t = await refreshTokens(c.refresh_token);
    } catch (e) {
      console.error('[xero] token refresh failed:', e.message);
      return { needsReconnect: true };
    }
    access_token = t.access_token;
    refresh_token = t.refresh_token || c.refresh_token;
    expires_at = Date.now() + (t.expires_in * 1000);
    try {
      await saveConnection(agency, { access_token, refresh_token, expires_at, tenant_id, org_name: c.org_name });
    } catch (e) { console.error('[xero] save after refresh failed:', e.message); }
  }

  // Backfill a missing tenant id (older/partial connections) so requests don't
  // fail with AuthenticationUnsuccessful for lack of a Xero-tenant-id header.
  if (!tenant_id) {
    try {
      const tn = await getTenant(access_token);
      if (tn && tn.tenantId) {
        tenant_id = tn.tenantId;
        try { await saveConnection(agency, { access_token, refresh_token, expires_at: expires_at || (Date.now() + 1500000), tenant_id, org_name: c.org_name }); } catch (_) {}
      }
    } catch (_) {}
  }

  return { access_token, tenant_id, org_name: c.org_name };
}

// ── 1) Start OAuth ───────────────────────────────────────────────────────────
router.get('/xero/connect', (req, res) => {
  const agency = String(req.query.agency || '');
  if (!agency) return res.status(400).send('Missing agency');
  // Optional ?scope=... override for diagnosing invalid_scope (e.g. ?scope=openid).
  const scope = req.query.scope ? String(req.query.scope) : SCOPES;
  const url = 'https://login.xero.com/identity/connect/authorize'
    + '?response_type=code'
    + '&client_id=' + encodeURIComponent(XERO_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(XERO_REDIRECT_URI)
    + '&scope=' + encodeURIComponent(scope)
    + '&state=' + encodeURIComponent(agency);
  // Add &debug=1 to see exactly what this server builds (no redirect).
  if (req.query.debug) {
    return res.type('text/plain').send(
      'AUTHORIZE URL the server is sending:\n\n' + url +
      '\n\n--- config sanity check ---' +
      '\nSCOPES        = ' + SCOPES +
      '\nCLIENT_ID set = ' + (XERO_CLIENT_ID ? 'yes (' + String(XERO_CLIENT_ID).slice(0,6) + '\u2026, len ' + String(XERO_CLIENT_ID).length + ')' : 'NO  <-- missing env var') +
      '\nREDIRECT_URI  = ' + (XERO_REDIRECT_URI || 'NOT SET') +
      '\nSECRET set    = ' + (XERO_CLIENT_SECRET ? 'yes' : 'NO  <-- missing env var')
    );
  }
  res.redirect(url);
});

// ── 2) OAuth callback ────────────────────────────────────────────────────────
router.get('/xero/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const agency = String(req.query.state || '');
    if (!code || !agency) return res.status(400).send('Missing code/state');
    const tok = await exchangeCode(code);
    const tenant = await getTenant(tok.access_token);
    if (!tenant) return res.status(400).send('No Xero organisation connected.');
    await saveConnection(agency, {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + (tok.expires_in * 1000),
      tenant_id: tenant.tenantId,
      org_name: tenant.tenantName
    });
    const back = APP_RETURN_URL + (APP_RETURN_URL.indexOf('?') >= 0 ? '&' : '?') + 'xero=connected';
    res.redirect(back);
  } catch (e) {
    console.error('[xero/callback]', e);
    res.status(500).send('Xero connection failed: ' + e.message);
  }
});

// ── 3) Status ────────────────────────────────────────────────────────────────
router.get('/xero/status', async (req, res) => {
  try {
    const agency = String(req.query.agency || '');
    const c = await getConnection(agency);
    if (!c) return res.json({ connected: false });
    res.json({ connected: true, org: c.org_name || '' });
  } catch (e) {
    console.error('[xero/status]', e);
    res.json({ connected: false, error: 'server' });
  }
});

// Map a friendly NZ/AU tax name to the Xero API tax CODE. Pass through real codes.
// Empty/unknown -> '' (caller omits it, so Xero uses the account default).
function mapTaxType(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^[A-Z0-9]+$/.test(s)) return s;            // already a code (e.g. OUTPUT2)
  const map = {
    'gst on income': 'OUTPUT2',                   // NZ 15% GST on income
    'gst on expenses': 'INPUT2',
    'no gst': 'NONE',
    'gst free': 'NONE',
    'zero rated': 'ZERORATED',
    'gst on imports': 'GSTONIMPORTS'
  };
  return map[s.toLowerCase()] || '';
}

// Find an existing contact's ID so we don't create duplicates. Tries (1) exact email,
// (2) exact name, (3) name search with case-insensitive match. Needs accounting.contacts.
async function findContactId(auth, name, email) {
  const headers = {
    'Authorization': 'Bearer ' + auth.access_token,
    'Xero-tenant-id': auth.tenant_id,
    'Accept': 'application/json'
  };
  const byWhere = async (where) => {
    try {
      const url = 'https://api.xero.com/api.xro/2.0/Contacts?where=' + encodeURIComponent(where);
      const r = await fetch(url, { headers });
      if (!r.ok) return null;
      const d = await r.json().catch(() => ({}));
      const c = d && d.Contacts && d.Contacts[0];
      return (c && c.ContactID) ? c.ContactID : null;
    } catch (_) { return null; }
  };
  if (email && email.indexOf('@') > 0) {
    const id = await byWhere('EmailAddress=="' + String(email).replace(/"/g, '') + '"');
    if (id) return id;
  }
  if (name) {
    const id = await byWhere('Name=="' + String(name).replace(/"/g, '') + '"');
    if (id) return id;
    // Fallback: fuzzy search, then match name case-insensitively.
    try {
      const url = 'https://api.xero.com/api.xro/2.0/Contacts?searchTerm=' + encodeURIComponent(name);
      const r = await fetch(url, { headers });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        const want = String(name).trim().toLowerCase();
        const hit = (d && d.Contacts || []).find(c => String(c.Name || '').trim().toLowerCase() === want);
        if (hit && hit.ContactID) return hit.ContactID;
      }
    } catch (_) {}
  }
  return null;
}

// True when Xero rejected the request for an authentication reason (so we should
// refresh the token and retry, or tell the client to reconnect) rather than a
// data/validation problem.
function _isXeroAuthError(status, data) {
  if (status === 401 || status === 403) return true;
  try {
    const s = JSON.stringify(data || {}).toLowerCase();
    return /authenticationunsuccessful|unauthor|tokenexpired|invalid[_ ]?token|not[_ ]?authoris|not[_ ]?authoriz/.test(s);
  } catch (_) { return false; }
}
async function _postXeroInvoice(auth, payload) {
  const r = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + auth.access_token,
      'Xero-tenant-id': auth.tenant_id,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  return { r, data };
}

// ── 4) Create draft invoice ──────────────────────────────────────────────────
router.post('/xero/invoice', async (req, res) => {
  try {
    const { agency, invoice } = req.body || {};
    if (!agency || !invoice) return res.status(400).json({ error: 'bad_request' });

    let auth = await validAccessToken(agency);
    if (!auth) return res.status(401).json({ error: 'not_connected' });
    if (auth.needsReconnect) return res.status(401).json({ error: 'not_connected', message: 'Your Xero connection has expired. Please reconnect.' });

    const lineItems = (invoice.lineItems || []).map(li => {
      // Stage header rows: description-only line (no amount/account) -> Xero shows it as a sub-heading.
      if (li.header) {
        return { Description: (String(li.description || '').slice(0, 3900) || ' ') };
      }
      return {
        Description: String(li.description || '').slice(0, 3900) || '.',
        Quantity: Number(li.quantity) || 0,
        UnitAmount: Number(li.unitAmount) || 0,
        AccountCode: String(li.accountCode || '180'),
        ...(mapTaxType(li.taxType) ? { TaxType: mapTaxType(li.taxType) } : {})
      };
    });

    // Match an existing Xero contact (by email, then exact name, then case-insensitive
    // name search) so we reuse "Andrew Simms" instead of creating a duplicate.
    let contact;
    const existingId = await findContactId(auth, invoice.contactName, invoice.contactEmail);
    if (existingId) {
      contact = { ContactID: existingId };
    } else {
      contact = { Name: invoice.contactName };
      if (invoice.contactEmail) contact.EmailAddress = invoice.contactEmail;
    }

    const payload = { Invoices: [{
      Type: 'ACCREC',
      Contact: contact,
      Date: invoice.date || undefined,
      DueDate: invoice.dueDate || undefined,
      Reference: invoice.reference || undefined,
      CurrencyCode: invoice.currency || 'NZD',
      Status: 'DRAFT',
      LineItems: lineItems
    }]};

    let { r, data } = await _postXeroInvoice(auth, payload);
    // The stored access token can be rejected even when we believed it valid
    // (revoked, rotated out by a prior refresh, or clock skew). On an auth
    // failure, force a fresh token and retry once before giving up.
    if (!r.ok && _isXeroAuthError(r.status, data)) {
      auth = await validAccessToken(agency, { forceRefresh: true });
      if (!auth || auth.needsReconnect) return res.status(401).json({ error: 'not_connected', message: 'Your Xero connection has expired. Please reconnect.' });
      ({ r, data } = await _postXeroInvoice(auth, payload));
    }
    if (!r.ok) {
      if (_isXeroAuthError(r.status, data)) {
        console.error('[xero/invoice] auth failed after refresh', JSON.stringify(data));
        return res.status(401).json({ error: 'not_connected', message: 'Xero authentication failed. Please reconnect BSMNT to Xero.' });
      }
      // Xero nests the useful detail in Elements[].ValidationErrors; the top-level
      // Message is just "A validation exception occurred". Surface the specifics first.
      let msg = '';
      try {
        const ve = data && data.Elements && data.Elements[0] && data.Elements[0].ValidationErrors;
        if (Array.isArray(ve) && ve.length) msg = ve.map(v => v.Message).join('; ');
      } catch (_) {}
      if (!msg) msg = (data && (data.Detail || data.Message)) || ('Xero HTTP ' + r.status);
      console.error('[xero/invoice] validation', JSON.stringify(data));
      return res.status(400).json({ error: 'xero', message: msg });
    }
    const inv = (data.Invoices && data.Invoices[0]) || {};
    res.json({
      ok: true,
      invoiceId: inv.InvoiceID || '',
      invoiceNumber: inv.InvoiceNumber || '',
      deepLink: inv.InvoiceID ? ('https://go.xero.com/app/invoicing/edit/' + inv.InvoiceID) : ''
    });
  } catch (e) {
    console.error('[xero/invoice]', e);
    res.status(500).json({ error: 'server', message: e.message });
  }
});

module.exports = router;
