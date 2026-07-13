import { store, deviceList, goToTab } from '../state.js';
import { isCalibrated } from '../calibration.js';
import { relTime, escapeHtml } from '../format.js';

function lastActivityText(device, calRecord) {
  if (calRecord && !isCalibrated(calRecord)) return 'Cal expired';
  const runs = store.state.runs.filter((r) => r.moduleIds.includes(device.id));
  if (runs.length > 0) {
    const mostRecent = runs.reduce((a, b) => (a.endedAt > b.endedAt ? a : b));
    return `Collected ${relTime(mostRecent.endedAt)}`;
  }
  return device.lastSeen ? 'Idle' : 'Never';
}

export function render(container) {
  const devices = deviceList();
  const onlineCount = devices.filter((d) => d.status === 'online').length;

  const cardsHtml = devices
    .map((d) => {
      const calRecord = store.state.calibrations[d.id];
      const calibrated = isCalibrated(calRecord);
      const activity = lastActivityText(d, calRecord);
      return `
        <div class="card device-card" data-device="${escapeHtml(d.id)}">
          <div class="device-card-top">
            <div>
              <div class="device-name">${escapeHtml(d.name)}</div>
              <div class="device-mac mono">${escapeHtml(d.id)}</div>
            </div>
            <div class="device-online${d.status === 'online' ? '' : ' offline'}">
              <span class="dot"></span>${d.status === 'online' ? 'online' : 'offline'}
            </div>
          </div>
          <div class="device-row">
            <span class="label">Calibration</span>
            <span class="chip ${calibrated ? 'chip-ok' : 'chip-warn'}">${calibrated ? 'Calibrated' : 'Needs calibration'}</span>
          </div>
          <div class="device-row">
            <span class="label">Last activity</span>
            <span class="value mono">${escapeHtml(activity)}</span>
          </div>
          <button class="btn ${calibrated ? 'btn-secondary' : 'btn-primary'}" data-action="${calibrated ? 'collect' : 'calibrate'}">
            ${calibrated ? 'Collect data' : 'Calibrate now'}
          </button>
        </div>
      `;
    })
    .join('');

  container.innerHTML = `
    <div class="page-header-row">
      <div>
        <div class="page-eyebrow">Overview</div>
        <h1 class="page-title">Test stand modules</h1>
      </div>
      <div class="page-summary mono">
        <span>${devices.length} module${devices.length === 1 ? '' : 's'}</span>
        <span class="sep">/</span>
        <span class="ok">${onlineCount} online</span>
      </div>
    </div>

    <div class="workflow-rail">
      <span class="workflow-label">WORKFLOW</span>
      <div class="workflow-steps">
        <b>1 · Calibrate</b><span class="arrow">→</span><b>2 · Collect</b><span class="arrow">→</span><b>3 · Analyze</b>
      </div>
      <span class="workflow-note">A module must be calibrated before it can collect.</span>
    </div>

    <div class="device-grid">
      ${cardsHtml || '<div class="empty-state">Waiting for modules to connect&hellip;</div>'}
    </div>
  `;

  container.querySelectorAll('.device-card').forEach((card) => {
    const id = card.dataset.device;
    const btn = card.querySelector('[data-action]');
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'collect') goToTab('collect', { collectModuleId: id });
      else goToTab('calibrate', { calModuleId: id });
    });
  });
}
