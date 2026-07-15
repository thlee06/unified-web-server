// Thin UI over hotasControl.js's persistent singleton - this view only
// builds/patches DOM and forwards user actions. The WS connection, gamepad
// polling loop, and arm sequence all keep running in hotasControl.js
// independent of whether this view is mounted (see that file's header for
// why), so cleanup here only unsubscribes - it never disarms or disconnects.
import { escapeHtml, fmtNum } from '../format.js';
import {
  hotasState, onHotasChange, connectHotas, disconnectHotas, requestHotasDisarm,
  setHotasConfirmed, setAxisMapping, selectGamepad, connectedPads, buttonOn, rawAxis, uploadProfile,
  ARM_THROTTLE_GATE, BTN_INTERLOCK, BTN_HOLD, BTN_MASTER, HOLD_MS, BTN_AUTOPILOT_ENABLE, BTN_LAUNCH, LAUNCH_MS,
  btnLabel,
} from '../hotasControl.js';
import {
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile as deleteProfileStore,
  getActiveProfileId, setActiveProfileId, normalizePoints, interpolateThrottle, profileDurationMs,
  MAX_POINTS, MAX_DURATION_MS,
} from '../thrustProfile.js';

const CHART_W = 760;
const CHART_H = 200;
const CHART_PAD = 18;
const MIN_SPAN_MS = 5000; // avoids a degenerate near-zero-width chart with only one early point

function ensureActiveProfile() {
  let profiles = listProfiles();
  if (profiles.length === 0) {
    const p = createProfile('Default profile');
    profiles = [p];
    setActiveProfileId(p.id);
  }
  let activeId = getActiveProfileId();
  if (!activeId || !profiles.some((p) => p.id === activeId)) {
    activeId = profiles[0].id;
    setActiveProfileId(activeId);
  }
  return activeId;
}

function joinLabels(indices, sep = ' + ') {
  return indices.map(btnLabel).join(sep);
}

function chartSpanMs(points) {
  return Math.max(MIN_SPAN_MS, profileDurationMs(points) * 1.15);
}
function xForT(t, spanMs) { return CHART_PAD + (t / spanMs) * (CHART_W - 2 * CHART_PAD); }
function tForX(x, spanMs) { return Math.max(0, ((x - CHART_PAD) / (CHART_W - 2 * CHART_PAD)) * spanMs); }
function yForThrottle(v) { return CHART_PAD + (1 - v) * (CHART_H - 2 * CHART_PAD); }
function throttleForY(y) { return Math.max(0, Math.min(1, 1 - (y - CHART_PAD) / (CHART_H - 2 * CHART_PAD))); }

export function render(container) {
  const activeId = ensureActiveProfile();
  const local = {
    selectedGamepadIndexForPanel: hotasState.selectedGamepadIndex,
    axisEls: new Map(),
    buttonEls: new Map(),
    buttonPrevPressed: new Map(),
    lastButtonEl: null,
    profile: {
      activeId,
      points: getProfile(activeId).points,
      dragIndex: null,
      spanMs: MIN_SPAN_MS,
      circleEls: [],
      labelEls: [],
      rowEls: [],
      lineEl: null,
      progressEls: null,
      uploadTimer: null,
      uploadedForConnection: false,
    },
  };

  container.innerHTML = `
    <div class="page-header-row">
      <div>
        <div class="page-eyebrow">Control</div>
        <h1 class="page-title">HOTAS Throttle Control</h1>
      </div>
      <div class="page-summary mono">
        <span class="chip chip-warn" id="hotas-autopilot-chip">Button 26: off (manual arm)</span>
        <span class="chip chip-warn" id="hotas-conn-status">Disconnected</span>
      </div>
    </div>

    <div class="workflow-rail">
      <span class="workflow-label">SAFETY</span>
      <span class="workflow-note" style="margin-left:0;">
        This drives a live ESC output. Clear the prop before arming. The connection stays
        live while you use other tabs (e.g. Collect) - only closing/hiding the browser
        tab or Emergency disarm cuts it.
      </span>
    </div>

    <div class="hotas-layout">
      <div style="display:flex; flex-direction:column; gap:16px;">
        <div class="card">
          <div class="step-title" style="margin-bottom:14px;">ESP32 connection</div>
          <div class="field-row" style="margin-bottom:0;">
            <label class="field">Host
              <input class="field-input" id="hotas-host" type="text" value="${escapeHtml(hotasState.host)}" placeholder="hotas-esc.local" />
            </label>
            <button class="btn btn-primary" id="hotas-connect" style="height:39px;">Connect</button>
          </div>
        </div>

        <div class="card">
          <div class="step-title" style="margin-bottom:6px;">Arm sequence</div>
          <p class="step-desc" style="margin-bottom:14px;">Hold ${joinLabels(BTN_INTERLOCK)}, then hold ${joinLabels(BTN_HOLD)} for ${(HOLD_MS / 1000).toFixed(1)}s, then flip ${btnLabel(BTN_MASTER)}. Releasing ${joinLabels(BTN_INTERLOCK, ' / ')} at any point resets the whole sequence.</p>
          <div class="steps" style="gap:10px;">
            <div class="step-card current" id="hotas-seq-step1" style="padding:14px 16px;">
              <div class="step-header" style="margin-bottom:0;">
                <span class="step-token current" id="hotas-seq-step1-token"></span>
                <div class="step-title" style="font-size:13.5px;">Safety interlock &middot; ${joinLabels(BTN_INTERLOCK)}</div>
                <span class="step-status current" id="hotas-seq-step1-status">Waiting</span>
              </div>
            </div>
            <div class="step-card upcoming" id="hotas-seq-step2" style="padding:14px 16px;">
              <div class="step-header" style="margin-bottom:8px;">
                <span class="step-token upcoming" id="hotas-seq-step2-token"></span>
                <div class="step-title" style="font-size:13.5px;">Hold &middot; ${joinLabels(BTN_HOLD)} for ${(HOLD_MS / 1000).toFixed(1)}s</div>
                <span class="step-status upcoming" id="hotas-seq-step2-status">Upcoming</span>
              </div>
              <div class="axis-bar-track"><div class="axis-bar-fill" id="hotas-seq-hold-bar" style="width:0%"></div></div>
            </div>
            <div class="step-card upcoming" id="hotas-seq-step3" style="padding:14px 16px;">
              <div class="step-header" style="margin-bottom:0;">
                <span class="step-token upcoming" id="hotas-seq-step3-token"></span>
                <div class="step-title" style="font-size:13.5px;">Master arm &middot; ${btnLabel(BTN_MASTER)}</div>
                <span class="step-status upcoming" id="hotas-seq-step3-status">Upcoming</span>
              </div>
            </div>
          </div>
          <div class="step-desc" id="hotas-seq-note" style="margin-top:12px; margin-bottom:0;">Hold ${joinLabels(BTN_INTERLOCK, ' and ')} to begin.</div>
        </div>

        <div class="card" id="hotas-gamepad-panel"></div>
      </div>

      <div class="readout-panel">
        <div class="readout-eyebrow">Throttle control</div>

        <div class="readout-block">
          <div class="readout-label">Mapped throttle</div>
          <div class="readout-value primary mono" id="hotas-throttle-val">&mdash;</div>
          <div class="axis-bar-track" style="margin-top:10px;"><div class="axis-bar-fill" id="hotas-throttle-bar" style="width:0%"></div></div>
        </div>

        <div class="readout-block">
          <div class="readout-label">ESP32 state</div>
          <div class="readout-value mono" id="hotas-status-armed" style="font-size:20px;">DISARMED</div>
        </div>

        <div class="readout-block">
          <div class="readout-label">PWM output</div>
          <div class="readout-value mono" id="hotas-status-pwm" style="font-size:20px;">&mdash;<span class="readout-unit">&micro;s</span></div>
        </div>

        <div class="readout-block">
          <div class="readout-label">Mode</div>
          <div class="readout-value mono" id="hotas-mode-val" style="font-size:18px;">MANUAL</div>
          <div id="hotas-mode-extra" style="display:none; margin-top:8px;">
            <div class="axis-bar-track"><div class="axis-bar-fill" id="hotas-mode-bar" style="width:0%"></div></div>
            <div class="mono" id="hotas-mode-caption" style="font-size:11.5px; color:#8B867C; margin-top:6px;"></div>
          </div>
        </div>

        <div class="readout-caption" id="hotas-status-age">No status received yet.</div>

        <label style="display:flex; align-items:center; gap:8px; margin-top:20px; font-size:12.5px; color:#8B867C;">
          <input type="checkbox" id="hotas-confirm" ${hotasState.confirmed ? 'checked' : ''} />
          I confirm the output is safe to energize
        </label>
        <div class="readout-caption" id="hotas-arm-gate-note" style="margin-top:10px; padding-top:0; border-top:none;">Arming is driven entirely by the physical button sequence at left.</div>
        <button class="btn btn-block" id="hotas-disarm" style="margin-top:14px; background:#C0392B; color:#fff;">Emergency disarm</button>
      </div>
    </div>

    <div class="card" style="margin-top:20px;">
      <div class="step-header" style="margin-bottom:6px;">
        <div class="step-title">Thrust profile (autopilot)</div>
      </div>
      <p class="step-desc" style="margin-bottom:14px;">
        Plan a throttle-vs-time curve, then arm with ${btnLabel(BTN_AUTOPILOT_ENABLE)} held on to arm into
        autopilot mode instead of manual. Once armed, hold ${btnLabel(BTN_LAUNCH)} for ${(LAUNCH_MS / 1000).toFixed(1)}s
        to launch the profile below. The active profile is uploaded to the ESP32 automatically as you edit it.
      </p>

      <div id="hotas-profile-card"></div>
    </div>
  `;

  const hostInput = container.querySelector('#hotas-host');
  const connectBtn = container.querySelector('#hotas-connect');
  const connStatusEl = container.querySelector('#hotas-conn-status');
  const gamepadPanelEl = container.querySelector('#hotas-gamepad-panel');
  const confirmEl = container.querySelector('#hotas-confirm');
  const disarmBtn = container.querySelector('#hotas-disarm');
  const throttleBarEl = container.querySelector('#hotas-throttle-bar');
  const throttleValEl = container.querySelector('#hotas-throttle-val');
  const statusArmedEl = container.querySelector('#hotas-status-armed');
  const statusPwmEl = container.querySelector('#hotas-status-pwm');
  const statusAgeEl = container.querySelector('#hotas-status-age');
  const autopilotChipEl = container.querySelector('#hotas-autopilot-chip');
  const modeValEl = container.querySelector('#hotas-mode-val');
  const modeExtraEl = container.querySelector('#hotas-mode-extra');
  const modeBarEl = container.querySelector('#hotas-mode-bar');
  const modeCaptionEl = container.querySelector('#hotas-mode-caption');
  const profileCardEl = container.querySelector('#hotas-profile-card');

  const seqEls = {
    step1: container.querySelector('#hotas-seq-step1'),
    step1Token: container.querySelector('#hotas-seq-step1-token'),
    step1Status: container.querySelector('#hotas-seq-step1-status'),
    step2: container.querySelector('#hotas-seq-step2'),
    step2Token: container.querySelector('#hotas-seq-step2-token'),
    step2Status: container.querySelector('#hotas-seq-step2-status'),
    holdBar: container.querySelector('#hotas-seq-hold-bar'),
    step3: container.querySelector('#hotas-seq-step3'),
    step3Token: container.querySelector('#hotas-seq-step3-token'),
    step3Status: container.querySelector('#hotas-seq-step3-status'),
    note: container.querySelector('#hotas-seq-note'),
  };

  function setConnStatus() {
    const map = {
      idle: ['Disconnected', 'chip-warn'],
      connecting: ['Connecting…', 'chip-warn'],
      open: ['Connected', 'chip-ok'],
      closed: ['Disconnected', 'chip-warn'],
    };
    const [text, cls] = map[hotasState.wsStatus];
    connStatusEl.textContent = text;
    connStatusEl.className = `chip ${cls}`;
    connectBtn.textContent = hotasState.wsStatus === 'open' ? 'Disconnect' : 'Connect';
  }

  function patchStatus() {
    statusArmedEl.textContent = hotasState.armed ? 'ARMED' : 'DISARMED';
    statusArmedEl.style.color = hotasState.armed ? 'var(--accent)' : '#EFEDE7';
    statusPwmEl.innerHTML = `${hotasState.pwmUs ?? '—'}<span class="readout-unit">&micro;s</span>`;
    if (hotasState.lastStatusAt) {
      const ageMs = Date.now() - hotasState.lastStatusAt;
      statusAgeEl.textContent = ageMs > 2000
        ? 'No recent status from the ESP32 — check the connection.'
        : `Last status ${ageMs}ms ago · uptime ${Math.round((hotasState.uptimeMs ?? 0) / 1000)}s`;
    }
  }

  function setStepClass(cardEl, tokenEl, statusEl, state, label) {
    cardEl.className = `step-card ${state}`;
    tokenEl.className = `step-token ${state}`;
    tokenEl.textContent = state === 'done' ? '✓' : '';
    statusEl.className = `step-status ${state}`;
    statusEl.textContent = label;
  }

  function patchSeqUI(selectedPad) {
    const seq = hotasState.seq;
    const interlockOn = !!selectedPad && BTN_INTERLOCK.every((i) => buttonOn(selectedPad, i));
    const masterOn = !!selectedPad && buttonOn(selectedPad, BTN_MASTER);

    setStepClass(seqEls.step1, seqEls.step1Token, seqEls.step1Status,
      interlockOn ? 'done' : 'current',
      interlockOn ? 'Held' : 'Waiting');

    const step2State = seq.stage === 'ready' || hotasState.armed ? 'done' : (seq.stage === 'holding' ? 'current' : 'upcoming');
    const heldMs = seq.stage === 'holding' && seq.holdStartedAt ? performance.now() - seq.holdStartedAt : (step2State === 'done' ? HOLD_MS : 0);
    setStepClass(seqEls.step2, seqEls.step2Token, seqEls.step2Status,
      step2State,
      step2State === 'done' ? `Held ${(HOLD_MS / 1000).toFixed(1)}s` : step2State === 'current' ? `Holding… ${(heldMs / 1000).toFixed(1)}s` : 'Upcoming');
    seqEls.holdBar.style.width = `${Math.min(100, (heldMs / HOLD_MS) * 100).toFixed(0)}%`;

    const step3State = hotasState.armed ? 'done' : (seq.stage === 'ready' ? 'current' : 'upcoming');
    setStepClass(seqEls.step3, seqEls.step3Token, seqEls.step3Status,
      step3State,
      hotasState.armed ? 'Armed' : seq.armSent ? 'Sent, waiting for ESP32…' : step3State === 'current' ? `Flip ${btnLabel(BTN_MASTER)} to arm` : 'Upcoming');

    let note;
    if (hotasState.armed) note = 'Armed. Sequence will reset automatically on disarm.';
    else if (seq.armSent) note = 'Arm request sent — waiting for the ESP32 to confirm.';
    else if (seq.stage === 'ready' && masterOn && !seq.masterOffSeen) {
      note = `${btnLabel(BTN_MASTER)} has been on since before this attempt — flip it off, then on again, to arm.`;
    } else if (seq.stage === 'ready') {
      const blockers = [];
      if (hotasState.wsStatus !== 'open') blockers.push('connect to the ESP32');
      if (!hotasState.confirmed) blockers.push('check the confirm box');
      if (hotasState.throttle === null || hotasState.throttle >= ARM_THROTTLE_GATE) blockers.push('bring throttle to idle');

      if (masterOn && blockers.length) {
        // masterOffSeen must already be true here, or the branch above would have caught it -
        // the flip already registered, it's just waiting on something else now.
        note = `${btnLabel(BTN_MASTER)} is flipped — will arm automatically once you also: ${blockers.join(', ')}.`;
      } else if (blockers.length) {
        note = `Ready — flip ${btnLabel(BTN_MASTER)} to arm once you also: ${blockers.join(', ')}.`;
      } else {
        note = `Flip ${btnLabel(BTN_MASTER)} to arm.`;
      }
    } else if (seq.stage === 'holding') note = `Keep holding ${joinLabels(BTN_HOLD)}…`;
    else if (seq.stage === 'interlock') note = `Hold ${joinLabels(BTN_HOLD, ' and ')} for ${(HOLD_MS / 1000).toFixed(1)} seconds.`;
    else note = `Hold ${joinLabels(BTN_INTERLOCK, ' and ')} to begin.`;
    seqEls.note.textContent = note;
  }

  function refreshGamepadPanel() {
    const pads = connectedPads();
    local.selectedGamepadIndexForPanel = hotasState.selectedGamepadIndex;
    const selectedPad = pads.find((p) => p.index === local.selectedGamepadIndexForPanel) || null;

    const pickerHtml = pads.length
      ? `<div class="module-selector" style="margin-bottom:16px;">
          <span class="caption">Device</span>
          ${pads.map((p) => `<button class="pill${p.index === local.selectedGamepadIndexForPanel ? ' active' : ''}" data-gamepad-index="${p.index}">${escapeHtml(p.id)}</button>`).join('')}
        </div>`
      : '';

    const axesHtml = selectedPad
      ? selectedPad.axes.map((_, i) => {
          const mapping = hotasState.axisMap[selectedPad.id];
          const mapped = mapping?.axisIndex === i;
          return `
            <div class="axis-row" data-axis="${i}">
              <span class="name mono">Axis ${i}</span>
              <div class="axis-bar-track"><div class="axis-bar-fill" data-axis-bar="${i}" style="width:50%"></div></div>
              <span class="val mono" data-axis-val="${i}">0.00</span>
              <label class="invert-label"><input type="checkbox" data-axis-invert="${i}" ${mapping?.invert ? 'checked' : ''} ${mapped ? '' : 'disabled'} /> invert</label>
              <button class="btn ${mapped ? 'btn-secondary' : 'btn-primary'}" data-axis-map="${i}">${mapped ? 'Mapped ✓' : 'Use as throttle'}</button>
            </div>
          `;
        }).join('')
      : '<div class="empty-state">No controllers detected. Move a HOTAS axis to wake it up.</div>';

    const buttonsHtml = selectedPad
      ? `<div class="button-grid">${selectedPad.buttons.map((_, i) => `
          <div class="button-chip mono" data-button="${i}">${i}</div>
        `).join('')}</div>`
      : '';

    gamepadPanelEl.innerHTML = `
      <div class="step-title" style="margin-bottom:14px;">HOTAS input</div>
      ${pickerHtml}
      <div class="probe-list">${axesHtml}</div>
      ${selectedPad ? `
        <div class="step-title" style="margin:20px 0 12px; font-size:13px;">Buttons</div>
        <p class="step-desc" style="margin-bottom:10px;">Press a physical button to see its ID light up below.</p>
        ${buttonsHtml}
        <div class="mono" id="hotas-last-button" style="margin-top:12px; font-size:12.5px; color:var(--muted);">Press a button to identify its ID&hellip;</div>
      ` : ''}
    `;

    gamepadPanelEl.querySelectorAll('[data-gamepad-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectGamepad(Number(btn.dataset.gamepadIndex));
        refreshGamepadPanel();
      });
    });
    gamepadPanelEl.querySelectorAll('[data-axis-map]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const axisIndex = Number(btn.dataset.axisMap);
        const invertEl = gamepadPanelEl.querySelector(`[data-axis-invert="${axisIndex}"]`);
        setAxisMapping(selectedPad.id, axisIndex, !!invertEl?.checked);
        refreshGamepadPanel();
      });
    });
    gamepadPanelEl.querySelectorAll('[data-axis-invert]').forEach((chk) => {
      chk.addEventListener('change', () => {
        const axisIndex = Number(chk.dataset.axisInvert);
        const mapping = hotasState.axisMap[selectedPad.id];
        if (mapping && mapping.axisIndex === axisIndex) {
          setAxisMapping(selectedPad.id, axisIndex, chk.checked);
        }
      });
    });

    local.axisEls = new Map();
    gamepadPanelEl.querySelectorAll('[data-axis]').forEach((row) => {
      const i = Number(row.dataset.axis);
      local.axisEls.set(i, {
        bar: row.querySelector(`[data-axis-bar="${i}"]`),
        val: row.querySelector(`[data-axis-val="${i}"]`),
      });
    });

    local.buttonEls = new Map();
    gamepadPanelEl.querySelectorAll('[data-button]').forEach((chip) => {
      local.buttonEls.set(Number(chip.dataset.button), chip);
    });
    local.buttonPrevPressed = new Map();
    local.lastButtonEl = gamepadPanelEl.querySelector('#hotas-last-button');
  }

  function patchProfileProgress() {
    const els = local.profile.progressEls;
    if (!els) return;
    if (hotasState.mode !== 'autopilot_running' || hotasState.autopilotElapsedMs === null) {
      els.line.style.display = 'none';
      els.dot.style.display = 'none';
      return;
    }
    const t = hotasState.autopilotElapsedMs;
    const throttle = interpolateThrottle(local.profile.points, t);
    const x = xForT(t, local.profile.spanMs);
    const y = yForThrottle(throttle);
    els.line.setAttribute('x1', x.toFixed(1));
    els.line.setAttribute('x2', x.toFixed(1));
    els.line.style.display = '';
    els.dot.setAttribute('cx', x.toFixed(1));
    els.dot.setAttribute('cy', y.toFixed(1));
    els.dot.style.display = '';
  }

  function patchModeUI() {
    autopilotChipEl.textContent = hotasState.autopilotEnabled
      ? `${btnLabel(BTN_AUTOPILOT_ENABLE)}: on (will autopilot-arm)`
      : `${btnLabel(BTN_AUTOPILOT_ENABLE)}: off (manual arm)`;
    autopilotChipEl.className = `chip ${hotasState.autopilotEnabled ? 'chip-ok' : 'chip-warn'}`;

    const modeLabels = { manual: 'MANUAL', autopilot_armed: 'AUTOPILOT ARMED', autopilot_running: 'AUTOPILOT RUNNING' };
    modeValEl.textContent = modeLabels[hotasState.mode] || 'MANUAL';
    modeValEl.style.color = hotasState.mode === 'autopilot_running' ? 'var(--accent)' : '#EFEDE7';

    if (hotasState.mode === 'autopilot_armed') {
      modeExtraEl.style.display = '';
      const launch = hotasState.launch;
      const heldMs = launch.holdStartedAt ? performance.now() - launch.holdStartedAt : 0;
      modeBarEl.style.width = `${Math.min(100, (heldMs / LAUNCH_MS) * 100).toFixed(0)}%`;
      modeCaptionEl.textContent = launch.sent
        ? 'Launch sent — waiting for the ESP32 to start the profile…'
        : launch.holdStartedAt
          ? `Hold ${btnLabel(BTN_LAUNCH)}… ${(heldMs / 1000).toFixed(1)}s / ${(LAUNCH_MS / 1000).toFixed(1)}s`
          : `Hold ${btnLabel(BTN_LAUNCH)} for ${(LAUNCH_MS / 1000).toFixed(1)}s to launch the profile.`;
    } else if (hotasState.mode === 'autopilot_running') {
      modeExtraEl.style.display = '';
      const durationMs = profileDurationMs(local.profile.points);
      const elapsed = hotasState.autopilotElapsedMs ?? 0;
      const pct = durationMs > 0 ? Math.min(100, (elapsed / durationMs) * 100) : 0;
      modeBarEl.style.width = `${pct.toFixed(0)}%`;
      modeCaptionEl.textContent = `Running… ${(elapsed / 1000).toFixed(1)}s / ${(durationMs / 1000).toFixed(1)}s`;
    } else {
      modeExtraEl.style.display = 'none';
    }

    patchProfileProgress();
  }

  function patchFrame() {
    const pads = connectedPads();
    const selectedPad = pads.find((p) => p.index === hotasState.selectedGamepadIndex) || null;

    if (hotasState.wsStatus === 'open') {
      if (!local.profile.uploadedForConnection) {
        uploadProfile(local.profile.points);
        local.profile.uploadedForConnection = true;
      }
    } else {
      local.profile.uploadedForConnection = false;
    }

    if (selectedPad && local.selectedGamepadIndexForPanel === selectedPad.index) {
      for (const [i, els] of local.axisEls) {
        const raw = rawAxis(selectedPad, i);
        const pct = ((raw + 1) / 2) * 100;
        if (els.bar) els.bar.style.width = `${pct.toFixed(1)}%`;
        if (els.val) els.val.textContent = raw.toFixed(2);
      }
      for (const [i, chip] of local.buttonEls) {
        const pressed = buttonOn(selectedPad, i);
        chip.classList.toggle('active', pressed);
        if (pressed && !local.buttonPrevPressed.get(i) && local.lastButtonEl) {
          local.lastButtonEl.textContent = `Last pressed: Button ${i}`;
        }
        local.buttonPrevPressed.set(i, pressed);
      }
    }

    if (hotasState.throttle !== null) {
      throttleValEl.textContent = hotasState.throttle.toFixed(2);
      throttleBarEl.style.width = `${(hotasState.throttle * 100).toFixed(1)}%`;
    } else {
      throttleValEl.textContent = '—';
      throttleBarEl.style.width = '0%';
    }

    setConnStatus();
    patchStatus();
    patchSeqUI(selectedPad);
    patchModeUI();
  }

  // --- thrust profile editor ---

  function scheduleUpload() {
    clearTimeout(local.profile.uploadTimer);
    local.profile.uploadTimer = setTimeout(() => uploadProfile(local.profile.points), 300);
  }

  function commitPoints(points) {
    const normalized = normalizePoints(points);
    local.profile.points = normalized;
    updateProfile(local.profile.activeId, { points: normalized });
    scheduleUpload();
    renderProfileCard();
  }

  function patchAllPointPositions() {
    const spanMs = chartSpanMs(local.profile.points);
    local.profile.spanMs = spanMs;
    local.profile.points.forEach((p, i) => {
      const cx = xForT(p.t, spanMs);
      const cy = yForThrottle(p.throttle);
      const circle = local.profile.circleEls[i];
      if (circle) {
        circle.setAttribute('cx', cx.toFixed(1));
        circle.setAttribute('cy', cy.toFixed(1));
      }
      const label = local.profile.labelEls[i];
      if (label) {
        label.setAttribute('x', (cx + 10).toFixed(1));
        label.setAttribute('y', (cy - 10).toFixed(1));
      }
      const row = local.profile.rowEls[i];
      if (row) {
        // Never overwrite the input the user is actively typing into - it's
        // already showing exactly what they typed. Reformatting it (e.g.
        // padding "1" to "1.00") on every keystroke used to yank focus/cursor
        // and made it impossible to type anything past the first character.
        // The canonical formatted value still lands once they blur (via
        // commitPoints -> renderProfileCard on the 'change' event).
        if (document.activeElement !== row.timeInput) row.timeInput.value = (p.t / 1000).toFixed(2);
        if (document.activeElement !== row.throttleInput) row.throttleInput.value = Math.round(p.throttle * 100);
      }
    });
    if (local.profile.lineEl) {
      const sorted = [...local.profile.points].sort((a, b) => a.t - b.t);
      local.profile.lineEl.setAttribute('points', sorted.map((pt) => `${xForT(pt.t, spanMs).toFixed(1)},${yForThrottle(pt.throttle).toFixed(1)}`).join(' '));
    }
    patchProfileProgress();
  }

  function svgLocalPoint(svg, clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (CHART_W / rect.width),
      y: (clientY - rect.top) * (CHART_H / rect.height),
    };
  }

  function renderProfileCard() {
    const profiles = listProfiles();
    const points = local.profile.points;
    const spanMs = chartSpanMs(points);
    local.profile.spanMs = spanMs;
    const sorted = [...points].sort((a, b) => a.t - b.t);
    const linePoints = sorted.map((p) => `${xForT(p.t, spanMs).toFixed(1)},${yForThrottle(p.throttle).toFixed(1)}`).join(' ');

    const pillsHtml = profiles.map((p) => `<button class="pill${p.id === local.profile.activeId ? ' active' : ''}" data-profile-select="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`).join('');

    const circlesHtml = points.map((p, i) => `
      <circle data-point-circle="${i}" cx="${xForT(p.t, spanMs).toFixed(1)}" cy="${yForThrottle(p.throttle).toFixed(1)}" r="7" fill="var(--accent)" stroke="#fff" stroke-width="2" style="cursor:grab;"></circle>
      <text data-point-label="${i}" class="point-label" x="${(xForT(p.t, spanMs) + 10).toFixed(1)}" y="${(yForThrottle(p.throttle) - 10).toFixed(1)}">${i + 1}</text>
    `).join('');

    const rowsHtml = points.map((p, i) => `
      <div class="cal-table-row point-row" data-point-row="${i}">
        <span class="pt">${String(i + 1).padStart(2, '0')}</span>
        <span><input class="field-input point-input" type="number" step="0.01" min="0" data-point-time="${i}" value="${(p.t / 1000).toFixed(2)}" /></span>
        <span><input class="field-input point-input" type="number" step="1" min="0" max="100" data-point-throttle="${i}" value="${Math.round(p.throttle * 100)}" /></span>
        <button class="btn btn-secondary" data-point-delete="${i}" ${points.length <= 2 ? 'disabled' : ''}>Delete</button>
      </div>
    `).join('');

    const durationMs = profileDurationMs(points);

    profileCardEl.innerHTML = `
      <div class="module-selector" style="margin-bottom:16px;">
        <span class="caption">Profile</span>
        ${pillsHtml}
        <button class="btn btn-secondary" id="profile-new">+ New</button>
      </div>

      <div class="profile-chart-wrap">
        <svg viewBox="0 0 ${CHART_W} ${CHART_H}" id="profile-svg">
          <line class="gridline" x1="0" y1="${(CHART_H / 4).toFixed(1)}" x2="${CHART_W}" y2="${(CHART_H / 4).toFixed(1)}"></line>
          <line class="gridline" x1="0" y1="${(CHART_H / 2).toFixed(1)}" x2="${CHART_W}" y2="${(CHART_H / 2).toFixed(1)}"></line>
          <line class="gridline" x1="0" y1="${(CHART_H * 3 / 4).toFixed(1)}" x2="${CHART_W}" y2="${(CHART_H * 3 / 4).toFixed(1)}"></line>
          <polyline id="profile-line" points="${linePoints}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"></polyline>
          <line id="profile-progress-line" x1="0" y1="0" x2="0" y2="${CHART_H}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="4 3" style="display:none;"></line>
          <circle id="profile-progress-dot" cx="0" cy="0" r="5" fill="var(--ink)" style="display:none;"></circle>
          ${circlesHtml}
        </svg>
        <div class="profile-axis-caption">Click empty space on the chart to add a point, or use "+ Add point" below &middot; drag a point to adjust &middot; fine-tune exact values in the table</div>
      </div>

      <div style="display:flex; justify-content:flex-end; margin-top:10px;">
        <button class="btn btn-secondary" id="profile-add-point" ${points.length >= MAX_POINTS ? 'disabled' : ''}>+ Add point</button>
      </div>

      <div class="cal-table" style="margin-top:10px;">
        <div class="cal-table-head"><span>Pt</span><span>Time (s)</span><span>Throttle (%)</span><span></span></div>
        ${rowsHtml}
      </div>

      <div class="cal-footer">
        <span class="meta mono" id="profile-duration-meta">Duration: ${(durationMs / 1000).toFixed(1)}s &middot; ${points.length} point${points.length === 1 ? '' : 's'}</span>
        <div style="display:flex; gap:10px;">
          <button class="btn btn-secondary" id="profile-rename">Rename&hellip;</button>
          <button class="btn btn-secondary" id="profile-delete" ${profiles.length <= 1 ? 'disabled' : ''}>Delete profile</button>
          <button class="btn btn-dark" id="profile-upload">Upload to ESP32 now</button>
        </div>
      </div>
    `;

    local.profile.circleEls = points.map((_, i) => profileCardEl.querySelector(`[data-point-circle="${i}"]`));
    local.profile.labelEls = points.map((_, i) => profileCardEl.querySelector(`[data-point-label="${i}"]`));
    local.profile.rowEls = points.map((_, i) => ({
      timeInput: profileCardEl.querySelector(`[data-point-time="${i}"]`),
      throttleInput: profileCardEl.querySelector(`[data-point-throttle="${i}"]`),
    }));
    local.profile.lineEl = profileCardEl.querySelector('#profile-line');
    local.profile.progressEls = {
      line: profileCardEl.querySelector('#profile-progress-line'),
      dot: profileCardEl.querySelector('#profile-progress-dot'),
    };

    const svgEl = profileCardEl.querySelector('#profile-svg');

    local.profile.circleEls.forEach((circle, i) => {
      if (!circle) return;
      circle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        local.profile.dragIndex = i;
        circle.setPointerCapture(e.pointerId);
        circle.style.cursor = 'grabbing';
      });
    });
    svgEl.addEventListener('pointermove', (e) => {
      if (local.profile.dragIndex === null) return;
      const { x, y } = svgLocalPoint(svgEl, e.clientX, e.clientY);
      const i = local.profile.dragIndex;
      local.profile.points[i] = { t: tForX(x, local.profile.spanMs), throttle: throttleForY(y) };
      patchAllPointPositions();
    });
    const endDrag = () => {
      if (local.profile.dragIndex === null) return;
      local.profile.dragIndex = null;
      commitPoints(local.profile.points);
    };
    svgEl.addEventListener('pointerup', endDrag);
    svgEl.addEventListener('pointercancel', endDrag);

    svgEl.addEventListener('click', (e) => {
      if (local.profile.dragIndex !== null) return;
      if (e.target.closest('[data-point-circle]')) return;
      const { x, y } = svgLocalPoint(svgEl, e.clientX, e.clientY);
      commitPoints([...local.profile.points, { t: tForX(x, local.profile.spanMs), throttle: throttleForY(y) }]);
    });

    profileCardEl.querySelectorAll('[data-profile-select]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.profileSelect;
        local.profile.activeId = id;
        setActiveProfileId(id);
        local.profile.points = getProfile(id).points;
        scheduleUpload();
        renderProfileCard();
      });
    });
    profileCardEl.querySelector('#profile-new')?.addEventListener('click', () => {
      const name = window.prompt('New profile name:', 'New profile');
      if (!name) return;
      const p = createProfile(name);
      local.profile.activeId = p.id;
      setActiveProfileId(p.id);
      local.profile.points = p.points;
      scheduleUpload();
      renderProfileCard();
    });
    profileCardEl.querySelector('#profile-rename')?.addEventListener('click', () => {
      const current = getProfile(local.profile.activeId);
      const name = window.prompt('Rename profile to:', current?.name || '');
      if (!name) return;
      updateProfile(local.profile.activeId, { name });
      renderProfileCard();
    });
    profileCardEl.querySelector('#profile-delete')?.addEventListener('click', () => {
      if (profiles.length <= 1) return;
      if (!window.confirm('Delete this profile?')) return;
      deleteProfileStore(local.profile.activeId);
      const nextId = ensureActiveProfile();
      local.profile.activeId = nextId;
      local.profile.points = getProfile(nextId).points;
      scheduleUpload();
      renderProfileCard();
    });
    profileCardEl.querySelector('#profile-upload')?.addEventListener('click', () => {
      uploadProfile(local.profile.points);
    });
    profileCardEl.querySelector('#profile-add-point')?.addEventListener('click', () => {
      if (local.profile.points.length >= MAX_POINTS) return;
      const last = local.profile.points[local.profile.points.length - 1];
      const t = last ? Math.min(MAX_DURATION_MS, last.t + 1000) : 0;
      const throttle = last ? last.throttle : 0;
      commitPoints([...local.profile.points, { t, throttle }]);
    });

    points.forEach((p, i) => {
      const row = local.profile.rowEls[i];
      if (!row) return;
      row.timeInput.addEventListener('input', () => {
        const v = Number(row.timeInput.value);
        if (Number.isFinite(v)) {
          local.profile.points[i] = { ...local.profile.points[i], t: Math.max(0, v * 1000) };
          patchAllPointPositions();
        }
      });
      row.timeInput.addEventListener('change', () => commitPoints(local.profile.points));
      row.throttleInput.addEventListener('input', () => {
        const v = Number(row.throttleInput.value);
        if (Number.isFinite(v)) {
          local.profile.points[i] = { ...local.profile.points[i], throttle: Math.max(0, Math.min(100, v)) / 100 };
          patchAllPointPositions();
        }
      });
      row.throttleInput.addEventListener('change', () => commitPoints(local.profile.points));
    });
    profileCardEl.querySelectorAll('[data-point-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.pointDelete);
        if (local.profile.points.length <= 2) return;
        commitPoints(local.profile.points.filter((_, idx) => idx !== i));
      });
    });

    patchProfileProgress();
  }

  function onGamepadConnected() { refreshGamepadPanel(); patchFrame(); }
  function onGamepadDisconnected() { refreshGamepadPanel(); patchFrame(); }

  window.addEventListener('gamepadconnected', onGamepadConnected);
  window.addEventListener('gamepaddisconnected', onGamepadDisconnected);

  connectBtn.addEventListener('click', () => {
    if (hotasState.wsStatus === 'open') disconnectHotas();
    else connectHotas(hostInput.value.trim() || hotasState.host);
  });
  disarmBtn.addEventListener('click', requestHotasDisarm);
  confirmEl.addEventListener('change', () => setHotasConfirmed(confirmEl.checked));

  refreshGamepadPanel();
  renderProfileCard();
  patchFrame();
  const unsubscribe = onHotasChange(patchFrame);

  return () => {
    unsubscribe();
    clearTimeout(local.profile.uploadTimer);
    window.removeEventListener('gamepadconnected', onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
  };
}
