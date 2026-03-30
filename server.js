/**
 * Week Below — Live Timer WebSocket Server
 * ─────────────────────────────────────────
 * Requirements:  Node.js 16+
 * Install:       npm install ws
 * Run:           node weekbelow-server.js
 * Default port:  8765  (set WB_PORT env var to override)
 *
 * The server is a pure relay + state store.
 * It holds the current running-timer state for each user in memory
 * and broadcasts any change to every connected client.
 */

const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.WB_PORT || '8765', 10);
const wss  = new WebSocketServer({ port: PORT });

/**
 * Active timers keyed by userId (string).
 * Shape: { userId, userName, userColor, userInitials,
 *          projectId, projectName, phase,
 *          startedAt (ISO string) }
 * A userId key being absent means that user has no active timer.
 */
const activeTimers = {};

/** All currently connected sockets */
const clients = new Set();

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

/** Send the full current timer state to a single socket (on connect) */
function sendSnapshot(socket) {
  socket.send(JSON.stringify({
    type: 'snapshot',
    timers: Object.values(activeTimers),
  }));
}

wss.on('connection', (socket, req) => {
  clients.add(socket);
  console.log(`[+] Client connected  (total: ${clients.size})`);

  // Immediately give the new client the current state
  sendSnapshot(socket);

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── User started a timer ──────────────────────────────────────────
      case 'timer_start': {
        const { userId, userName, userColor, userInitials,
                projectId, projectName, phase } = msg;
        if (!userId) return;

        activeTimers[String(userId)] = {
          userId, userName, userColor, userInitials,
          projectId, projectName, phase,
          startedAt: new Date().toISOString(),
        };

        broadcast({ type: 'timer_start', timer: activeTimers[String(userId)] });
        console.log(`  ▶ ${userName} started timer on "${projectName}"`);
        break;
      }

      // ── User stopped a timer ─────────────────────────────────────────
      case 'timer_stop': {
        const { userId } = msg;
        if (!userId) return;

        const key = String(userId);
        const timer = activeTimers[key];
        delete activeTimers[key];

        broadcast({ type: 'timer_stop', userId, timer });
        if (timer) console.log(`  ■ ${timer.userName} stopped timer`);
        break;
      }

      // ── Client asks for current state (e.g. after reconnect) ─────────
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
    console.log(`[-] Client disconnected (total: ${clients.size})`);
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
    clients.delete(socket);
  });
});

console.log(`Week Below WS server listening on ws://localhost:${PORT}`);
console.log('Press Ctrl+C to stop.\n');
