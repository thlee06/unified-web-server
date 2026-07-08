#!/usr/bin/env node
// Mock ESP32: pushes fake sensor samples to the ingest endpoint so the
// dashboard can be exercised end-to-end without real hardware.
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';

const { values: args } = parseArgs({
  options: {
    module: { type: 'string' },
    name: { type: 'string' },
    hz: { type: 'string', default: '5' },
    channels: { type: 'string', default: 'value:' },
    host: { type: 'string', default: 'localhost' },
    port: { type: 'string', default: '8080' },
    corrupt: { type: 'boolean', default: false },
  },
});

if (!args.module) {
  console.error('Usage: simulate-module.js --module <id> [--name <display name>] [--hz 5] [--channels key:unit,key2:unit2] [--corrupt]');
  process.exit(1);
}

const channelDefs = args.channels.split(',').filter(Boolean).map((entry) => {
  const [key, unit] = entry.split(':');
  return { key, unit: unit || null };
});

const hz = Number(args.hz) || 5;
const intervalMs = 1000 / hz;
const url = `ws://${args.host}:${args.port}/ingest`;

console.log(`[sim:${args.module}] connecting to ${url} (${channelDefs.length} channels @ ${hz}Hz)`);

function hashPhase(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 1000;
  return h / 1000;
}

function connect() {
  const ws = new WebSocket(url);
  let timer = null;

  ws.on('open', () => {
    console.log(`[sim:${args.module}] connected`);
    ws.send(JSON.stringify({
      type: 'hello',
      module: args.module,
      name: args.name || args.module,
      channels: Object.fromEntries(
        channelDefs.map(({ key, unit }) => [key, { label: null, unit }])
      ),
    }));

    const start = Date.now();
    timer = setInterval(() => {
      if (args.corrupt && Math.random() < 0.05) {
        const garbage = Math.random() < 0.5 ? '{not valid json' : JSON.stringify({
          type: 'sample',
          module: args.module,
          values: { [channelDefs[0]?.key || 'value']: 'not-a-number' },
        });
        console.log(`[sim:${args.module}] sending corrupt frame`);
        ws.send(garbage);
        return;
      }

      const t = (Date.now() - start) / 1000;
      const values = {};
      for (const { key } of channelDefs) {
        const phase = hashPhase(key) * Math.PI * 2;
        values[key] = Number((50 + 40 * Math.sin(t * 0.5 + phase) + (Math.random() - 0.5) * 4).toFixed(2));
      }
      ws.send(JSON.stringify({ type: 'sample', module: args.module, ts: Date.now(), values }));
    }, intervalMs);
  });

  ws.on('close', () => {
    clearInterval(timer);
    console.log(`[sim:${args.module}] disconnected, retrying in 2s`);
    setTimeout(connect, 2000);
  });

  ws.on('error', (err) => {
    console.error(`[sim:${args.module}] error:`, err.message);
  });

  process.on('SIGINT', () => {
    clearInterval(timer);
    ws.close();
    process.exit(0);
  });
}

connect();
