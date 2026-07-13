import { store } from './state.js';
import { onLiveSample } from './liveBus.js';
import { api } from './api.js';
import { loadChannelGroups, tempChannelKeys, applyCalibration, groupReadingAt } from './calibration.js';

let autoStopTimer = null;

function pushSample(buf, tRel, values, device) {
  buf.t.push(tRel);
  const knownKeys = new Set([
    ...Object.keys(device?.channels || {}),
    ...Object.keys(values),
    ...Object.keys(buf.values),
  ]);
  for (const key of knownKeys) {
    const arr = buf.values[key] || (buf.values[key] = new Array(buf.t.length - 1).fill(null));
    arr.push(Object.hasOwn(values, key) ? values[key] : null);
  }
}

function buildRunRecord({ name, activeModuleIds, sampleRateHz, durationMin, startedAt, endedAt, buffers }) {
  const id = `run_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
  const series = {};
  const calibrationSnapshot = {};
  const channelMeta = {};
  const loadGroups = {};
  const groupStats = {}; // moduleId -> groupId -> { peak, mean }
  const tempStats = {}; // moduleId -> channelKey -> { max, mean }
  let sampleCount = 0;
  let tempUnit = '°C';

  for (const moduleId of activeModuleIds) {
    const device = store.state.devices.get(moduleId);
    const buf = buffers[moduleId] || { t: [], values: {} };
    series[moduleId] = buf;
    sampleCount += buf.t.length;
    channelMeta[moduleId] = device?.channels || {};

    const record = store.state.calibrations[moduleId];
    if (record) calibrationSnapshot[moduleId] = record;

    const groups = loadChannelGroups(device?.channels, moduleId);
    loadGroups[moduleId] = groups;
    groupStats[moduleId] = {};
    for (const g of groups) {
      const gRecord = record?.groups?.[g.id];
      if (!gRecord) continue;
      const vals = [];
      for (let i = 0; i < buf.t.length; i++) {
        const raw = groupReadingAt(buf, g, i);
        if (raw === null) continue;
        vals.push(applyCalibration(raw, gRecord));
      }
      if (vals.length) {
        groupStats[moduleId][g.id] = {
          peak: Math.max(...vals),
          mean: vals.reduce((a, b) => a + b, 0) / vals.length,
        };
      }
    }

    tempStats[moduleId] = {};
    for (const tempKey of tempChannelKeys(device?.channels)) {
      const unit = device?.channels?.[tempKey]?.unit;
      if (unit) tempUnit = unit;
      const vals = (buf.values[tempKey] || []).filter((v) => v !== null);
      if (vals.length) {
        tempStats[moduleId][tempKey] = {
          max: Math.max(...vals),
          mean: vals.reduce((a, b) => a + b, 0) / vals.length,
        };
      }
    }
  }

  return {
    id,
    name,
    moduleIds: activeModuleIds,
    sampleRateHz,
    durationMin,
    startedAt,
    endedAt,
    series,
    channelMeta,
    calibrationSnapshot,
    loadGroups,
    primaryUnit: 'N',
    tempUnit,
    stats: { sampleCount, groups: groupStats, temp: tempStats },
  };
}

export function startRecording() {
  const c = store.state.collect;
  const activeModuleIds = Array.from(c.selectedModuleIds);
  if (activeModuleIds.length === 0) return;

  c.recording = true;
  c.startedAt = Date.now();
  c.activeModuleIds = activeModuleIds;
  c.buffers = {};
  for (const id of activeModuleIds) c.buffers[id] = { t: [], values: {} };

  clearTimeout(autoStopTimer);
  if (c.durationMin > 0) {
    autoStopTimer = setTimeout(() => stopRecording(), c.durationMin * 60000);
  }
  store.notify();
}

export async function stopRecording() {
  const c = store.state.collect;
  if (!c.recording) return;
  clearTimeout(autoStopTimer);

  const run = buildRunRecord({
    name: c.name || 'Untitled run',
    activeModuleIds: c.activeModuleIds,
    sampleRateHz: c.sampleRateHz,
    durationMin: c.durationMin,
    startedAt: c.startedAt,
    endedAt: Date.now(),
    buffers: c.buffers,
  });

  c.recording = false;
  c.buffers = {};
  store.notify();

  try {
    await api.createRun(run);
    const runs = await api.fetchRuns();
    store.state.runs = runs;
    store.notify();
  } catch (err) {
    console.error('Failed to persist run', err);
  }
}

export function initRecorder() {
  onLiveSample((msg) => {
    const c = store.state.collect;
    if (!c.recording || !c.activeModuleIds.includes(msg.id)) return;
    const buf = c.buffers[msg.id] || (c.buffers[msg.id] = { t: [], values: {} });
    const tRel = msg.ts - c.startedAt;
    pushSample(buf, tRel, msg.values, store.state.devices.get(msg.id));
  });
}
