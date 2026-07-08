import { EventEmitter } from 'node:events';

function inferLabel(channelKey) {
  return channelKey
    .split('_')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

class ModuleState {
  constructor(id) {
    this.id = id;
    this.name = id;
    this.channels = {}; // key -> { label, unit }
    this.status = 'online';
    this.lastSeen = Date.now();
    this.history = []; // [{ ts, values }]
  }

  toJSON() {
    const { id, name, channels, status, lastSeen, history } = this;
    return { id, name, channels, status, lastSeen, history };
  }
}

/**
 * Single in-memory source of truth for connected test-rig modules.
 * Ingest and dashboard WS layers only ever talk to this, never to each other.
 */
export class ModuleRegistry extends EventEmitter {
  constructor({ historyMaxPoints }) {
    super();
    this.historyMaxPoints = historyMaxPoints;
    this.modules = new Map();
  }

  _ensureModule(id) {
    let mod = this.modules.get(id);
    if (!mod) {
      mod = new ModuleState(id);
      this.modules.set(id, mod);
    }
    return mod;
  }

  _ensureChannels(mod, keys) {
    for (const key of keys) {
      if (!mod.channels[key]) {
        mod.channels[key] = { label: inferLabel(key), unit: null };
      }
    }
  }

  registerOrUpdate(id, { name, channels } = {}) {
    const mod = this._ensureModule(id);
    if (name) mod.name = name;
    if (channels) {
      for (const [key, meta] of Object.entries(channels)) {
        mod.channels[key] = {
          label: meta?.label || inferLabel(key),
          unit: meta?.unit ?? null,
        };
      }
    }
    mod.status = 'online';
    mod.lastSeen = Date.now();
    this.emit('module', mod.toJSON());
    return mod;
  }

  recordSample(id, values) {
    const mod = this._ensureModule(id);
    const cleanValues = {};
    for (const [key, value] of Object.entries(values || {})) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        cleanValues[key] = value;
      } else {
        console.warn(`[registry] dropping non-numeric value for "${id}.${key}":`, value);
      }
    }
    if (Object.keys(cleanValues).length === 0) return null;

    this._ensureChannels(mod, Object.keys(cleanValues));

    const wasOffline = mod.status !== 'online';
    mod.status = 'online';
    mod.lastSeen = Date.now();

    const ts = mod.lastSeen;
    mod.history.push({ ts, values: cleanValues });
    if (mod.history.length > this.historyMaxPoints) {
      mod.history.shift();
    }

    if (wasOffline) {
      this.emit('status', { id, status: 'online' });
    }
    this.emit('sample', { id, ts, values: cleanValues });
    return { ts, values: cleanValues };
  }

  setOffline(id) {
    const mod = this.modules.get(id);
    if (!mod || mod.status === 'offline') return;
    mod.status = 'offline';
    this.emit('status', { id, status: 'offline' });
  }

  get(id) {
    return this.modules.get(id);
  }

  snapshot() {
    return Array.from(this.modules.values(), (mod) => mod.toJSON());
  }
}
