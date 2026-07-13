import { store, deviceList } from '../state.js';
import {
  isCalibrated, loadChannelGroups, groupReading, tempChannelKeys,
  fitScale, residualsFor, CALIBRATION_VALIDITY_MS,
} from '../calibration.js';
import { onLiveSample } from '../liveBus.js';
import { api } from '../api.js';
import { fmtNum, escapeHtml } from '../format.js';

const STABILITY_WINDOW = 20;
let stability = { moduleId: null, byGroup: {} };

function activeModuleId(devices) {
  const stored = store.state.selectedCalModuleId;
  if (stored && devices.some((d) => d.id === stored)) return stored;
  return devices[0]?.id || null;
}

function getDraft(id, groups) {
  let draft = store.state.calDraft[id];
  if (!draft) {
    draft = { groups: {}, probes: {} };
    store.state.calDraft[id] = draft;
  }
  for (const g of groups) {
    if (!draft.groups[g.id]) {
      draft.groups[g.id] = { zeroOffset: null, points: [], massInput: '5.000', lengthInput: '150.0' };
    }
  }
  return draft;
}

function groupStability(groupId) {
  return stability.byGroup[groupId] || (stability.byGroup[groupId] = []);
}

function isStable(groupId) {
  const values = groupStability(groupId);
  if (values.length < 8) return false;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  return stddev < Math.max(0.5, Math.abs(mean) * 0.01);
}

function windowMean(groupId) {
  const values = groupStability(groupId);
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function daysBetween(a, b) {
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

async function ensureProfiles(id) {
  if (store.state.calProfiles[id]) return;
  store.state.calProfiles[id] = [];
  try {
    const profiles = await api.fetchProfiles(id);
    store.state.calProfiles[id] = profiles;
    store.notify();
  } catch (err) {
    console.error('Failed to load calibration profiles', err);
  }
}

function buildGroupRecords(draft, groups) {
  const groupRecords = {};
  for (const g of groups) {
    const gd = draft.groups[g.id];
    const scale = fitScale(gd.points, gd.zeroOffset);
    groupRecords[g.id] = { label: g.label, keys: g.keys, zeroOffset: gd.zeroOffset, scale, points: gd.points };
  }
  return groupRecords;
}

export function render(container) {
  const devices = deviceList();
  const id = activeModuleId(devices);

  if (!id) {
    container.innerHTML = `
      <div class="page-eyebrow">Step 1</div>
      <h1 class="page-title">Calibrate a module</h1>
      <div class="empty-state">Waiting for modules to connect&hellip;</div>
    `;
    return;
  }

  const device = store.state.devices.get(id);
  const groups = loadChannelGroups(device?.channels, id);
  const draft = getDraft(id, groups);
  const savedRecord = store.state.calibrations[id];
  const tempKeys = tempChannelKeys(device?.channels);
  if (stability.moduleId !== id) stability = { moduleId: id, byGroup: {} };
  ensureProfiles(id);

  const groupsZeroed = groups.every((g) => draft.groups[g.id].zeroOffset !== null);
  const groupsScaled = groups.every((g) => draft.groups[g.id].points.length >= 2);
  const step3Done = tempKeys.length === 0 || tempKeys.every((k) => draft.probes[k]);
  const canSave = groupsZeroed && groupsScaled && step3Done;

  const pillsHtml = devices
    .map((d) => `<button class="pill${d.id === id ? ' active' : ''}" data-module="${escapeHtml(d.id)}">${escapeHtml(d.name)}</button>`)
    .join('');

  const groupCardsHtml = groups
    .map((g) => {
      const gd = draft.groups[g.id];
      const zeroed = gd.zeroOffset !== null;
      const scaled = gd.points.length >= 2;
      const stable = isStable(g.id);
      const scale = scaled ? fitScale(gd.points, gd.zeroOffset) : 0;
      const residuals = scaled ? residualsFor(gd.points, gd.zeroOffset, scale) : [];
      const pointRows = gd.points
        .map((p, i) => {
          const res = residuals[i];
          return `
            <div class="cal-table-row">
              <span class="pt">${String(i + 1).padStart(2, '0')}</span>
              <span>${p.mass.toFixed(3)} kg</span>
              <span>${fmtNum(p.reading, 2)}</span>
              <span class="${Math.abs(res) > Math.abs(scale) * 0.5 + 0.5 ? 'res-bad' : 'res-ok'}">${res >= 0 ? '+' : ''}${fmtNum(res, 2)}</span>
            </div>
          `;
        })
        .join('');

      return `
        <div class="card step-card group-card ${zeroed && scaled ? 'done' : 'current'}" data-group="${escapeHtml(g.id)}">
          <div class="step-header">
            <span class="step-token ${zeroed && scaled ? 'done' : 'current'}">${zeroed && scaled ? '✓' : ''}</span>
            <div class="step-title">${escapeHtml(g.label)}</div>
            <span class="step-status ${zeroed && scaled ? 'done' : 'current'}">${zeroed && scaled ? 'Done' : 'In progress'}</span>
          </div>
          <p class="step-desc">Channels: ${escapeHtml(g.keys.join(', '))}${g.keys.length > 1 ? ' (averaged as one reading)' : ''}</p>

          <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px;">
            <button class="btn btn-secondary" data-role="record-zero" ${stable ? '' : 'disabled'}>${zeroed ? 'Re-record zero' : 'Record zero'}</button>
            <span class="mono" data-role="zero-caption" style="font-size:12.5px; color:var(--faint);">${zeroed ? `baseline&nbsp; ${fmtNum(gd.zeroOffset, 2)}` : (stable ? 'signal stable' : 'waiting for signal to settle&hellip;')}</span>
          </div>

          <div class="field-row">
            <label class="field">Known mass (kg)
              <input class="field-input" data-role="mass-input" type="number" step="0.001" min="0" value="${escapeHtml(gd.massInput)}" ${zeroed ? '' : 'disabled'} />
            </label>
            <label class="field">Gauge length (mm)
              <input class="field-input" data-role="length-input" type="number" step="0.1" min="0" value="${escapeHtml(gd.lengthInput)}" ${zeroed ? '' : 'disabled'} />
            </label>
            <button class="btn btn-primary" data-role="capture-point" style="height:39px;" ${zeroed && stable ? '' : 'disabled'}>Capture point</button>
          </div>
          <div class="cal-table">
            <div class="cal-table-head"><span>Pt</span><span>Mass</span><span>Reading</span><span>Residual</span></div>
            ${pointRows || '<div class="run-empty" style="grid-column:1/-1;">No points captured yet.</div>'}
          </div>
        </div>
      `;
    })
    .join('');

  const probeRows = tempKeys
    .map((k) => {
      const checked = !!draft.probes[k];
      const label = device.channels[k]?.label || k;
      return `
        <div class="probe-row" data-probe="${escapeHtml(k)}">
          <span class="probe-check${checked ? ' checked' : ''}">${checked ? '✓' : ''}</span>
          <span class="name">${escapeHtml(label)}</span>
          <span class="reading mono" data-probe-reading="${escapeHtml(k)}">${fmtNum(device?.live?.[k], 1)}${escapeHtml(device?.channels?.[k]?.unit || '')}</span>
        </div>
      `;
    })
    .join('');

  const profiles = store.state.calProfiles[id] || [];
  const profileRows = profiles
    .map((p) => `
      <div class="probe-row" data-profile="${escapeHtml(p.id)}">
        <span class="name">${escapeHtml(p.name)}</span>
        <span class="reading mono" style="margin-left:auto;">saved ${daysBetween(p.savedAt, Date.now())}d ago</span>
        <button class="btn btn-secondary" data-role="load-profile" style="margin-left:12px;">Load</button>
        <button class="btn btn-secondary" data-role="delete-profile">Delete</button>
      </div>
    `)
    .join('');

  const footerMeta = savedRecord
    ? `Last calibrated ${daysBetween(savedRecord.savedAt, Date.now())} days ago &middot; expires in ${daysBetween(Date.now(), savedRecord.expiresAt)} days`
    : 'Not yet calibrated';

  container.innerHTML = `
    <div class="page-eyebrow">Step 1</div>
    <h1 class="page-title" style="margin-bottom:20px;">Calibrate a module</h1>

    <div class="module-selector">
      <span class="caption">Module</span>
      ${pillsHtml}
    </div>

    <div class="cal-layout">
      <div class="steps">
        ${groups.length ? `<div class="group-grid">${groupCardsHtml}</div>` : ''}

        ${groups.length ? `
        <div class="card">
          <div class="step-header" style="margin-bottom:10px;">
            <div class="step-title">Saved profiles</div>
          </div>
          <div class="probe-list">
            ${profileRows || '<div class="run-empty">No saved profiles yet.</div>'}
          </div>
        </div>` : ''}

        <div class="card step-card ${step3Done ? 'done' : 'current'}">
          <div class="step-header">
            <span class="step-token ${step3Done && tempKeys.length ? 'done' : 'current'}">${step3Done && tempKeys.length ? '✓' : ''}</span>
            <div class="step-title">Verify temperature probes</div>
            <span class="step-status ${step3Done && tempKeys.length ? 'done' : 'current'}">${step3Done && tempKeys.length ? 'Done' : 'In progress'}</span>
          </div>
          <p class="step-desc">Confirm each probe is seated at its labelled position and reads within tolerance of the reference.</p>
          <div class="probe-list">
            ${probeRows || '<div class="run-empty">This module reports no temperature channels.</div>'}
          </div>
        </div>

        <div class="cal-footer">
          <span class="meta mono">${footerMeta}</span>
          <div style="display:flex; gap:10px;">
            ${groups.length ? `<button class="btn btn-secondary" id="save-profile" ${canSave ? '' : 'disabled'}>Save as profile&hellip;</button>` : ''}
            <button class="btn btn-dark" id="save-calibration" ${canSave ? '' : 'disabled'}>Save calibration</button>
          </div>
        </div>
      </div>

      <div class="readout-panel">
        <div class="readout-eyebrow">Live readout</div>
        ${groups.length ? groups.map((g) => `
          <div class="readout-block" data-readout-group="${escapeHtml(g.id)}">
            <div class="readout-label">${escapeHtml(g.label)}</div>
            <div class="readout-value primary mono" data-role="readout-value">&mdash;<span class="readout-unit">raw</span></div>
          </div>
        `).join('') : `<div class="readout-block"><div class="readout-label">No load channels on this module</div></div>`}
        <div class="readout-caption" id="readout-caption">${groups.some((g) => isStable(g.id)) || groups.length === 0 ? 'Watching signal&hellip;' : 'Waiting for the reading to settle before capturing a point.'}</div>
      </div>
    </div>
  `;

  container.querySelectorAll('[data-module]').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.state.selectedCalModuleId = btn.dataset.module;
      store.notify();
    });
  });

  container.querySelectorAll('.group-card').forEach((card) => {
    const gid = card.dataset.group;
    const g = groups.find((x) => x.id === gid);
    const gd = draft.groups[gid];

    card.querySelector('[data-role="record-zero"]')?.addEventListener('click', () => {
      const mean = windowMean(gid);
      if (typeof mean !== 'number') return;
      gd.zeroOffset = mean;
      store.notify();
    });
    card.querySelector('[data-role="mass-input"]')?.addEventListener('input', (e) => { gd.massInput = e.target.value; });
    card.querySelector('[data-role="length-input"]')?.addEventListener('input', (e) => { gd.lengthInput = e.target.value; });
    card.querySelector('[data-role="capture-point"]')?.addEventListener('click', () => {
      const mass = Number(card.querySelector('[data-role="mass-input"]').value);
      const length = Number(card.querySelector('[data-role="length-input"]').value);
      const mean = windowMean(gid);
      if (!(mass > 0) || typeof mean !== 'number') return;
      gd.points.push({ mass, length, reading: mean });
      store.notify();
    });
  });

  container.querySelectorAll('[data-probe]').forEach((row) => {
    row.addEventListener('click', () => {
      const key = row.dataset.probe;
      draft.probes[key] = !draft.probes[key];
      store.notify();
    });
  });

  container.querySelectorAll('[data-profile]').forEach((row) => {
    const profileId = row.dataset.profile;
    const profile = profiles.find((p) => p.id === profileId);
    row.querySelector('[data-role="load-profile"]')?.addEventListener('click', async () => {
      const record = {
        groups: profile.groups,
        probes: profile.probes,
        savedAt: Date.now(),
        expiresAt: Date.now() + CALIBRATION_VALIDITY_MS,
      };
      try {
        await api.saveCalibration(id, record);
        store.state.calibrations[id] = record;
        delete store.state.calDraft[id];
        store.notify();
      } catch (err) {
        console.error('Failed to load calibration profile', err);
      }
    });
    row.querySelector('[data-role="delete-profile"]')?.addEventListener('click', async () => {
      try {
        await api.deleteProfile(id, profileId);
        store.state.calProfiles[id] = profiles.filter((p) => p.id !== profileId);
        store.notify();
      } catch (err) {
        console.error('Failed to delete calibration profile', err);
      }
    });
  });

  container.querySelector('#save-profile')?.addEventListener('click', async () => {
    const name = window.prompt('Save this calibration as a profile named:');
    if (!name) return;
    const profile = { name, groups: buildGroupRecords(draft, groups), probes: Object.keys(draft.probes).filter((k) => draft.probes[k]) };
    try {
      const saved = await api.saveProfile(id, profile);
      store.state.calProfiles[id] = [...(store.state.calProfiles[id] || []), saved];
      store.notify();
    } catch (err) {
      console.error('Failed to save calibration profile', err);
    }
  });

  container.querySelector('#save-calibration')?.addEventListener('click', async () => {
    const record = {
      groups: buildGroupRecords(draft, groups),
      probes: Object.keys(draft.probes).filter((k) => draft.probes[k]),
      savedAt: Date.now(),
      expiresAt: Date.now() + CALIBRATION_VALIDITY_MS,
    };
    try {
      await api.saveCalibration(id, record);
      store.state.calibrations[id] = record;
      // Deliberately keep the draft around (rather than clearing it) so
      // "Save as profile" is still available right after saving - it reads
      // canSave off the same draft, and this is the natural next action.
      store.notify();
    } catch (err) {
      console.error('Failed to save calibration', err);
    }
  });

  // --- live patching ---
  const captionEl = container.querySelector('#readout-caption');

  const unsubscribe = onLiveSample((msg) => {
    if (msg.id !== id) return;

    for (const g of groups) {
      const reading = groupReading(msg.values, g);
      if (reading === null) continue;
      const values = groupStability(g.id);
      values.push(reading);
      if (values.length > STABILITY_WINDOW) values.shift();

      const readoutEl = container.querySelector(`[data-readout-group="${CSS.escape(g.id)}"] [data-role="readout-value"]`);
      if (readoutEl) readoutEl.innerHTML = `${fmtNum(reading, 2)}<span class="readout-unit">raw</span>`;

      const card = container.querySelector(`.group-card[data-group="${CSS.escape(g.id)}"]`);
      if (card) {
        const stable = isStable(g.id);
        const zeroed = draft.groups[g.id].zeroOffset !== null;
        const zeroBtn = card.querySelector('[data-role="record-zero"]');
        const captureBtn = card.querySelector('[data-role="capture-point"]');
        const zeroCaption = card.querySelector('[data-role="zero-caption"]');
        if (zeroBtn) zeroBtn.disabled = !stable;
        if (captureBtn) captureBtn.disabled = !(zeroed && stable);
        if (zeroCaption && !zeroed) zeroCaption.textContent = stable ? 'signal stable' : 'waiting for signal to settle…';
      }
    }

    for (const k of tempKeys) {
      const readingEl = container.querySelector(`[data-probe-reading="${CSS.escape(k)}"]`);
      if (readingEl && Object.hasOwn(msg.values, k)) {
        readingEl.textContent = `${fmtNum(msg.values[k], 1)}${device?.channels?.[k]?.unit || ''}`;
      }
    }

    if (captionEl) {
      const anyStable = groups.some((g) => isStable(g.id));
      captionEl.textContent = groups.length === 0
        ? 'No load channels — verify probes above.'
        : anyStable
          ? 'Signal stable. Safe to capture a point.'
          : 'Waiting for the reading to settle before capturing a point.';
    }
  });

  return () => unsubscribe();
}
