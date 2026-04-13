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

function supaRest(method, table, params, body) {
  // params: query string e.g. 'agency_id=eq.123'
  // body: object for POST/PATCH, or null
  return new Promise((resolve, reject) => {
    const path = `/rest/v1/${table}${params ? '?' + params : ''}`;
    const url = new URL(SUPA_URL);
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=minimal',
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

const supabaseAdmin = SUPA_URL && SUPA_KEY ? {
  from: (table) => ({
    select: (cols) => ({
      eq: (col, val) => ({
        maybeSingle: () => supaRest('GET', table, `${col}=eq.${encodeURIComponent(val)}&select=${cols}`).then(r => ({ data: Array.isArray(r) ? r[0] || null : r }))
      })
    }),
    update: (body) => ({
      eq: (col, val) => supaRest('PATCH', table, `${col}=eq.${encodeURIComponent(val)}`, body).then(r => ({ data: r }))
    }),
    insert: (body) => supaRest('POST', table, null, body).then(r => ({ data: r }))
  })
} : null;

const TOKEN_PACKAGES = {
  tokens_10:  { tokens: 67,  priceNzd: 10, name: '67 BSMNT Tokens — $10 NZD' },
  tokens_25:  { tokens: 167, priceNzd: 25, name: '167 BSMNT Tokens — $25 NZD' },
  tokens_50:  { tokens: 334, priceNzd: 50, name: '334 BSMNT Tokens — $50 NZD' },
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

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => res.send('BSMNT OK'));
app.post('/create-checkout', handleCreateCheckout);
app.post('/generate-image',  handleGenerateImage);

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
        currency: 'nzd',
        product_data: { name: pkg.name, description: pkg.tokens + ' AI storyboard image credits' },
        unit_amount: pkg.priceNzd * 100,
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

async function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(500).send('Stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature failed:', e.message);
    return res.status(400).send('Webhook Error: ' + e.message);
  }

  if (event.type === 'checkout.session.completed') {
    const { agencyId, tokens } = event.data.object.metadata || {};
    if (agencyId && tokens) {
      const tokensToAdd = parseInt(tokens, 10);
      try {
        const { data: current } = await supabaseAdmin
          .from('agency_settings').select('agency_id,token_balance')
          .eq('agency_id', agencyId).maybeSingle();
        const newBalance = ((current && current.token_balance) || 0) + tokensToAdd;
        if (current) {
          await supabaseAdmin.from('agency_settings').update({ token_balance: newBalance }).eq('agency_id', agencyId);
        } else {
          await supabaseAdmin.from('agency_settings').insert({ agency_id: agencyId, token_balance: newBalance });
        }
        log('🪙', `Credited ${tokensToAdd} tokens to ${agencyId} (balance: ${newBalance})`);
      } catch (e) { console.error('Token credit failed:', e.message); }
    }
  }
  res.json({ received: true });
}

async function handleGenerateImage(req, res) {
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase not configured' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const { prompt, agencyId } = req.body;
    if (!prompt || !agencyId) return res.status(400).json({ error: 'prompt and agencyId required' });

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
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=' + process.env.GEMINI_API_KEY,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE','TEXT'] } }) }
    );

    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      console.error('Gemini API error', geminiRes.status, errBody.slice(0, 400));
      // Refund the token since generation failed
      await supaRest('POST', 'agency_settings', null, { agency_id: agencyId, token_balance: balance });
      return res.status(500).json({ error: 'Gemini error ' + geminiRes.status + ': ' + errBody.slice(0,200) });
    }

    const geminiData = await geminiRes.json();
    const imgPart = (geminiData?.candidates?.[0]?.content?.parts || [])
      .find(p => p.inlineData?.mimeType?.startsWith('image/'));

    if (!imgPart) {
      await supabaseAdmin.from('agency_settings').update({ token_balance: balance }).eq('agency_id', agencyId);
      return res.status(500).json({ error: 'No image returned from Gemini' });
    }

    log('🎬', `Generated image for ${agencyId} — ${newBalance} tokens remaining`);
    res.json({ imageUrl: 'data:' + imgPart.inlineData.mimeType + ';base64,' + imgPart.inlineData.data, tokenBalance: newBalance });
  } catch (e) {
    console.error('generate-image error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Email via Resend ──────────────────────────────────────────────────────────

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

function wrap(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>${BASE_STYLE}</style></head>
<body><div class="wrap">
  <div style="text-align:center;padding-bottom:24px;">
    <div style="display:inline-block;background:#7c6fff;border-radius:10px;width:40px;height:40px;line-height:40px;text-align:center;font-size:20px;font-weight:700;color:#fff;">B</div>
    <div style="font-size:18px;font-weight:700;color:#fff;margin-top:8px;">BSMNT</div>
    <div style="font-size:10px;color:#55556a;letter-spacing:1px;text-transform:uppercase;">Studio Management</div>
  </div>
  <div class="card"><div class="body">${body}</div>
  <div class="ftr">BSMNT Studio Management &middot; bsmnt.co.nz<br>You're receiving this as a member of your studio.</div>
  </div>
</div></body></html>`;
}

function weeklyEmail(user, { myProjects, completedThisWeek, hoursLastWeek, dueItems, overdueItems }) {
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
      <div class="slabel">Due This Week / Overdue</div>${dueRows}`),
  };
}

function assignmentEmail(user, project, byName) {
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
      <p style="font-size:13px;color:#8080a0;line-height:1.7;margin:0;">Log in to BSMNT to view the full brief, track your time, and check the run sheet.</p>`),
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
