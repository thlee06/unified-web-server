import { store, deviceList, goToTab } from '../state.js';
import {
  isCalibrated, loadChannelGroups, groupReading, tempChannelKeys,
  fitScale, residualsFor, CALIBRATION_VALIDITY_MS,
} from '../calibration.js';
import { onLiveSample } from '../liveBus.js';
import { api } from '../api.js';
import { fmtNum, escapeHtml } from '../format.js';

// How many fresh samples "Record zero" / "Capture point" average together.
// Deliberately *not* a continuously-maintained rolling window: the thrust
// stand gets tilted on its side to hang a known mass, which swings the raw
// reading by orders of magnitude more than sensor noise ever would. A
// rolling window kept that tilt transient contaminating the stats for
// several seconds after the stand was set back down and re-zeroed. Instead,
// samples are only ever collected in the brief moment right after the
// button is pressed - the operator (who can see the physical rig) decides
// when it's actually still, the software just averages whatever comes in
// next.
const CAPTURE_SAMPLE_COUNT = 8;

let capture = { moduleId: null, byGroup: {} };

// Transient feedback for the Save calibration button - the click handler is
// async (a network round-trip), and previously gave no visible sign it had
// done anything beyond a small "Last calibrated ... days ago" line that's
// easy to miss and, on failure, only logged to the console. `state` is
// null | 'saving' | 'saved' | 'error'.
let saveStatus = { moduleId: null, state: null, message: null };

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

function groupCapture(groupId) {
  return capture.byGroup[groupId] || (capture.byGroup[groupId] = {
    active: false,
    kind: null, // 'zero' | 'point', while active
    samples: [],
    pendingMass: null,
    pendingLength: null,
    lastResult: null, // { kind, mean, stddev } for the most recently finished capture
  });
}

function meanStddev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance) };
}

// Purely informational, after the fact - not a gate. If a just-finished
// batch was itself noisy (e.g. the operator hit the button while the stand
// was still swinging from being tilted), flag it so they know to redo that
// step, rather than silently baking a bad average into the calibration.
function captureQualityWarning(result) {
  if (!result) return '';
  const threshold = Math.max(50, Math.abs(result.mean) * 0.02);
  if (result.stddev < threshold) return '';
  return ` — jumped ±${fmtNum(result.stddev, 0)} counts during capture; stand may not have been still, consider redoing this`;
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
  if (capture.moduleId !== id) capture = { moduleId: id, byGroup: {} };
  if (saveStatus.moduleId !== id) saveStatus = { moduleId: id, state: null, message: null };
  ensureProfiles(id);

  const groupsZeroed = groups.every((g) => draft.groups[g.id].zeroOffset !== null);
  const groupsScaled = groups.every((g) => draft.groups[g.id].points.length >= 2);
  const step3Done = tempKeys.length === 0 || tempKeys.every((k) => draft.probes[k]);
  const canSave = groupsZeroed && groupsScaled && step3Done;

  // Spelled-out reasons Save is disabled - previously the button just sat
  // greyed out with no explanation, which reads identically to "the button
  // is broken" if you don't already know which step you skipped.
  const saveBlockers = [];
  for (const g of groups) {
    const gd = draft.groups[g.id];
    if (gd.zeroOffset === null) saveBlockers.push(`record zero for ${g.label}`);
    else if (gd.points.length < 2) saveBlockers.push(`capture at least 2 points for ${g.label}`);
  }
  if (tempKeys.length > 0 && !step3Done) saveBlockers.push('verify all temperature probes');

  const pillsHtml = devices
    .map((d) => `<button class="pill${d.id === id ? ' active' : ''}" data-module="${escapeHtml(d.id)}">${escapeHtml(d.name)}</button>`)
    .join('');

  const groupCardsHtml = groups
    .map((g) => {
      const gd = draft.groups[g.id];
      const cap = groupCapture(g.id);
      const zeroed = gd.zeroOffset !== null;
      const scaled = gd.points.length >= 2;
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

      const zeroCaption = cap.active && cap.kind === 'zero'
        ? `sampling&hellip; ${cap.samples.length}/${CAPTURE_SAMPLE_COUNT}`
        : zeroed
          ? `baseline&nbsp;${fmtNum(gd.zeroOffset, 2)}${escapeHtml(cap.lastResult?.kind === 'zero' ? captureQualityWarning(cap.lastResult) : '')}`
          : '';

      const captureCaption = cap.active && cap.kind === 'point'
        ? `sampling&hellip; ${cap.samples.length}/${CAPTURE_SAMPLE_COUNT}`
        : escapeHtml(cap.lastResult?.kind === 'point' ? captureQualityWarning(cap.lastResult) : '');

      return `
        <div class="card step-card group-card ${zeroed && scaled ? 'done' : 'current'}" data-group="${escapeHtml(g.id)}">
          <div class="step-header">
            <span class="step-token ${zeroed && scaled ? 'done' : 'current'}">${zeroed && scaled ? '✓' : ''}</span>
            <div class="step-title">${escapeHtml(g.label)}</div>
            <span class="step-status ${zeroed && scaled ? 'done' : 'current'}">${zeroed && scaled ? 'Done' : 'In progress'}</span>
          </div>
          <p class="step-desc">Channels: ${escapeHtml(g.keys.join(', '))}${g.keys.length > 1 ? ' (averaged as one reading)' : ''}</p>

          <p class="step-desc" style="margin-bottom:8px;">${zeroed
            ? `Tilt the stand and hang a known mass, then click Capture point once it's still - each click takes a fresh batch of ${CAPTURE_SAMPLE_COUNT} samples and averages them, so it doesn't matter what the reading was doing before you press it. Add at least 2 points (more, at different masses, for a tighter fit).`
            : `Keep the stand flat and still, then click Record zero - it takes ${CAPTURE_SAMPLE_COUNT} fresh samples and averages them for the baseline.`}</p>

          <div style="display:flex; align-items:center; gap:14px; margin-bottom:16px;">
            <button class="btn btn-secondary" data-role="record-zero" ${cap.active ? 'disabled' : ''}>${zeroed ? 'Re-record zero' : 'Record zero'}</button>
            <span class="mono" data-role="zero-caption" style="font-size:12.5px; color:var(--faint);">${zeroCaption}</span>
          </div>

          <div class="field-row">
            <label class="field">Known mass (kg)
              <input class="field-input" data-role="mass-input" type="number" step="0.001" min="0" value="${escapeHtml(gd.massInput)}" ${zeroed && !cap.active ? '' : 'disabled'} />
            </label>
            <label class="field">Gauge length (mm)
              <input class="field-input" data-role="length-input" type="number" step="0.1" min="0" value="${escapeHtml(gd.lengthInput)}" ${zeroed && !cap.active ? '' : 'disabled'} />
            </label>
            <button class="btn btn-primary" data-role="capture-point" style="height:39px;" ${zeroed && !cap.active ? '' : 'disabled'}>Capture point</button>
          </div>
          <div class="mono" data-role="capture-caption" style="font-size:12.5px; color:var(--faint); margin:-10px 0 14px;">${captureCaption}</div>
          <div class="cal-table">
            <div class="cal-table-head"><span>Pt</span><span>Mass</span><span>Reading</span><span>Residual</span></div>
            ${pointRows || '<div class="run-empty" style="grid-column:1/-1;">No points captured yet.</div>'}
          </div>
          ${scaled ? `<p class="step-desc" style="margin-top:10px; margin-bottom:0;">Residuals in <span class="res-bad">orange</span> are larger than expected for this fit - check the mass entry for that point, or add another point to improve the fit.</p>` : ''}
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
          <div>
            <span class="meta mono">${footerMeta}</span>
            ${!canSave && saveBlockers.length ? `<div class="step-desc" style="margin:6px 0 0; font-size:12px;">Before saving: ${escapeHtml(saveBlockers.join('; '))}.</div>` : ''}
            <div class="mono" id="save-status" style="margin-top:6px; font-size:12px; color:${saveStatus.state === 'error' ? 'var(--accent-text)' : 'var(--ok)'}; display:${saveStatus.state ? '' : 'none'};">${escapeHtml(saveStatus.message || '')}</div>
          </div>
          <div style="display:flex; gap:10px;">
            ${groups.length ? `<button class="btn btn-secondary" id="save-profile" ${canSave ? '' : 'disabled'}>Save as profile&hellip;</button>` : ''}
            <button class="btn btn-dark" id="save-calibration" ${canSave ? '' : 'disabled'}>${saveStatus.state === 'saving' ? 'Saving…' : 'Save calibration'}</button>
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
        <div class="readout-caption" id="readout-caption">${groups.length === 0 ? 'No load channels — verify probes above.' : 'Click Record zero or Capture point on a channel when the stand is ready.'}</div>
      </div>
    </div>

    <div class="card" style="margin-top:20px;">
      <div class="step-title" style="margin-bottom:6px;">Skip calibration</div>
      <p class="step-desc" style="margin-bottom:14px;">Just want to see what this module is reporting right now, without doing the tare/known-load steps? View its raw, uncalibrated data in Collect - you still won't be able to start an actual recording until it's calibrated, this is a quick sanity check only.</p>
      <button class="btn btn-secondary" id="skip-calibration">View raw data in Collect</button>
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

    card.querySelector('[data-role="record-zero"]')?.addEventListener('click', () => {
      const cap = groupCapture(gid);
      if (cap.active) return;
      cap.active = true;
      cap.kind = 'zero';
      cap.samples = [];
      store.notify();
    });
    card.querySelector('[data-role="mass-input"]')?.addEventListener('input', (e) => { draft.groups[gid].massInput = e.target.value; });
    card.querySelector('[data-role="length-input"]')?.addEventListener('input', (e) => { draft.groups[gid].lengthInput = e.target.value; });
    card.querySelector('[data-role="capture-point"]')?.addEventListener('click', () => {
      const cap = groupCapture(gid);
      if (cap.active) return;
      const mass = Number(card.querySelector('[data-role="mass-input"]').value);
      const length = Number(card.querySelector('[data-role="length-input"]').value);
      if (!(mass > 0)) return;
      cap.active = true;
      cap.kind = 'point';
      cap.samples = [];
      cap.pendingMass = mass;
      cap.pendingLength = length;
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
    saveStatus = { moduleId: id, state: 'saving', message: null };
    store.notify();
    try {
      await api.saveCalibration(id, record);
      store.state.calibrations[id] = record;
      // Deliberately keep the draft around (rather than clearing it) so
      // "Save as profile" is still available right after saving - it reads
      // canSave off the same draft, and this is the natural next action.
      const thisSave = (saveStatus = { moduleId: id, state: 'saved', message: `Saved ✓ (expires in ${daysBetween(Date.now(), record.expiresAt)} days)` });
      store.notify();
      // Auto-fade the success message after a few seconds so it reads as a
      // toast, not a permanent label - but only if nothing newer (another
      // save, a module switch) has replaced it in the meantime.
      setTimeout(() => {
        if (saveStatus === thisSave) {
          saveStatus = { moduleId: id, state: null, message: null };
          store.notify();
        }
      }, 4000);
    } catch (err) {
      console.error('Failed to save calibration', err);
      saveStatus = { moduleId: id, state: 'error', message: `Failed to save — ${err.message || 'check the server connection'} (retry?)` };
      store.notify();
    }
  });

  container.querySelector('#skip-calibration')?.addEventListener('click', () => {
    goToTab('collect', { collectModuleId: id });
  });

  // --- live patching ---
  // Two-tier reactivity: the raw readout number and a capture's in-progress
  // "sampling… n/8" text are patched directly here on every sample (liveBus
  // tier). Finishing a capture (applying a new zero/point) is a structural
  // change, so it goes through store.notify() instead - deferred to a
  // microtask so it doesn't tear down/rebuild this view's DOM (and its own
  // onLiveSample subscription) from inside liveBus's own dispatch loop.
  const unsubscribe = onLiveSample((msg) => {
    if (msg.id !== id) return;

    let finished = false;

    for (const g of groups) {
      const reading = groupReading(msg.values, g);
      if (reading === null) continue;

      const readoutEl = container.querySelector(`[data-readout-group="${CSS.escape(g.id)}"] [data-role="readout-value"]`);
      if (readoutEl) readoutEl.innerHTML = `${fmtNum(reading, 2)}<span class="readout-unit">raw</span>`;

      const cap = groupCapture(g.id);
      if (!cap.active) continue;

      cap.samples.push(reading);

      const card = container.querySelector(`.group-card[data-group="${CSS.escape(g.id)}"]`);
      const captionEl = card?.querySelector(cap.kind === 'zero' ? '[data-role="zero-caption"]' : '[data-role="capture-caption"]');
      if (captionEl) captionEl.textContent = `sampling… ${cap.samples.length}/${CAPTURE_SAMPLE_COUNT}`;

      if (cap.samples.length >= CAPTURE_SAMPLE_COUNT) {
        const { mean, stddev } = meanStddev(cap.samples);
        const kind = cap.kind;
        cap.active = false;
        cap.kind = null;
        cap.lastResult = { kind, mean, stddev };
        if (kind === 'zero') {
          draft.groups[g.id].zeroOffset = mean;
        } else {
          draft.groups[g.id].points.push({ mass: cap.pendingMass, length: cap.pendingLength, reading: mean });
        }
        finished = true;
      }
    }

    for (const k of tempKeys) {
      const readingEl = container.querySelector(`[data-probe-reading="${CSS.escape(k)}"]`);
      if (readingEl && Object.hasOwn(msg.values, k)) {
        readingEl.textContent = `${fmtNum(msg.values[k], 1)}${device?.channels?.[k]?.unit || ''}`;
      }
    }

    if (finished) queueMicrotask(() => store.notify());
  });

  return () => unsubscribe();
}
