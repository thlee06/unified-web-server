import { store, goToTab } from './state.js';
import { connectDashboard } from './ws.js';
import { initRecorder } from './recorder.js';
import { api } from './api.js';
import * as devicesView from './views/devices.js';
import * as calibrateView from './views/calibrate.js';
import * as collectView from './views/collect.js';
import * as analyzeView from './views/analyze.js';
import * as hotasView from './views/hotas.js';

const TABS = [
  { id: 'devices', num: '·', label: 'Devices' },
  { id: 'calibrate', num: '1', label: 'Calibrate' },
  { id: 'collect', num: '2', label: 'Collect' },
  { id: 'analyze', num: '3', label: 'Analyze' },
  { id: 'hotas', num: '·', label: 'HOTAS Control' },
];

const VIEWS = {
  devices: devicesView,
  calibrate: calibrateView,
  collect: collectView,
  analyze: analyzeView,
  hotas: hotasView,
};

const connIndicatorEl = document.getElementById('conn-indicator');
const connTextEl = document.getElementById('conn-text');
const tabBarEl = document.getElementById('tab-bar');
const contentEl = document.getElementById('content');

let activeCleanup = null;

function renderHeader() {
  const conn = store.state.conn;
  connIndicatorEl.className = `conn-indicator ${conn === 'open' ? 'online' : conn === 'closed' ? 'offline' : ''}`;
  connTextEl.textContent = conn === 'open' ? 'Stand connected' : conn === 'closed' ? 'Disconnected' : 'Connecting…';
}

function renderTabs() {
  tabBarEl.innerHTML = '';
  for (const tab of TABS) {
    const active = store.state.activeTab === tab.id;
    const btn = document.createElement('button');
    btn.className = `tab${active ? ' active' : ''}`;
    btn.innerHTML = `<span class="tab-num">${tab.num}</span>${tab.label}`;
    btn.addEventListener('click', () => goToTab(tab.id));
    tabBarEl.appendChild(btn);
  }
}

function renderContent() {
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
  const view = VIEWS[store.state.activeTab];
  contentEl.innerHTML = '';
  if (view) {
    activeCleanup = view.render(contentEl) || null;
  }
}

function render() {
  renderHeader();
  renderTabs();
  renderContent();
}

async function boot() {
  store.subscribe(render);
  render();

  connectDashboard();
  initRecorder();

  try {
    const [calibrations, runs] = await Promise.all([api.fetchCalibrations(), api.fetchRuns()]);
    store.state.calibrations = calibrations;
    store.state.runs = runs;
    store.notify();
  } catch (err) {
    console.error('Failed to load calibrations/runs', err);
  }
}

boot();
