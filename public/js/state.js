// Single mutable state object + pub/sub. Structural changes (tab switch,
// device connect/disconnect, calibration saved, run selected, recording
// start/stop) call store.notify() to trigger a full re-render of the active
// screen. High-frequency sample data does NOT flow through here - see
// liveBus.js - so typing in a field or watching a live chart never fights a
// rebuild mid-keystroke.
export const store = {
  state: {
    activeTab: 'devices',
    conn: 'connecting', // 'connecting' | 'open' | 'closed'
    devices: new Map(), // id -> { id, name, channels, status, lastSeen, live }

    calibrations: {}, // moduleId -> record | undefined
    calDraft: {}, // moduleId -> { groups: { groupId -> { zeroOffset, points } }, probes: {} }
    calProfiles: {}, // moduleId -> [{ id, name, groups, probes, savedAt }] (fetched lazily)
    selectedCalModuleId: null,

    runs: [], // summaries, newest first
    runDetails: {}, // id -> full run (cached after fetch)
    selectedRunId: null,

    collect: {
      name: '',
      selectedModuleIds: new Set(),
      sampleRateHz: 20,
      durationMin: 30,
      recording: false,
      startedAt: null,
      activeModuleIds: [], // locked in at recording start
      buffers: {}, // moduleId -> { t: [], values: { channelKey: [] } }
    },
  },
  listeners: new Set(),
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  notify() {
    for (const fn of this.listeners) fn();
  },
};

export function getDevice(id) {
  return store.state.devices.get(id);
}

export function deviceList() {
  return Array.from(store.state.devices.values()).sort((a, b) => a.id.localeCompare(b.id));
}

// Devices-screen action buttons route into the workflow and preselect the
// relevant module in one step, so the user never has to re-pick it.
export function goToTab(tabId, opts = {}) {
  store.state.activeTab = tabId;
  if (opts.calModuleId) store.state.selectedCalModuleId = opts.calModuleId;
  if (opts.collectModuleId) {
    store.state.collect.selectedModuleIds = new Set([opts.collectModuleId]);
  }
  store.notify();
}
