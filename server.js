/**
 * Week Below — Live Sync WebSocket Server
 * ────────────────────────────────────────
 * Handles real-time sync for:
 *   • Active timers    (timer_start / timer_stop)
 *   • Whiteboard state (wb_sync)
 *   • Tasks            (tasks_sync)
 *
 * Requirements:  Node.js 16+
 * Install:       npm install ws
 * Run:           node server.js
 * Port:          8765  (override with WB_PORT env var)
 *
 * Every connected client gets a full snapshot on connect.
 * All mutations are last-write-wins — server stores latest state
 * and broadcasts to every other client immediately.
 */

const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.WB_PORT || '8765', 10);
const wss  = new WebSocketServer({ port: PORT });

// ── Server state ─────────────────────────────────────────────────────────────

/** Active timers: { [userId]: { userId, userName, userColor, userInitials, projectId, projectName, phase, startedAt } } */
const activeTimers = {};

/** Whiteboard assignment state: { [projOrTaskId]: { userId, stage, split[] } } */
let wbState = {};

/** Tasks array — full task objects synced from clients */
let tasks = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

const clients = new Set();

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
    type:    'snapshot',
    timers:  Object.values(activeTimers),
    wbState,
    tasks,
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

  // Give new client the full current state immediately
  sendSnapshot(socket);

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── TIMERS ────────────────────────────────────────────────────────────

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

      // ── WHITEBOARD ───────────────────────────────────────────────────────

      case 'wb_sync': {
        wbState = msg.wbState || wbState;
        broadcast({ type: 'wb_sync', wbState, triggeredBy: msg.userName || '?' }, socket);
        log('🗂', `Whiteboard updated by ${msg.userName || 'unknown'}`);
        break;
      }

      // ── TASKS ────────────────────────────────────────────────────────────

      case 'tasks_sync': {
        tasks = msg.tasks || tasks;
        broadcast({ type: 'tasks_sync', tasks, triggeredBy: msg.userName || '?' }, socket);
        log('✅', `Tasks updated by ${msg.userName || 'unknown'} (${tasks.length} total)`);
        break;
      }

      // ── UTILITY ──────────────────────────────────────────────────────────

      case 'ping': {
        sendSnapshot(socket);
        break;
      }

      default:
        break;
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

console.log(`\nWeek Below sync server running on ws://localhost:${PORT}`);
console.log('Handles: timers · whiteboard · tasks\n');
