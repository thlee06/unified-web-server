(() => {
  const MAX_POINTS = 1200; // keep charts in sync with server-side history cap
  const SYNC_KEY = 'rig-sync';
  const PALETTE = ['#5b9bd5', '#ed7d31', '#70ad47', '#ffc000', '#c00000', '#7030a0', '#00b0f0', '#e91e8c'];

  const panelsEl = document.getElementById('panels');
  const emptyStateEl = document.getElementById('empty-state');
  const connBadgeEl = document.getElementById('connection-status');

  /** @type {Map<string, Panel>} */
  const panels = new Map();

  function colorForIndex(i) {
    return PALETTE[i % PALETTE.length];
  }

  function updateEmptyState() {
    emptyStateEl.style.display = panels.size === 0 ? '' : 'none';
  }

  function setConnBadge(state) {
    connBadgeEl.className = `conn-badge conn-${state}`;
    connBadgeEl.textContent = state === 'open' ? 'live' : state === 'closed' ? 'disconnected' : 'connecting…';
  }

  class Panel {
    constructor(id, name) {
      this.id = id;
      this.name = name || id;
      this.channelKeys = [];
      this.xs = [];
      this.seriesData = {}; // key -> array aligned with xs
      this.status = 'online';

      this.root = document.createElement('div');
      this.root.className = 'panel';
      this.root.innerHTML = `
        <div class="panel-header">
          <span class="panel-title"></span>
          <span class="status-badge"></span>
        </div>
        <div class="chart"></div>
      `;
      this.titleEl = this.root.querySelector('.panel-title');
      this.badgeEl = this.root.querySelector('.status-badge');
      this.chartEl = this.root.querySelector('.chart');
      this.titleEl.textContent = this.name;
      this.setStatus('online');

      this.uplot = new uPlot(
        {
          width: this.chartEl.clientWidth || 400,
          height: 260,
          cursor: { sync: { key: SYNC_KEY } },
          scales: { x: { time: true } },
          series: [{ label: 'time' }],
        },
        [this.xs],
        this.chartEl
      );

      window.addEventListener('resize', () => {
        this.uplot.setSize({ width: this.chartEl.clientWidth || 400, height: 260 });
      });
    }

    setName(name) {
      if (!name || name === this.name) return;
      this.name = name;
      this.titleEl.textContent = name;
    }

    setStatus(status) {
      this.status = status;
      this.badgeEl.textContent = status;
      this.badgeEl.className = `status-badge status-${status}`;
      this.root.classList.toggle('offline', status === 'offline');
    }

    ensureChannel(key, meta) {
      if (this.channelKeys.includes(key)) return;
      this.channelKeys.push(key);
      // Backfill so every series array stays aligned with `xs`.
      this.seriesData[key] = new Array(this.xs.length).fill(null);

      const label = meta?.label || key;
      const unit = meta?.unit ? ` (${meta.unit})` : '';
      this.uplot.addSeries(
        { label: label + unit, stroke: colorForIndex(this.channelKeys.length - 1), width: 1.5 },
        this.channelKeys.length
      );
    }

    appendSample(ts, values) {
      for (const key of Object.keys(values)) this.ensureChannel(key);

      this.xs.push(ts / 1000);
      for (const key of this.channelKeys) {
        this.seriesData[key].push(Object.hasOwn(values, key) ? values[key] : null);
      }

      if (this.xs.length > MAX_POINTS) {
        this.xs.shift();
        for (const key of this.channelKeys) this.seriesData[key].shift();
      }

      this.redraw();
    }

    loadHistory(history) {
      for (const { ts, values } of history) {
        for (const key of Object.keys(values)) this.ensureChannel(key);
      }
      this.xs = history.map((point) => point.ts / 1000);
      for (const key of this.channelKeys) {
        this.seriesData[key] = history.map((point) =>
          Object.hasOwn(point.values, key) ? point.values[key] : null
        );
      }
      this.redraw();
    }

    redraw() {
      this.uplot.setData([this.xs, ...this.channelKeys.map((key) => this.seriesData[key])]);
    }
  }

  function getOrCreatePanel(id, name) {
    let panel = panels.get(id);
    if (!panel) {
      panel = new Panel(id, name);
      panels.set(id, panel);
      panelsEl.appendChild(panel.root);
      updateEmptyState();
    }
    return panel;
  }

  function applyModule(mod) {
    const panel = getOrCreatePanel(mod.id, mod.name);
    panel.setName(mod.name);
    panel.setStatus(mod.status);
    for (const [key, meta] of Object.entries(mod.channels || {})) {
      panel.ensureChannel(key, meta);
    }
  }

  function applySnapshot(modules) {
    for (const mod of modules) {
      const panel = getOrCreatePanel(mod.id, mod.name);
      panel.setStatus(mod.status);
      for (const [key, meta] of Object.entries(mod.channels || {})) {
        panel.ensureChannel(key, meta);
      }
      panel.loadHistory(mod.history);
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'snapshot':
        applySnapshot(msg.modules);
        break;
      case 'module':
        applyModule(msg.module);
        break;
      case 'sample':
        getOrCreatePanel(msg.id).appendSample(msg.ts, msg.values);
        break;
      case 'status':
        getOrCreatePanel(msg.id).setStatus(msg.status);
        break;
      default:
        console.warn('Unknown dashboard message type', msg.type);
    }
  }

  function connect() {
    setConnBadge('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/dashboard`);

    ws.addEventListener('open', () => setConnBadge('open'));
    ws.addEventListener('message', (event) => {
      try {
        handleMessage(JSON.parse(event.data));
      } catch (err) {
        console.error('Failed to handle dashboard message', err);
      }
    });
    ws.addEventListener('close', () => {
      setConnBadge('closed');
      setTimeout(connect, 2000);
    });
    ws.addEventListener('error', () => ws.close());
  }

  connect();
})();
