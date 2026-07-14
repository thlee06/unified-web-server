import { store, deviceList } from '../state.js';
import { isCalibrated, loadChannelGroups, groupReading, tempChannelKeys, applyCalibration } from '../calibration.js';
import { onLiveSample } from '../liveBus.js';
import { startRecording, stopRecording } from '../recorder.js';
import { toPath, seriesColor } from '../charts.js';
import { fmtElapsed, fmtNum, escapeHtml } from '../format.js';
import { hotasState, onHotasChange } from '../hotasControl.js';

const WINDOW_SIZE = 240;
const CHART_W = 820;
const CHART_H = 200;
const CHART_PAD = 20;

// Ephemeral, chart-only rolling window - not persisted, resets when the
// focus module changes. The full recording buffer lives in recorder.js.
let liveWindow = { moduleId: null, groups: {}, temps: {} };

function focusModuleId() {
  const c = store.state.collect;
  if (c.recording) return c.activeModuleIds[0] || null;
  return Array.from(c.selectedModuleIds)[0] || null;
}

function resetWindowIfNeeded(moduleId) {
  if (liveWindow.moduleId !== moduleId) {
    liveWindow = { moduleId, groups: {}, temps: {} };
  }
}

function pushWindow(arr, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return;
  arr.push(v);
  if (arr.length > WINDOW_SIZE) arr.shift();
}

export function render(container) {
  const c = store.state.collect;
  const devices = deviceList();

  const moduleRows = devices
    .map((d) => {
      const record = store.state.calibrations[d.id];
      const calibrated = isCalibrated(record);
      const checked = c.selectedModuleIds.has(d.id);
      return `
        <div class="module-check-row${calibrated ? '' : ' disabled'}" data-module="${escapeHtml(d.id)}">
          <span class="check-box${checked ? ' checked' : ''}" data-role="checkbox">${checked ? '✓' : ''}</span>
          <span>${escapeHtml(d.name)}</span>
          <span class="module-cal-note ${calibrated ? 'ok' : 'warn'}">${calibrated ? 'calibrated' : 'needs calibration'}</span>
        </div>
      `;
    })
    .join('');

  const selected = Array.from(c.selectedModuleIds);
  const allCalibrated = selected.length > 0 && selected.every((id) => isCalibrated(store.state.calibrations[id]));
  const guardHtml = allCalibrated
    ? `<div class="guard-strip ok"><span>✓</span> All selected modules are calibrated.</div>`
    : `<div class="guard-strip warn"><span>⚠</span> ${selected.length === 0 ? 'Select at least one calibrated module to start.' : 'One or more selected modules need calibration before you can collect.'}</div>`;

  const focusId = focusModuleId();
  const focusDevice = focusId ? store.state.devices.get(focusId) : null;
  resetWindowIfNeeded(focusId);

  const groups = loadChannelGroups(focusDevice?.channels, focusId);
  const tempKeys = tempChannelKeys(focusDevice?.channels);

  const loadLegendHtml = groups
    .map((g, i) => `
      <div class="legend-item">
        <span class="legend-swatch" style="background:${seriesColor(i)}"></span>${escapeHtml(g.label)}
        <span class="legend-value mono" data-legend-group="${escapeHtml(g.id)}">&mdash;</span>
      </div>
    `)
    .join('');

  const tempLegendHtml = tempKeys
    .map((k, i) => `
      <div class="legend-item">
        <span class="legend-swatch" style="background:${seriesColor(i)}"></span>${escapeHtml(focusDevice?.channels?.[k]?.label || k)}
        <span class="legend-value mono" data-legend-temp="${escapeHtml(k)}">&mdash;</span>
      </div>
    `)
    .join('');

  container.innerHTML = `
    <div class="page-eyebrow">Step 2</div>
    <div class="collect-title-row">
      <h1 class="page-title">Collect data</h1>
      ${c.recording ? `<span class="recording-pill"><span class="dot"></span>Recording &middot; <span id="collect-elapsed" class="mono">00:00:00</span></span>` : ''}
    </div>

    <div class="card hotas-mini">
      <span class="hotas-mini-label">HOTAS throttle</span>
      <div class="axis-bar-track hotas-mini-track"><div class="axis-bar-fill" id="collect-throttle-bar" style="width:0%"></div></div>
      <span class="mono hotas-mini-val" id="collect-throttle-val">&mdash;</span>
      <span class="chip chip-warn" id="collect-hotas-armed">DISCONNECTED</span>
    </div>

    <div class="collect-layout">
      <div class="card">
        <div class="setup-title">Session</div>

        <label class="field">
          <div class="field-name">Name</div>
          <input class="field-input" id="collect-name" type="text" value="${escapeHtml(c.name)}" placeholder="Beam fatigue &middot; run 04" ${c.recording ? 'disabled' : ''} />
        </label>

        <div class="field-name" style="margin-bottom:8px;">Modules</div>
        <div class="module-check-list">
          ${moduleRows || '<div class="run-empty">No modules connected yet.</div>'}
        </div>

        <div class="field-row">
          <label class="field">
            Sample rate
            <select class="field-input" id="collect-rate" ${c.recording ? 'disabled' : ''}>
              ${[5, 10, 20, 50, 100].map((hz) => `<option value="${hz}" ${c.sampleRateHz === hz ? 'selected' : ''}>${hz} Hz</option>`).join('')}
            </select>
          </label>
          <label class="field">
            Duration
            <select class="field-input" id="collect-duration" ${c.recording ? 'disabled' : ''}>
              ${[5, 10, 30, 60, 0].map((min) => `<option value="${min}" ${c.durationMin === min ? 'selected' : ''}>${min === 0 ? 'Unlimited' : min + ' min'}</option>`).join('')}
            </select>
          </label>
        </div>

        ${guardHtml}

        <button class="btn btn-block ${c.recording ? 'btn-primary' : 'btn-primary'}" id="collect-toggle" ${!c.recording && !allCalibrated ? 'disabled' : ''}>
          ${c.recording ? 'Stop recording' : 'Start recording'}
        </button>
      </div>

      <div class="chart-plots">
        <div class="card chart-card">
          <div class="chart-head">
            <div class="chart-label">Load channels vs. time</div>
            <div class="chart-tag">${focusDevice ? escapeHtml(focusDevice.name) : 'No module selected'}</div>
          </div>
          ${groups.length ? `<div class="legend">${loadLegendHtml}</div>` : '<div class="run-empty">This module has no load channels.</div>'}
          <svg viewBox="0 0 ${CHART_W} ${CHART_H}">
            <line class="gridline" x1="0" y1="50" x2="${CHART_W}" y2="50"></line>
            <line class="gridline" x1="0" y1="100" x2="${CHART_W}" y2="100"></line>
            <line class="gridline" x1="0" y1="150" x2="${CHART_W}" y2="150"></line>
            ${groups.map((g, i) => `<polyline data-load-line="${escapeHtml(g.id)}" points="" fill="none" stroke="${seriesColor(i)}" stroke-width="2" stroke-linejoin="round"></polyline>`).join('')}
          </svg>
        </div>
        <div class="card chart-card">
          <div class="chart-head">
            <div class="chart-label">Temperature vs. time</div>
            <div class="chart-tag">${tempKeys.length} probe${tempKeys.length === 1 ? '' : 's'}</div>
          </div>
          ${tempKeys.length ? `<div class="legend">${tempLegendHtml}</div>` : '<div class="run-empty">This module reports no temperature channels.</div>'}
          <svg viewBox="0 0 ${CHART_W} ${CHART_H}">
            <line class="gridline" x1="0" y1="50" x2="${CHART_W}" y2="50"></line>
            <line class="gridline" x1="0" y1="100" x2="${CHART_W}" y2="100"></line>
            <line class="gridline" x1="0" y1="150" x2="${CHART_W}" y2="150"></line>
            ${tempKeys.map((k, i) => `<polyline data-temp-line="${escapeHtml(k)}" points="" fill="none" stroke="${seriesColor(i)}" stroke-width="2" stroke-linejoin="round"></polyline>`).join('')}
          </svg>
        </div>
      </div>
    </div>
  `;

  // --- bindings ---
  container.querySelector('#collect-name')?.addEventListener('input', (e) => {
    c.name = e.target.value;
  });
  container.querySelector('#collect-rate')?.addEventListener('change', (e) => {
    c.sampleRateHz = Number(e.target.value);
    store.notify();
  });
  container.querySelector('#collect-duration')?.addEventListener('change', (e) => {
    c.durationMin = Number(e.target.value);
    store.notify();
  });

  container.querySelectorAll('.module-check-row').forEach((row) => {
    if (row.classList.contains('disabled') || c.recording) return;
    row.addEventListener('click', () => {
      const id = row.dataset.module;
      if (c.selectedModuleIds.has(id)) c.selectedModuleIds.delete(id);
      else c.selectedModuleIds.add(id);
      store.notify();
    });
  });

  container.querySelector('#collect-toggle')?.addEventListener('click', () => {
    if (c.recording) stopRecording();
    else startRecording();
  });

  // --- live patching (no full re-render) ---
  const elapsedEl = container.querySelector('#collect-elapsed');

  const throttleBarEl = container.querySelector('#collect-throttle-bar');
  const throttleValEl = container.querySelector('#collect-throttle-val');
  const armedChipEl = container.querySelector('#collect-hotas-armed');

  function paintHotas() {
    if (hotasState.throttle !== null) {
      throttleValEl.textContent = `${Math.round(hotasState.throttle * 100)}%`;
      throttleBarEl.style.width = `${(hotasState.throttle * 100).toFixed(1)}%`;
    } else {
      throttleValEl.textContent = '—';
      throttleBarEl.style.width = '0%';
    }
    if (hotasState.wsStatus !== 'open') {
      armedChipEl.textContent = 'DISCONNECTED';
      armedChipEl.className = 'chip chip-warn';
    } else if (hotasState.armed) {
      armedChipEl.textContent = 'ARMED';
      armedChipEl.className = 'chip chip-ok';
    } else {
      armedChipEl.textContent = 'DISARMED';
      armedChipEl.className = 'chip chip-warn';
    }
  }
  paintHotas();
  const unsubscribeHotas = onHotasChange(paintHotas);

  function paintGroups() {
    for (const g of groups) {
      const line = container.querySelector(`[data-load-line="${CSS.escape(g.id)}"]`);
      const arr = liveWindow.groups[g.id] || [];
      if (line) line.setAttribute('points', toPath(arr, CHART_W, CHART_H, CHART_PAD));
      const legendEl = container.querySelector(`[data-legend-group="${CSS.escape(g.id)}"]`);
      if (legendEl) legendEl.textContent = `${fmtNum(arr[arr.length - 1], 1)} N`;
    }
  }

  function paintTemps() {
    for (const k of tempKeys) {
      const line = container.querySelector(`[data-temp-line="${CSS.escape(k)}"]`);
      const arr = liveWindow.temps[k] || [];
      if (line) line.setAttribute('points', toPath(arr, CHART_W, CHART_H, CHART_PAD));
      const legendEl = container.querySelector(`[data-legend-temp="${CSS.escape(k)}"]`);
      if (legendEl) legendEl.textContent = `${fmtNum(arr[arr.length - 1], 1)}${focusDevice?.channels?.[k]?.unit || ''}`;
    }
  }

  paintGroups();
  paintTemps();

  const unsubscribe = onLiveSample((msg) => {
    if (!focusId || msg.id !== focusId) return;
    const record = store.state.calibrations[focusId];

    for (const g of groups) {
      const raw = groupReading(msg.values, g);
      if (raw === null) continue;
      const gRecord = record?.groups?.[g.id];
      const calibrated = gRecord ? applyCalibration(raw, gRecord) : raw;
      const arr = liveWindow.groups[g.id] || (liveWindow.groups[g.id] = []);
      pushWindow(arr, calibrated);
    }

    for (const k of tempKeys) {
      if (!Object.hasOwn(msg.values, k)) continue;
      const arr = liveWindow.temps[k] || (liveWindow.temps[k] = []);
      pushWindow(arr, msg.values[k]);
    }

    paintGroups();
    paintTemps();
  });

  let timerHandle = null;
  if (c.recording && elapsedEl) {
    timerHandle = setInterval(() => {
      if (!c.recording) return;
      elapsedEl.textContent = fmtElapsed(Date.now() - c.startedAt);
    }, 100);
  }

  return () => {
    unsubscribe();
    unsubscribeHotas();
    if (timerHandle) clearInterval(timerHandle);
  };
}
