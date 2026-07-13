import { store } from './state.js';
import { emitLiveSample } from './liveBus.js';

function getOrCreateDevice(id) {
  let device = store.state.devices.get(id);
  if (!device) {
    device = { id, name: id, channels: {}, status: 'online', lastSeen: Date.now(), live: {} };
    store.state.devices.set(id, device);
  }
  return device;
}

function applySnapshot(modules) {
  for (const mod of modules) {
    const device = getOrCreateDevice(mod.id);
    device.name = mod.name || mod.id;
    device.channels = mod.channels || {};
    device.status = mod.status;
    device.lastSeen = mod.lastSeen;
    const last = mod.history?.[mod.history.length - 1];
    if (last) device.live = { ...device.live, ...last.values };
  }
  store.notify();
}

function applyModule(mod) {
  const device = getOrCreateDevice(mod.id);
  device.name = mod.name || mod.id;
  device.channels = mod.channels || {};
  device.status = mod.status;
  device.lastSeen = mod.lastSeen;
  store.notify();
}

function applySample(msg) {
  const device = getOrCreateDevice(msg.id);
  device.live = { ...device.live, ...msg.values };
  device.lastSeen = msg.ts;
  if (device.status !== 'online') {
    device.status = 'online';
    store.notify();
  }
  emitLiveSample(msg);
}

function applyStatus(msg) {
  const device = getOrCreateDevice(msg.id);
  device.status = msg.status;
  store.notify();
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'snapshot': applySnapshot(msg.modules); break;
    case 'module': applyModule(msg.module); break;
    case 'sample': applySample(msg); break;
    case 'status': applyStatus(msg); break;
    default: console.warn('Unknown dashboard message type', msg.type);
  }
}

export function connectDashboard() {
  store.state.conn = 'connecting';
  store.notify();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/dashboard`);

  ws.addEventListener('open', () => {
    store.state.conn = 'open';
    store.notify();
  });
  ws.addEventListener('message', (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (err) {
      console.error('Failed to handle dashboard message', err);
    }
  });
  ws.addEventListener('close', () => {
    store.state.conn = 'closed';
    store.notify();
    setTimeout(connectDashboard, 2000);
  });
  ws.addEventListener('error', () => ws.close());
}
