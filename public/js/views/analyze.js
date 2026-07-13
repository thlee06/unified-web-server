import { store, deviceList } from '../state.js';
import { api } from '../api.js';
import { loadChannelGroups, tempChannelKeys, groupReadingAt, applyCalibration } from '../calibration.js';
import { toPath, decimate, seriesColor } from '../charts.js';
import { fmtDate, fmtTime, fmtDuration, fmtNum, escapeHtml } from '../format.js';

const CHART_W = 900;
const CHART_H = 220;
const CHART_PAD = 22;
const MAX_CHART_POINTS = 900;

function activeRunId(runs) {
  const stored = store.state.selectedRunId;
  if (stored && runs.some((r) => r.id === stored)) return stored;
  return runs[0]?.id || null;
}

async function ensureRunDetail(id) {
  if (!id || store.state.runDetails[id]) return;
  try {
    const run = await api.fetchRun(id);
    store.state.runDetails[id] = run;
    store.notify();
  } catch (err) {
    console.error('Failed to load run detail', err);
  }
}

function moduleNames(moduleIds) {
  return moduleIds
    .map((id) => store.state.devices.get(id)?.name || id)
    .join(', ');
}

// One entry per load-channel group across every module in the run (usually
// just one module, but a run can record several at once).
function loadSeriesList(run) {
  const moduleIds = run.moduleIds || [];
  const multiModule = moduleIds.length > 1;
  const list = [];
  for (const moduleId of moduleIds) {
    const channels = run.channelMeta?.[moduleId] || {};
    const groups = run.loadGroups?.[moduleId] || loadChannelGroups(channels, moduleId);
    const record = run.calibrationSnapshot?.[moduleId];
    const buf = run.series?.[moduleId];
    if (!buf) continue;
    const moduleName = store.state.devices.get(moduleId)?.name || moduleId;
    for (const g of groups) {
      const gRecord = record?.groups?.[g.id];
      if (!gRecord) continue;
      const vals = [];
      for (let i = 0; i < buf.t.length; i++) {
        const raw = groupReadingAt(buf, g, i);
        if (raw === null) continue;
        vals.push(applyCalibration(raw, gRecord));
      }
      if (vals.length) list.push({ id: `${moduleId}:${g.id}`, label: multiModule ? `${moduleName} · ${g.label}` : g.label, values: vals });
    }
  }
  return list;
}

// One entry per individual temperature probe across every module in the run.
function tempSeriesList(run) {
  const moduleIds = run.moduleIds || [];
  const multiModule = moduleIds.length > 1;
  const list = [];
  for (const moduleId of moduleIds) {
    const channels = run.channelMeta?.[moduleId] || {};
    const buf = run.series?.[moduleId];
    if (!buf) continue;
    const moduleName = store.state.devices.get(moduleId)?.name || moduleId;
    for (const k of tempChannelKeys(channels)) {
      const vals = (buf.values[k] || []).filter((v) => v !== null);
      if (vals.length) {
        const label = channels[k]?.label || k;
        list.push({ id: `${moduleId}:${k}`, label: multiModule ? `${moduleName} · ${label}` : label, values: vals });
      }
    }
  }
  return list;
}

function groupStatCards(run) {
  const cards = [];
  const moduleIds = run.moduleIds || [];
  const multiModule = moduleIds.length > 1;
  for (const moduleId of moduleIds) {
    const groups = run.loadGroups?.[moduleId] || [];
    const moduleName = store.state.devices.get(moduleId)?.name || moduleId;
    for (const g of groups) {
      const stat = run.stats?.groups?.[moduleId]?.[g.id];
      if (!stat) continue;
      const label = multiModule ? `${moduleName} · ${g.label}` : g.label;
      cards.push({ label: `${label} peak`, value: fmtNum(stat.peak, 2), unit: 'N' });
      cards.push({ label: `${label} mean`, value: fmtNum(stat.mean, 2), unit: 'N' });
    }
  }
  return cards;
}

function tempStatCards(run) {
  const cards = [];
  const moduleIds = run.moduleIds || [];
  const multiModule = moduleIds.length > 1;
  for (const moduleId of moduleIds) {
    const channels = run.channelMeta?.[moduleId] || {};
    const moduleName = store.state.devices.get(moduleId)?.name || moduleId;
    for (const k of tempChannelKeys(channels)) {
      const stat = run.stats?.temp?.[moduleId]?.[k];
      if (!stat) continue;
      const label = channels[k]?.label || k;
      const unit = channels[k]?.unit || run.tempUnit || '';
      cards.push({ label: multiModule ? `${moduleName} · ${label} max` : `${label} max`, value: fmtNum(stat.max, 1), unit });
    }
  }
  return cards;
}

function probeCount(run) {
  return (run.moduleIds || []).reduce((sum, id) => sum + tempChannelKeys(run.channelMeta?.[id]).length, 0);
}

function exportReport(run) {
  const lines = [
    `TestStand run report`,
    `Run: ${run.name}`,
    `Started: ${new Date(run.startedAt).toLocaleString()}`,
    `Ended: ${new Date(run.endedAt).toLocaleString()}`,
    `Duration: ${fmtDuration(Math.round((run.endedAt - run.startedAt) / 1000))}`,
    `Modules: ${moduleNames(run.moduleIds)}`,
    '',
  ];
  for (const card of groupStatCards(run)) lines.push(`${card.label}: ${card.value} ${card.unit}`);
  for (const card of tempStatCards(run)) lines.push(`${card.label}: ${card.value} ${card.unit}`);
  lines.push(`Samples: ${run.stats.sampleCount}`);

  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${run.id}-report.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function multiLineChart(seriesList, valueSuffix) {
  const decimated = seriesList.map((s) => ({ ...s, values: decimate(s.values, MAX_CHART_POINTS) }));
  const legend = decimated
    .map((s, i) => `
      <div class="legend-item">
        <span class="legend-swatch" style="background:${seriesColor(i)}"></span>${escapeHtml(s.label)}
      </div>
    `)
    .join('');
  const lines = decimated
    .map((s, i) => `<polyline points="${toPath(s.values, CHART_W, CHART_H, CHART_PAD)}" fill="none" stroke="${seriesColor(i)}" stroke-width="2" stroke-linejoin="round"></polyline>`)
    .join('');
  return `
    ${decimated.length ? `<div class="legend">${legend}</div>` : `<div class="run-empty">No ${valueSuffix} data for this run.</div>`}
    <svg viewBox="0 0 ${CHART_W} ${CHART_H}">
      <line class="gridline" x1="0" y1="55" x2="${CHART_W}" y2="55"></line>
      <line class="gridline" x1="0" y1="110" x2="${CHART_W}" y2="110"></line>
      <line class="gridline" x1="0" y1="165" x2="${CHART_W}" y2="165"></line>
      ${lines}
    </svg>
  `;
}

export function render(container) {
  deviceList(); // ensure device map access is warmed (names used below)
  const runs = store.state.runs;
  const id = activeRunId(runs);
  ensureRunDetail(id);

  if (runs.length === 0) {
    container.innerHTML = `
      <div class="page-eyebrow">Step 3</div>
      <h1 class="page-title" style="margin-bottom:20px;">Analyze runs</h1>
      <div class="empty-state">No runs yet. Collect some data first.</div>
    `;
    return;
  }

  const listHtml = runs
    .map((r) => `
      <button class="run-row${r.id === id ? ' active' : ''}" data-run="${escapeHtml(r.id)}">
        <div class="title">${escapeHtml(r.name)}</div>
        <div class="meta mono">${fmtDate(r.startedAt)} &middot; ${fmtDuration(Math.round((r.endedAt - r.startedAt) / 1000))} &middot; ${escapeHtml(moduleNames(r.moduleIds))}</div>
      </button>
    `)
    .join('');

  const run = store.state.runDetails[id];

  let detailHtml;
  if (!run) {
    detailHtml = `<div class="empty-state">Loading run&hellip;</div>`;
  } else {
    const stats = [
      ...groupStatCards(run),
      ...tempStatCards(run),
      { label: 'Samples', value: run.stats.sampleCount.toLocaleString(), unit: '' },
    ];

    detailHtml = `
      <div class="run-detail-header">
        <div>
          <div class="run-detail-title">${escapeHtml(run.name)}</div>
          <div class="run-detail-meta mono">${fmtDate(run.startedAt)} &middot; ${fmtTime(run.startedAt)} &middot; ${fmtDuration(Math.round((run.endedAt - run.startedAt) / 1000))} &middot; ${escapeHtml(moduleNames(run.moduleIds))}</div>
        </div>
        <div class="run-detail-actions">
          <a class="btn btn-secondary" href="${api.csvUrl(run.id)}" download>Download CSV</a>
          <button class="btn btn-dark" id="export-report">Export report</button>
        </div>
      </div>

      <div class="stat-grid">
        ${stats.map((s) => `
          <div class="card stat-card">
            <div class="stat-label">${escapeHtml(s.label)}</div>
            <div class="stat-value mono">${s.value}<span class="unit">${escapeHtml(s.unit)}</span></div>
          </div>
        `).join('')}
      </div>

      <div class="card chart-card">
        <div class="chart-label" style="margin-bottom:14px;">Load channels vs. time <span style="color:var(--faint);">&middot; N</span></div>
        ${multiLineChart(loadSeriesList(run), 'load')}
      </div>
      <div class="card chart-card">
        <div class="chart-label" style="margin-bottom:14px;">Temperature vs. time <span style="color:var(--faint);">&middot; ${escapeHtml(run.tempUnit)} &middot; ${probeCount(run)} probes</span></div>
        ${multiLineChart(tempSeriesList(run), 'temperature')}
      </div>
    `;
  }

  container.innerHTML = `
    <div class="page-eyebrow">Step 3</div>
    <h1 class="page-title" style="margin-bottom:20px;">Analyze runs</h1>
    <div class="analyze-layout">
      <div class="card run-list">${listHtml}</div>
      <div class="run-detail">${detailHtml}</div>
    </div>
  `;

  container.querySelectorAll('[data-run]').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.state.selectedRunId = btn.dataset.run;
      store.notify();
    });
  });

  container.querySelector('#export-report')?.addEventListener('click', () => {
    if (run) exportReport(run);
  });
}
