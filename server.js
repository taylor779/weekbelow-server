/**
 * Week Below — Live Sync WebSocket Server
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
 * Railway setup:
 *   1. Upgrade to Hobby ($5/mo)
 *   2. Service → Volumes → New Volume → mount at /data
 *   That's it — data.json persists across all restarts.
 */

const { WebSocketServer, WebSocket } = require('ws');
const fs   = require('fs');
const path = require('path');

const PORT      = parseInt(process.env.WB_PORT || '8765', 10);
const DATA_DIR  = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname);
const DATA_FILE = path.join(DATA_DIR, 'data.json');

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
  } catch (e) {
    console.error('Failed to load state:', e.message);
  }
  return defaultAppState();
}

function scheduleSave() {
  // Debounce — write at most once per 2s to avoid hammering disk
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(appState, null, 2));
    } catch (e) {
      console.error('Failed to save state:', e.message);
    }
  }, 2000);
}

function defaultAppState() {
  return {
    projects:  [],
    clients:   [],
    users:     [],
    archived:  [],
    tasks:     [],
    wbState:   {},
    templates: [],
    brand:     {},
    seeded:    false,
  };
}

// ── Server state ──────────────────────────────────────────────────────────────

const activeTimers = {};
let appState = loadState();

// ── Helpers ───────────────────────────────────────────────────────────────────

const clients = new Set();
const wss = new WebSocketServer({ port: PORT });

function broadcast(payload, excludeSocket = null) {
  const msg = JSON.stringify(payload);
  for (const client of clients) {
    if (client !== excludeSocket && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function sendSnapshot(socket) {
  socket.send(JSON.stringify({
    type:     'snapshot',
    timers:   Object.values(activeTimers),
    appState,
  }));
}

function log(icon, msg) {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`[${time}] ${icon}  ${msg}`);
}

// ── Connection handler ────────────────────────────────────────────────────────

wss.on('connection', (socket) => {
  clients.add(socket);
  log('+', `Client connected  (total: ${clients.size})`);
  sendSnapshot(socket);

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'timer_start': {
        const { userId, userName, userColor, userInitials,
                projectId, projectName, phase } = msg;
        if (!userId) return;
        activeTimers[String(userId)] = {
          userId, userName, userColor, userInitials,
          projectId, projectName, phase,
          startedAt: new Date().toISOString(),
        };
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
        const { projects, clients: cls, users, archived, tasks, wbState, templates, brand, userName } = msg;
        if (projects  !== undefined) appState.projects  = projects;
        if (cls       !== undefined) appState.clients   = cls;
        if (users     !== undefined) appState.users     = users;
        if (archived  !== undefined) appState.archived  = archived;
        if (tasks     !== undefined) appState.tasks     = tasks;
        if (wbState   !== undefined) appState.wbState   = wbState;
        if (templates !== undefined) appState.templates = templates;
        if (brand     !== undefined) appState.brand     = brand;
        appState.seeded = true;
        scheduleSave();
        broadcast({ type: 'app_sync', appState, triggeredBy: userName || '?' }, socket);
        log('🔄', `State updated by ${userName || 'unknown'}`);
        break;
      }

      // Legacy compat
      case 'wb_sync': {
        appState.wbState = msg.wbState || appState.wbState;
        appState.seeded = true;
        scheduleSave();
        broadcast({ type: 'wb_sync', wbState: appState.wbState, triggeredBy: msg.userName || '?' }, socket);
        break;
      }

      case 'tasks_sync': {
        appState.tasks = msg.tasks || appState.tasks;
        appState.seeded = true;
        scheduleSave();
        broadcast({ type: 'tasks_sync', tasks: appState.tasks, triggeredBy: msg.userName || '?' }, socket);
        break;
      }

      case 'ping': {
        sendSnapshot(socket);
        break;
      }
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
    log('-', `Client disconnected (total: ${clients.size})`);
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
    clients.delete(socket);
  });
});

console.log(`\nWeek Below sync server · ws://localhost:${PORT}`);
console.log(`Persistence: ${DATA_FILE}`);
console.log(`State seeded: ${appState.seeded}\n`);
