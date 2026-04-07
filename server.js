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
 *
 * Email features:
 *   - Weekly recap every Monday 8am NZT
 *   - Assignment notification when added to a project
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
const FROM_EMAIL = 'BSMNT <onboarding@resend.dev>';

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
           wbState:{}, templates:[], taskTemplates:{'Pre-Production':[],'Production':[],'Post Production':[]}, brand:{}, seeded:false };
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
  body{font-family:Arial,sans-serif;background:#f4f4f8;margin:0;padding:32px 16px;color:#111;}
  .card{background:#fff;border-radius:12px;max-width:600px;margin:0 auto;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);}
  .hdr{background:#111;padding:24px 32px;} .logo{font-size:18px;font-weight:600;color:#fff;}
  .logo span{color:#7c6fff;} .body{padding:32px;}
  h2{font-size:20px;font-weight:600;margin:0 0 4px;} .sub{font-size:13px;color:#777;margin:0 0 24px;}
  .slabel{font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;
          margin:24px 0 10px;border-bottom:1px solid #eee;padding-bottom:6px;}
  .prow{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;}
  .pname{font-size:14px;font-weight:500;} .pmeta{font-size:12px;color:#777;margin-top:2px;}
  .badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;}
  .ok{background:#e8faf3;color:#0d6f44;} .warn{background:#fff8e6;color:#92610a;}
  .over{background:#fef0f0;color:#c0392b;}
  .stats{display:flex;gap:14px;margin:16px 0;}
  .stat{background:#f8f8fc;border-radius:8px;padding:14px 18px;flex:1;text-align:center;}
  .sn{font-size:26px;font-weight:600;color:#7c6fff;} .sl{font-size:11px;color:#777;margin-top:3px;}
  .drow{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #f0f0f0;}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
  .proj-card{background:#f8f8fc;border-radius:10px;padding:20px 24px;margin:20px 0;border-left:4px solid #7c6fff;}
  .ftr{padding:20px 32px;background:#f8f8fc;text-align:center;font-size:11px;color:#aaa;}
`;

function wrap(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${BASE_STYLE}</style></head><body>
<div class="card">
  <div class="hdr"><div class="logo">Week <span>Below</span></div></div>
  <div class="body">${body}</div>
  <div class="ftr">BSMNT · Built from Below<br>You're receiving this as part of the team.</div>
</div></body></html>`;
}

function weeklyEmail(user, { myProjects, completedThisWeek, hoursLastWeek, dueItems, overdueItems }) {
  const dateLabel = new Date().toLocaleDateString('en-NZ', { day:'numeric', month:'long', year:'numeric' });
  const firstName = user.name.split(' ')[0];

  const projRows = myProjects.map(p => {
    const cls = p.budgetPct < 70 ? 'ok' : p.budgetPct < 100 ? 'warn' : 'over';
    const label = p.budgetPct < 70 ? 'On track' : p.budgetPct < 100 ? 'Watch budget' : 'Over budget';
    return `<div class="prow"><div><div class="pname">${p.name}</div>
      <div class="pmeta">${p.client}${p.endDate ? ' · Due ' + p.endDate : ''}</div></div>
      <span class="badge ${cls}">${label}</span></div>`;
  }).join('') || '<p style="color:#aaa;font-size:13px;">No active projects assigned to you.</p>';

  const allDue = [...overdueItems, ...dueItems];
  const dueRows = allDue.map(d => {
    const col = d.overdue ? '#e74c3c' : '#f39c12';
    return `<div class="drow"><div class="dot" style="background:${col}"></div>
      <div style="flex:1"><div style="font-size:13px;font-weight:500">${d.name}</div>
      <div style="font-size:11px;color:#777">${d.type === 'project' ? 'Project' : 'Task'}</div></div>
      <span style="font-size:12px;font-weight:600;color:${col}">${d.overdue ? 'Overdue' : 'Due ' + d.dueLabel}</span></div>`;
  }).join('') || '<p style="color:#aaa;font-size:13px;">Nothing due this week 🎉</p>';

  return {
    subject: `📋 Your BSMNT recap — ${dateLabel}`,
    html: wrap(`
      <h2>Good morning, ${firstName} 👋</h2>
      <p class="sub">Your BSMNT recap for the week of ${dateLabel}</p>
      <div class="stats">
        <div class="stat"><div class="sn">${hoursLastWeek.toFixed(1)}h</div><div class="sl">Hours last week</div></div>
        <div class="stat"><div class="sn">${myProjects.length}</div><div class="sl">Active projects</div></div>
        <div class="stat"><div class="sn" style="color:#27ae60">${completedThisWeek}</div><div class="sl">Tasks completed</div></div>
      </div>
      <div class="slabel">Your Active Projects</div>${projRows}
      <div class="slabel">Due This Week / Overdue</div>${dueRows}
    `),
  };
}

function assignmentEmail(user, project, byName) {
  return {
    subject: `🎬 You've been added to "${project.name}"`,
    html: wrap(`
      <h2>You've been added to a project</h2>
      <p class="sub">${byName} has assigned you to a project in BSMNT.</p>
      <div class="proj-card">
        <div style="font-size:18px;font-weight:600;margin-bottom:6px">${project.name}</div>
        ${project.client ? `<div style="font-size:13px;color:#777">${project.client}</div>` : ''}
        ${project.endDate ? `<div style="font-size:12px;color:#999;margin-top:8px">📅 Due ${project.endDate}</div>` : ''}
        ${project.description ? `<div style="font-size:13px;color:#555;margin-top:12px;line-height:1.65">${project.description}</div>` : ''}
      </div>
      <p style="font-size:13px;color:#555;line-height:1.7">
        Log in to BSMNT to view the project, track your time, and check the run sheet.
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

  const recipients = (appState.users || []).filter(u => u.active !== false && u.email && u.email.includes('@') && !u.email.includes('@weekbelow.com'));
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
  setTimeout(() => { sendWeeklyRecaps(); scheduleWeeklyRecap(); }, ms);
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
      if (!user || !user.email || !user.email.includes('@')) return;
      // Note: we DO email self-assignments — if you assign yourself, you should still get the confirmation
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
          // Merge users — client sends pinHash (SHA-256), preserve it
          // Strip any legacy plaintext pin field for security
          const merged = users.map(incoming => {
            const { pin, ...rest } = incoming; // strip legacy plaintext
            return rest; // pinHash is included and safe
          });
          appState.users = merged;
        }
        if (archived  !== undefined) appState.archived  = archived;
        if (tasks     !== undefined) appState.tasks     = tasks;
        if (wbState   !== undefined) appState.wbState   = wbState;
        if (templates !== undefined) appState.templates = templates;
        if (msg.taskTemplates !== undefined) appState.taskTemplates = msg.taskTemplates;
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
        const withEmail = users.filter(u => u.email && u.email.includes('@') && !u.email.includes('@weekbelow.com'));
        const skipped = users.length - withEmail.length;
        try {
          sendWeeklyRecaps();
          socket.send(JSON.stringify({ type:'recap_result', ok:true, count:withEmail.length, skipped }));
        } catch(e) {
          socket.send(JSON.stringify({ type:'recap_result', ok:false, error:e.message }));
        }
        break;
      }
    }
  });

  socket.on('close', () => { clients.delete(socket); log('-', `Client disconnected (total: ${clients.size})`); });
  socket.on('error', err => { console.error('Socket error:', err.message); clients.delete(socket); });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

// ── HTTP server (test endpoints) ─────────────────────────────────────────────

// ── Boot ──────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\nBSMNT sync server · port ${PORT}`);
  console.log(`Persistence: ${DATA_FILE}`);
  console.log(`State seeded: ${appState.seeded}`);
  console.log(`Resend: ${RESEND_KEY ? 'configured ✓' : 'NO API KEY — emails disabled'}\n`);
});

scheduleWeeklyRecap();
