import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { PORT, HISTORY_MAX_POINTS } from './config.js';
import { ModuleRegistry } from './moduleRegistry.js';
import { createIngestServer } from './ingestServer.js';
import { createDashboardServer } from './dashboardServer.js';
import { Store } from './store.js';
import { createApiRouter } from './apiRoutes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const store = new Store();
app.use('/api', createApiRouter(store));
app.use(express.static(path.join(__dirname, '..', 'public')));

const httpServer = http.createServer(app);

const registry = new ModuleRegistry({ historyMaxPoints: HISTORY_MAX_POINTS });
const ingestWss = createIngestServer(registry);
const dashboardWss = createDashboardServer(registry);

httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/ingest') {
    ingestWss.handleUpgrade(req, socket, head, (ws) => ingestWss.emit('connection', ws, req));
  } else if (pathname === '/dashboard') {
    dashboardWss.handleUpgrade(req, socket, head, (ws) => dashboardWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

httpServer.listen(PORT, () => {
  const lanIps = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);

  console.log(`Dashboard server listening on port ${PORT}`);
  console.log(`  Local:      http://localhost:${PORT}`);
  for (const ip of lanIps) {
    console.log(`  On LAN:     http://${ip}:${PORT}`);
  }
  console.log(`ESP32 modules should push data to ws://<this-host>:${PORT}/ingest`);
});
