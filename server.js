/**
 * BSMNT — Live Sync WebSocket Server
 * ────────────────────────────────────────
 * Server is the single source of truth for all app data.
 * Data is persisted to /data/data.json on Railway volume
 * (or ./data.json locally) so restarts never lose state.
 *
 * Requirements:  Node.js 16+
 * Install:       npm install ws
 * Run:           node server.js
 * Port:          8765  (override with WB_PORT env var)
 *
 * Railway env vars:
 *   RESEND_API_KEY  — your Resend API key
 *   WB_PORT         — optional port override
 *   ADMIN_EMAIL     — taylor@below.co.nz (for feedback notifications)
 *
 * Email features:
 *   - Weekly recap every Monday 8am NZT
 *   - Assignment notification when added to a project
 *   - Feedback reply when Taylor replies to a bug/feature
 *   - Feedback submitted notification to admin
 */

const { WebSocketServer, WebSocket } = require('ws');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const PORT = parseInt(process.env.PORT || process.env.WB_PORT || '8765', 10);
const DATA_DIR   = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname);
const DATA_FILE  = path.join(DATA_DIR, 'data.json');
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
           wbState:{}, templates:[], taskTemplates:{'Pre-Production':[],'Production':[],'Post Production':[]}, brand:{}, retainers:[], seeded:false };
}

const activeTimers = {};
let appState = loadState();
const clients = new Set();

// HTTP server handles Railway health checks + WebSocket upgrades on same port
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BSMNT OK');
});
const wss = new WebSocketServer({ server: httpServer, maxPayload: 5 * 1024 * 1024 }); // 5MB max message

function broadcast(payload, excludeSocket = null) {
  const msg = JSON.stringify(payload);
  for (const c of clients) {
    if (c !== excludeSocket && c.readyState === WebSocket.OPEN) c.send(msg);
  }
}
function sendSnapshot(socket) {
  // Strip legacy plaintext pin field — pinHash (SHA-256) is safe to send
  const safeUsers = (appState.users || []).map(u => {
    const { pin, ...rest } = u; // remove any legacy plaintext pin
    return rest; // pinHash stays — it's a one-way hash, safe across devices
  });
  const safeState = { ...appState, users: safeUsers };
  socket.send(JSON.stringify({ type:'snapshot', timers:Object.values(activeTimers), appState: safeState }));
}
function log(icon, msg) {
  console.log(`[${new Date().toTimeString().slice(0,8)}] ${icon}  ${msg}`);
}

// ── Email via Resend ──────────────────────────────────────────────────────────

function sendEmail({ to, subject, html }) {
  if (!RESEND_KEY) { log('✉', `[no key] Would send to ${to}: ${subject}`); return Promise.resolve(); }
  if (!to || !to.includes('@')) { log('✉', `Skipping — invalid address: ${to}`); return Promise.resolve(); }
  const body = JSON.stringify({ from: FROM_EMAIL, to, subject, html });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json',
                 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log('✉', `Sent to ${to} — ${subject}`);
          resolve({ ok:true });
        } else {
          log('✉', `Failed (${res.statusCode}) to ${to}: ${data}`);
          resolve({ ok:false, error:`HTTP ${res.statusCode}`, detail:data });
        }
      });
    });
    req.on('error', e => { log('✉', `Error: ${e.message}`); resolve({ ok:false, error:e.message }); });
    req.write(body); req.end();
  });
}

// ── Email templates ───────────────────────────────────────────────────────────

const BASE_STYLE = `
  body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#0c0c0e;margin:0;padding:40px 16px;color:#e0e0ec;}
  .wrap{max-width:560px;margin:0 auto;}
  /* Logo header */
  .hdr{text-align:center;padding-bottom:28px;}
  .logo-mark{display:inline-block;background:#7c6fff;border-radius:10px;width:40px;height:40px;line-height:40px;text-align:center;font-size:18px;font-weight:700;color:#fff;vertical-align:middle;margin-right:10px;}
  .logo-name{font-size:18px;font-weight:700;color:#fff;letter-spacing:-0.3px;vertical-align:middle;}
  .logo-sub{font-size:10px;color:#55556a;letter-spacing:1px;text-transform:uppercase;display:block;margin-top:2px;text-align:center;}
  /* Card */
  .card{background:#131316;border:1px solid #25252f;border-radius:16px;overflow:hidden;}
  .body{padding:36px 36px 32px;}
  h2{font-size:22px;font-weight:700;margin:0 0 6px;color:#fff;letter-spacing:-0.4px;}
  .sub{font-size:14px;color:#8080a0;margin:0 0 28px;line-height:1.6;}
  /* CTA button */
  .btn-wrap{text-align:center;margin:0 0 28px;}
  .btn{display:inline-block;background:#7c6fff;color:#fff;font-size:14px;font-weight:600;padding:13px 32px;border-radius:8px;text-decoration:none;letter-spacing:-0.1px;}
  /* Divider */
  .div{border:none;border-top:1px solid #25252f;margin:24px 0;}
  /* Section labels */
  .slabel{font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#55556a;margin:24px 0 10px;border-bottom:1px solid #25252f;padding-bottom:8px;}
  /* Project rows */
  .prow{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid #1e1e28;}
  .pname{font-size:13px;font-weight:600;color:#e0e0ec;} .pmeta{font-size:11px;color:#55556a;margin-top:2px;}
  /* Badges */
  .badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap;}
  .ok{background:rgba(52,211,153,0.12);color:#34d399;}
  .warn{background:rgba(251,191,36,0.12);color:#fbbf24;}
  .over{background:rgba(248,113,113,0.12);color:#f87171;}
  /* Stats row */
  .stats{display:flex;gap:10px;margin:0 0 24px;}
  .stat{background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:14px 16px;flex:1;text-align:center;}
  .sn{font-size:24px;font-weight:700;color:#7c6fff;letter-spacing:-0.5px;}
  .sl{font-size:10px;color:#55556a;margin-top:3px;text-transform:uppercase;letter-spacing:0.5px;}
  /* Due rows */
  .drow{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #1e1e28;}
  .dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
  /* Project card (assignment email) */
  .proj-card{background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:20px 22px;margin:20px 0;border-left:3px solid #7c6fff;}
  .proj-card-name{font-size:17px;font-weight:700;color:#fff;margin-bottom:5px;}
  .proj-card-client{font-size:12px;color:#55556a;}
  .proj-card-due{font-size:12px;color:#8080a0;margin-top:8px;}
  .proj-card-desc{font-size:13px;color:#8080a0;margin-top:12px;line-height:1.65;}
  /* Link fallback */
  .link-box{background:#0c0c0e;border:1px solid #25252f;border-radius:6px;padding:10px 12px;margin-top:12px;}
  .link-text{font-size:11px;color:#3a3a50;word-break:break-all;font-family:monospace;}
  .link-label{font-size:11px;color:#55556a;margin-bottom:6px;}
  /* Footer */
  .ftr{padding:20px 36px;text-align:center;font-size:11px;color:#3a3a50;line-height:1.8;border-top:1px solid #25252f;}
`;

function wrap(body) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <style>${BASE_STYLE}</style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAB8/UlEQVR42u39Z5Rl13Uein5zrrX3OZW6qyPQCN0IBIhIgiBAglHMYpQpyrayZFmyLNnXlrMth3uH7eE07vXwk209W8G0RZG0Aikxi0nMJAgiJyIQJHJqNDp3dVfVOWfvteZ8P+Zaa+9T3ZB974" width="48" height="48" alt="BSMNT" style="display:block;margin:0 auto 10px;width:48px;height:48px;border-radius:10px;"/>
      <div style="font-size:18px;font-weight:700;color:#fff;letter-spacing:-0.3px;text-align:center;">BSMNT</div>
      <div style="font-size:10px;color:#55556a;letter-spacing:1px;text-transform:uppercase;text-align:center;margin-top:2px;">Studio Management</div>
    </div>
    <div class="card">
      <div class="body">${body}</div>
      <div class="ftr">
        BSMNT Studio Management &middot; bsmnt.co.nz<br>
        You're receiving this as a member of your studio.
      </div>
    </div>
  </div>
</body>
</html>`;
}

function weeklyEmail(user, { myProjects, completedThisWeek, hoursLastWeek, dueItems, overdueItems }) {
  const dateLabel = new Date().toLocaleDateString('en-NZ', { day:'numeric', month:'long', year:'numeric' });
  const firstName = user.name.split(' ')[0];

  const projRows = myProjects.map(p => {
    const cls = p.budgetPct < 70 ? 'ok' : p.budgetPct < 100 ? 'warn' : 'over';
    const label = p.budgetPct < 70 ? 'On track' : p.budgetPct < 100 ? 'Watch budget' : 'Over budget';
    const dueFmt = p.endDate ? new Date(p.endDate + 'T12:00:00').toLocaleDateString('en-NZ', { day:'numeric', month:'short' }) : null;
    return `<div class="prow"><div><div class="pname">${p.name}</div>
      <div class="pmeta">${p.client}${dueFmt ? ' · Due ' + dueFmt : ''}</div></div>
      <span class="badge ${cls}">${label}</span></div>`;
  }).join('') || '<p style="font-size:13px;color:#55556a;padding:8px 0;">No active projects assigned to you.</p>';

  const allDue = [...overdueItems, ...dueItems];
  const dueRows = allDue.map(d => {
    const col = d.overdue ? '#f87171' : '#fbbf24';
    return `<div class="drow"><div class="dot" style="background:${col}"></div>
      <div style="flex:1"><div style="font-size:13px;font-weight:500;color:#e0e0ec">${d.name}</div>
      <div style="font-size:11px;color:#55556a">${d.type === 'project' ? 'Project' : 'Task'}</div></div>
      <span style="font-size:12px;font-weight:600;color:${col}">${d.overdue ? 'Overdue' : 'Due ' + d.dueLabel}</span></div>`;
  }).join('') || '<p style="font-size:13px;color:#55556a;padding:8px 0;">Nothing due this week 🎉</p>';

  return {
    subject: `Your BSMNT recap — ${dateLabel}`,
    html: wrap(`
      <h2>Morning, ${firstName} 👋</h2>
      <p class="sub">Your studio recap for the week of ${dateLabel}</p>
      <div class="stats">
        <div class="stat"><div class="sn">${hoursLastWeek.toFixed(1)}h</div><div class="sl">Hours logged</div></div>
        <div class="stat"><div class="sn">${myProjects.length}</div><div class="sl">Active projects</div></div>
        <div class="stat"><div class="sn" style="color:#34d399">${completedThisWeek}</div><div class="sl">Tasks done</div></div>
      </div>
      <div class="slabel">Your Active Projects</div>${projRows}
      <div class="slabel">Due This Week / Overdue</div>${dueRows}
    `),
  };
}

function assignmentEmail(user, project, byName) {
  const firstName = (user.name || 'there').split(' ')[0];
  const dueFmt = project.endDate ? new Date(project.endDate + 'T12:00:00').toLocaleDateString('en-NZ', { day:'numeric', month:'long', year:'numeric' }) : null;
  return {
    subject: `You've been added to "${project.name}"`,
    html: wrap(`
      <h2>You're on a new project</h2>
      <p class="sub">${byName} has assigned you to a project. Here's what you need to know.</p>
      <div class="proj-card">
        <div class="proj-card-name">${project.name}</div>
        ${project.client ? `<div class="proj-card-client">${project.client}</div>` : ''}
        ${dueFmt ? `<div class="proj-card-due">📅 Due ${dueFmt}</div>` : ''}
        ${project.description ? `<div class="proj-card-desc">${project.description}</div>` : ''}
      </div>
      <p style="font-size:13px;color:#8080a0;line-height:1.7;margin:0;">
        Log in to BSMNT to view the full brief, track your time, and check the run sheet.
      </p>
    `),
  };
}

// ── Weekly recap scheduler ────────────────────────────────────────────────────

function msUntilNextMondayNZT() {
  // NZT is UTC+12 (close enough for weekly scheduling)
  const NZT = 12 * 3600000;
  const nowNzt = new Date(Date.now() + NZT);
  const day  = nowNzt.getUTCDay(); // 0=Sun 1=Mon
  const hour = nowNzt.getUTCHours();
  let daysToMonday = (1 - day + 7) % 7;
  if (daysToMonday === 0 && hour >= 8) daysToMonday = 7;
  const nowSecs = nowNzt.getUTCHours() * 3600 + nowNzt.getUTCMinutes() * 60 + nowNzt.getUTCSeconds();
  const target8am = 8 * 3600;
  const secsToday = daysToMonday === 0 ? (target8am - nowSecs) : (86400 - nowSecs + target8am + (daysToMonday - 1) * 86400);
  return secsToday * 1000;
}

function calcBudgetPct(p) {
  const budgetEntries = (p.budgetEntries || []).reduce((s, e) => s + (e.amount || 0), 0);
  const billed = (p.timeLog || []).reduce((s, l) => {
    const u = (appState.users || []).find(u => String(u.id) === String(l.user));
    return s + (l.hours * (u ? u.chargeRate || 0 : 0));
  }, 0);
  const total = billed + (p.hardCosts || 0) + budgetEntries;
  return p.budget > 0 ? Math.round(total / p.budget * 100) : 0;
}

function sendWeeklyRecaps() {
  if (!appState.seeded || !appState.users.length) {
    log('✉', 'Recap skipped — no data'); return;
  }

  const now = new Date();
  const lastMonday = new Date(now); lastMonday.setDate(now.getDate() - 7); lastMonday.setHours(0,0,0,0);
  const lastSunday = new Date(now); lastSunday.setDate(now.getDate() - 1); lastSunday.setHours(23,59,59,999);
  const nextWeekEnd = new Date(now); nextWeekEnd.setDate(now.getDate() + 7); nextWeekEnd.setHours(23,59,59,999);

  const inLastWeek = d => { if (!d) return false; const x = new Date(d+'T00:00:00'); return x >= lastMonday && x <= lastSunday; };

  const activeProjects = (appState.projects || []).filter(p => p.status !== 'upcoming');

  // Build due/overdue lists
  const overdueItems = [], dueItems = [];
  activeProjects.forEach(p => {
    if (!p.endDate) return;
    const d = new Date(p.endDate + 'T23:59:59');
    if (d < now) { overdueItems.push({ name: p.name, type: 'project', overdue: true, dueLabel: p.endDate }); }
    else if (d <= nextWeekEnd) {
      const diff = Math.ceil((d - now) / 86400000);
      dueItems.push({ name: p.name, type: 'project', overdue: false,
        dueLabel: diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : `in ${diff} days` });
    }
  });
  (appState.tasks || []).filter(t => !t.done && t.dueDate).forEach(t => {
    const d = new Date(t.dueDate + 'T23:59:59');
    if (d < now) { overdueItems.push({ name: t.name, type: 'task', overdue: true, dueLabel: t.dueDate }); }
    else if (d <= nextWeekEnd) {
      const diff = Math.ceil((d - now) / 86400000);
      dueItems.push({ name: t.name, type: 'task', overdue: false,
        dueLabel: diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : `in ${diff} days` });
    }
  });

  const recipients = (appState.users || []).filter(u => u.active !== false && u.emailWeekly !== false && u.email && u.email.includes('@'));
  log('✉', `Sending weekly recaps to ${recipients.length} users: ${recipients.map(u => u.email).join(', ')}`);

  recipients.forEach((user, idx) => {
    const hoursLastWeek = activeProjects.reduce((s, p) =>
      s + (p.timeLog || []).filter(l => String(l.user) === String(user.id) && inLastWeek(l.date))
        .reduce((t, l) => t + l.hours, 0), 0);

    const completedThisWeek = (appState.tasks || []).filter(t => t.done && inLastWeek(t.completedAt)).length;

    const myProjects = activeProjects
      .filter(p => (p.assigned || []).map(String).includes(String(user.id)))
      .map(p => {
        const cl = (appState.clients || []).find(c => c.id === p.clientId);
        return { name: p.name, client: cl ? cl.name : '', endDate: p.endDate, budgetPct: calcBudgetPct(p) };
      });

    const { subject, html } = weeklyEmail(user, { myProjects, completedThisWeek, hoursLastWeek, dueItems, overdueItems });
    setTimeout(() => sendEmail({ to: user.email, subject, html }), idx * 600);
  });
}

function scheduleWeeklyRecap() {
  const ms = msUntilNextMondayNZT();
  log('✉', `Weekly recap in ~${Math.round(ms/3600000)}h`);
  setTimeout(() => { sendWeeklyRecaps(); scheduleWeeklyRecap();
scheduleRetainerCheck(); }, ms);
}

// ── Assignment notifications ──────────────────────────────────────────────────

function notifyAssignments(newProjects, prevProjects, triggerName) {
  if (!Array.isArray(newProjects)) return;
  newProjects.forEach(newP => {
    const oldP = (prevProjects || []).find(p => String(p.id) === String(newP.id));
    const oldIds = (oldP ? oldP.assigned || [] : []).map(String);
    const newIds = (newP.assigned || []).map(String);
    const added = newIds.filter(id => !oldIds.includes(id));
    log('🔍', `Assignment check "${newP.name}": old=[${oldIds}] new=[${newIds}] added=[${added}]`);
    if (!added.length) return;

    const cl = (appState.clients || []).find(c => c.id === newP.clientId);
    const proj = { name: newP.name, client: cl ? cl.name : '', endDate: newP.endDate, description: newP.description };

    added.forEach(uid => {
      const user = (appState.users || []).find(u => String(u.id) === uid);
      if (!user) { log('⚠', `Assignment: no user found for uid=${uid} (users: ${(appState.users||[]).map(u=>String(u.id)).join(',')})`); return; }
      if (!user.email || !user.email.includes('@')) { log('⚠', `Assignment: user ${user.name} has no valid email (${user.email})`); return; }
      if (user.emailAssign === false) { log('✉', `Assignment: ${user.name} has opted out of assignment emails`); return; }
      const { subject, html } = assignmentEmail(user, proj, triggerName || 'Someone');
      log('✉', `Assignment email → ${user.email} for "${newP.name}"`);
      sendEmail({ to: user.email, subject, html });
    });
  });
}

// ── Connection handler ────────────────────────────────────────────────────────

wss.on('connection', socket => {
  clients.add(socket);
  log('+', `Client connected (total: ${clients.size})`);
  log('🔑', `RESEND_API_KEY: ${RESEND_KEY ? 'SET (' + RESEND_KEY.slice(0,8) + '...)' : 'NOT SET — emails will not send'}`);
  // Rate limit app_sync to prevent disk hammering
  socket._lastSync = 0;
  socket._syncCount = 0;
  sendSnapshot(socket);

  socket.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'timer_start': {
        const { userId, userName, userColor, userInitials, projectId, projectName, taskId, phase } = msg;
        if (!userId) return;
        activeTimers[String(userId)] = { userId, userName, userColor, userInitials, projectId, projectName, taskId, phase, startedAt: new Date().toISOString() };
        broadcast({ type: 'timer_start', timer: activeTimers[String(userId)] }, socket);
        log('▶', `${userName} started timer on "${projectName}"`);
        break;
      }

      case 'timer_stop': {
        const { userId } = msg;
        if (!userId) return;
        const timer = activeTimers[String(userId)];
        delete activeTimers[String(userId)];
        broadcast({ type: 'timer_stop', userId, timer }, socket);
        if (timer) log('■', `${timer.userName} stopped timer`);
        break;
      }

      case 'app_sync': {
        // Rate limit: max 2 syncs per second per socket to prevent disk hammering
        const now = Date.now();
        if (now - (socket._lastSync || 0) < 500) {
          socket._syncCount = (socket._syncCount || 0) + 1;
          if (socket._syncCount > 5) {
            log('⚠', `Rate limit: app_sync throttled`);
            break;
          }
        } else {
          socket._syncCount = 0;
        }
        socket._lastSync = now;

        const { projects, clients: cls, users, archived, tasks, wbState, templates, brand, userName } = msg;
        // Snapshot BEFORE updating so we can diff for assignment changes
        const prevProjects = JSON.parse(JSON.stringify(appState.projects || []));

        if (projects  !== undefined) appState.projects  = projects;
        if (cls       !== undefined) appState.clients   = cls;
        if (users     !== undefined) {
          const merged = users.map(incoming => {
            const { pin, ...rest } = incoming;
            return rest;
          });
          appState.users = merged;
        }
        if (archived  !== undefined) appState.archived  = archived;
        if (tasks     !== undefined) appState.tasks     = tasks;
        if (wbState   !== undefined) appState.wbState   = wbState;
        if (templates !== undefined) appState.templates = templates;
        if (msg.taskTemplates !== undefined) appState.taskTemplates = msg.taskTemplates;
        if (msg.businessCosts !== undefined) appState.businessCosts = msg.businessCosts;
        if (msg.retainers !== undefined) appState.retainers = msg.retainers;
        if (brand     !== undefined) appState.brand     = brand;
        appState.seeded = true;
        scheduleSave();

        broadcast({ type: 'app_sync', appState, triggeredBy: userName || '?' }, socket);
        log('🔄', `State updated by ${userName || 'unknown'}`);

        // Fire assignment emails
        if (projects !== undefined) notifyAssignments(projects, prevProjects, userName);
        break;
      }

      case 'wb_sync': {
        appState.wbState = msg.wbState || appState.wbState;
        appState.seeded = true; scheduleSave();
        broadcast({ type: 'wb_sync', wbState: appState.wbState, triggeredBy: msg.userName || '?' }, socket);
        break;
      }

      case 'tasks_sync': {
        appState.tasks = msg.tasks || appState.tasks;
        appState.seeded = true; scheduleSave();
        broadcast({ type: 'tasks_sync', tasks: appState.tasks, triggeredBy: msg.userName || '?' }, socket);
        break;
      }

      case 'ping': { sendSnapshot(socket); break; }

      case 'test_email': {
        const to = msg.to;
        console.log('[TEST EMAIL] Received request to:', to, '| RESEND_KEY set:', !!RESEND_KEY, '| Key prefix:', RESEND_KEY ? RESEND_KEY.slice(0,8) : 'NONE');
        if (!to || !to.includes('@')) {
          socket.send(JSON.stringify({ type:'email_result', ok:false, error:'No valid email address provided.' }));
          break;
        }
        if (!RESEND_KEY) {
          socket.send(JSON.stringify({ type:'email_result', ok:false, to, error:'RESEND_API_KEY is not set on the server. Add it in Railway → Variables.' }));
          break;
        }
        const html = wrap(`
          <h2>Test email ✓</h2>
          <p class="sub">If you're reading this, BSMNT emails are working correctly.</p>
          <div style="background:#f8f8fc;border-radius:10px;padding:20px 24px;margin:20px 0;border-left:4px solid #7c6fff;">
            <div style="font-size:13px;color:#555;">From: ${FROM_EMAIL}</div>
            <div style="font-size:13px;color:#555;">Sent: ${new Date().toISOString()}</div>
            <div style="font-size:13px;color:#555;">Key: ${RESEND_KEY.slice(0,12)}...</div>
          </div>
        `);
        sendEmail({ to, subject: '✅ BSMNT — email test', html })
          .then(result => {
            socket.send(JSON.stringify({
              type: 'email_result',
              ok: result.ok,
              to,
              error: result.error || null,
              detail: result.detail || null,
            }));
          });
        log('✉', `Test email requested by ${msg.userName || '?'} → ${to}`);
        break;
      }

      case 'send_recap_now': {
        log('✉', `Manual weekly recap triggered by ${msg.userName || '?'}`);
        const users = (appState.users || []).filter(u => u.active !== false);
        const withEmail = users.filter(u => u.email && u.email.includes('@'));
        const skipped = users.length - withEmail.length;
        try {
          sendWeeklyRecaps();
          socket.send(JSON.stringify({ type:'recap_result', ok:true, count:withEmail.length, skipped }));
        } catch(e) {
          socket.send(JSON.stringify({ type:'recap_result', ok:false, error:e.message }));
        }
        break;
      }

      // ── NEW: feedback_reply ─────────────────────────────────────────────────
      // Fired when Taylor hits Send Reply on a bug/feature in the platform overview
      case 'feedback_reply': {
        const { feedbackId, userEmail, subject, replyText, senderName } = msg;
        if (!userEmail || !userEmail.includes('@')) {
          log('✉', `feedback_reply skipped — no valid email address`);
          break;
        }
        if (!RESEND_KEY) {
          log('✉', `feedback_reply skipped — no RESEND_API_KEY`);
          break;
        }
        if (!replyText || !replyText.trim()) {
          log('✉', `feedback_reply skipped — empty reply text`);
          break;
        }
        const replyHtml = wrap(`
          <h2>✉ Reply to your feedback</h2>
          <p class="sub">Re: <strong>${subject || 'your feedback'}</strong></p>
          <div style="background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:20px 24px;margin:20px 0;border-left:3px solid #7c6fff;">
            <div style="font-size:14px;color:#e0e0ec;line-height:1.75;white-space:pre-wrap;">${replyText.trim()}</div>
          </div>
          <p style="font-size:13px;color:#8080a0;margin:0;">— ${senderName || 'The BSMNT team'}</p>
        `);
        sendEmail({
          to: userEmail,
          subject: subject || 'Re: your feedback',
          html: replyHtml,
        });
        log('✉', `Feedback reply → ${userEmail} (feedback: ${feedbackId})`);
        break;
      }

      // ── NEW: project_assigned ───────────────────────────────────────────────
      // Fired directly from the front-end when someone is added to a project.
      // The app_sync path also handles this via notifyAssignments(), but this
      // handles cases where the front-end sends an explicit notification.
      case 'project_assigned': {
        const { to, userName, projectName, assignedBy } = msg;
        if (!to || !to.includes('@') || !RESEND_KEY) break;
        // Try to find the full project for a richer email
        const proj = (appState.projects || []).find(p => p.name === projectName);
        const user = (appState.users || []).find(u => u.email === to) || { name: userName };
        if (proj) {
          const cl = (appState.clients || []).find(c => c.id === proj.clientId);
          const projData = { name: proj.name, client: cl ? cl.name : '', endDate: proj.endDate, description: proj.description };
          const { subject, html } = assignmentEmail(user, projData, assignedBy || 'Someone');
          sendEmail({ to, subject, html });
        } else {
          // Fallback if project not yet in server state
          const fallbackHtml = wrap(`
            <h2>You're on a new project</h2>
            <p class="sub">${assignedBy || 'Someone'} has added you to <strong>${projectName}</strong>.</p>
            <p style="font-size:13px;color:#8080a0;line-height:1.7;margin:0;">
              Log in to BSMNT to view the full brief, track your time, and check the run sheet.
            </p>
          `);
          sendEmail({ to, subject: `You've been added to "${projectName}"`, html: fallbackHtml });
        }
        log('✉', `project_assigned email → ${to} for "${projectName}"`);
        break;
      }

      case 'feedback_submitted': {
        const fb = msg.entry || {};
        log('💬', `Feedback from ${fb.user_name || '?'}: [${fb.type}] ${fb.subject}`);
        const adminEmail = process.env.ADMIN_EMAIL || '';
        if(adminEmail && adminEmail.includes('@') && RESEND_KEY) {
          const typeEmoji = {bug:'🐛',feature:'💡',general:'💬'}[fb.type]||'💬';
          const html = wrap(`
            <h2>${typeEmoji} New ${fb.type} feedback</h2>
            <p class="sub">From <strong>${fb.user_name||'Unknown'}</strong> (${fb.user_email||'no email'}) on ${fb.page||'unknown page'}</p>
            <div style="background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:20px 24px;margin:20px 0;border-left:4px solid #7c6fff;">
              <div style="font-size:15px;font-weight:600;color:#fff;margin-bottom:8px;">${fb.subject||'(no subject)'}</div>
              <div style="font-size:14px;color:#8080a0;line-height:1.7;white-space:pre-wrap;">${fb.message||''}</div>
            </div>
            <p style="font-size:12px;color:#55556a;">Submitted ${new Date(fb.created_at||Date.now()).toLocaleString()} · Status: new</p>
          `);
          sendEmail({ to: adminEmail, subject: `${typeEmoji} [${fb.type}] ${fb.subject||'Feedback'}`, html });
        }
        break;
      }

      case 'feedback_status_update': {
        const { to, subject, status, userName, customMessage } = msg;
        if(!to || !to.includes('@') || !RESEND_KEY) break;
        const statusMsg = customMessage || {
          reviewing: "We're looking into this and will keep you posted.",
          shipped: "Great news — this has been shipped! Update your app to see it.",
          closed: "We've reviewed this and closed it out. Thanks for taking the time.",
        }[status] || `Status updated to: ${status}`;
        const accentColor = status==='shipped'?'#34d399':status==='reviewing'?'#fbbf24':'#7c6fff';
        const html = wrap(`
          <h2>${customMessage ? 'Reply to your feedback' : 'Update on your feedback'}</h2>
          <p class="sub">Re: <strong>${subject||'your feedback'}</strong></p>
          <div style="background:#0c0c0e;border:1px solid #25252f;border-radius:10px;padding:20px 24px;margin:20px 0;border-left:4px solid ${accentColor};">
            <div style="font-size:14px;color:#e0e0ec;line-height:1.75;white-space:pre-wrap;">${statusMsg}</div>
          </div>
          <p style="font-size:13px;color:#8080a0;">— ${userName||'The team'}</p>
        `);
        sendEmail({ to, subject: `Re: ${subject||'your feedback'}`, html });
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
  const retainers = appState.retainers || [];
  if (!retainers.length) return;

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const dayOfMonth = now.getUTCDate();
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthLabel = monthNames[now.getUTCMonth()];
  const year = now.getUTCFullYear();

  let spawned = 0;
  retainers.forEach(r => {
    if (r.active === false) return;

    let shouldSpawn = false;
    const targetDay = r.dayOfMonth || 1;

    if (r.frequency === 'monthly' && dayOfMonth === targetDay) shouldSpawn = true;
    if (r.frequency === 'fortnightly') {
      if (dayOfMonth === targetDay || dayOfMonth === ((targetDay + 13) % 28) + 1) shouldSpawn = true;
    }
    if (r.frequency === 'weekly') {
      const diff = (dayOfMonth - targetDay + 28) % 7;
      if (diff === 0) shouldSpawn = true;
    }

    if (!shouldSpawn) return;

    if (r.lastSpawned && r.lastSpawned.startsWith(todayStr.slice(0, 7))) {
      log('📅', `Retainer "${r.name}" already spawned this month (${r.lastSpawned})`);
      return;
    }

    const lastDay = new Date(year, now.getUTCMonth() + 1, 0);
    const endDate = lastDay.toISOString().split('T')[0];
    const phaseMap = {preproduction:'Pre-Production', production:'Production', postproduction:'Post Production'};
    const project = {
      id: Date.now() + Math.floor(Math.random() * 10000),
      name: `${r.name} — ${monthLabel} ${year}`,
      clientId: r.clientId,
      status: r.status || 'preproduction',
      phase: phaseMap[r.status] || 'Pre-Production',
      budget: r.budget || 0,
      shootBudget: 0, editBudget: 0,
      budgetSpent: {shoot:0, edit:0},
      hardCosts: 0,
      startDate: todayStr,
      endDate,
      description: r.description || '',
      assigned: r.assigned || [],
      stages: [
        {id:'s1', name:'Pre-Production', tasks:[]},
        {id:'s2', name:'Production', tasks:[]},
        {id:'s3', name:'Post Production', tasks:[]},
      ],
      shotList:[], timeLog:[], budgetEntries:[], deliverables:[],
      retainerId: r.id,
    };

    appState.projects.push(project);
    r.lastSpawned = todayStr;
    spawned++;

    log('📅', `Spawned retainer project: "${project.name}"`);
    broadcast({ type: 'recurring_spawn', project, retainerId: r.id });
  });

  if (spawned > 0) scheduleSave();
}

function scheduleRetainerCheck() {
  const NZT = 12 * 3600000;
  const nowNzt = new Date(Date.now() + NZT);
  const secsNow = nowNzt.getUTCHours() * 3600 + nowNzt.getUTCMinutes() * 60 + nowNzt.getUTCSeconds();
  const target7am = 7 * 3600;
  let secsUntil = target7am - secsNow;
  if (secsUntil < 0) secsUntil += 86400;
  log('📅', `Retainer check in ~${Math.round(secsUntil/3600)}h`);
  setTimeout(() => {
    spawnRetainerProjects();
    scheduleRetainerCheck();
  }, secsUntil * 1000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\nBSMNT sync server · port ${PORT}`);
  console.log(`Persistence: ${DATA_FILE}`);
  console.log(`State seeded: ${appState.seeded}`);
  console.log(`Resend: ${RESEND_KEY ? 'configured ✓' : 'NO API KEY — emails disabled'}\n`);
});

scheduleWeeklyRecap();
