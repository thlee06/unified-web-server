import { WebSocketServer } from 'ws';
import { HEARTBEAT_INTERVAL_MS } from './config.js';

const MODULE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * WS endpoint that ESP32 modules push data to. Only ever talks to the
 * registry - never touches dashboard-facing sockets.
 */
export function createIngestServer(registry) {
  const wss = new WebSocketServer({ noServer: true });
  const socketsByModule = new Map(); // moduleId -> live ws, for last-connection-wins

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.moduleId = null;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.warn('[ingest] dropping malformed JSON frame');
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      const { type, module } = msg;
      if (typeof module !== 'string' || !MODULE_ID_RE.test(module)) {
        console.warn('[ingest] dropping message with missing/invalid module id');
        return;
      }

      const existing = socketsByModule.get(module);
      if (existing && existing !== ws) {
        console.warn(`[ingest] module "${module}" reconnected from a new socket, closing the old one`);
        existing.terminate();
      }
      socketsByModule.set(module, ws);
      ws.moduleId = module;

      if (type === 'hello') {
        registry.registerOrUpdate(module, { name: msg.name, channels: msg.channels });
      } else if (type === 'sample') {
        registry.recordSample(module, msg.values);
      } else {
        console.warn(`[ingest] unknown message type "${type}" from "${module}"`);
      }
    });

    ws.on('close', () => {
      if (ws.moduleId && socketsByModule.get(ws.moduleId) === ws) {
        socketsByModule.delete(ws.moduleId);
        registry.setOffline(ws.moduleId);
      }
    });

    ws.on('error', () => {
      // 'close' fires right after and handles cleanup/offline marking
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
