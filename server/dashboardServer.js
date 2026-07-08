import { WebSocketServer } from 'ws';

/**
 * WS endpoint that browser dashboards connect to. Only ever listens to
 * registry events and fans them out - never touches ingest sockets.
 */
export function createDashboardServer(registry) {
  const wss = new WebSocketServer({ noServer: true });

  function broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  }

  registry.on('module', (mod) => broadcast({ type: 'module', module: mod }));
  registry.on('sample', (sample) => broadcast({ type: 'sample', ...sample }));
  registry.on('status', (status) => broadcast({ type: 'status', ...status }));

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'snapshot', modules: registry.snapshot() }));
  });

  return wss;
}
