// app.js — WebSocket client for ModelWeaver metrics
const DEFAULT_PORT = 3456;
const RECONNECT_DELAY = 3000;

let ws = null;
let reconnectTimer = null;

// Tauri API — uses window.__TAURI__ (withGlobalTauri: true in tauri.conf.json)
let appWindow = null;
function getAppWindow() {
  if (!appWindow && window.__TAURI__) {
    appWindow = window.__TAURI__.window.getCurrentWindow();
  }
  return appWindow;
}

// DOM references
const statusEl = document.getElementById('status');
const statusText = statusEl.querySelector('.status-text');
const statSpeed = document.getElementById('stat-speed');
const statRequests = document.getElementById('stat-requests');
const statInputTokens = document.getElementById('stat-input-tokens');
const statOutputTokens = document.getElementById('stat-output-tokens');
const modelsEl = document.getElementById('models');
const providersEl = document.getElementById('providers');
const recentEl = document.getElementById('recent');

// Title bar buttons
document.getElementById('btn-close').addEventListener('click', () => {
  const win = getAppWindow();
  if (win) {
    win.close();
  } else {
    window.close();
  }
});

document.getElementById('btn-minimize').addEventListener('click', () => {
  const win = getAppWindow();
  if (win) {
    win.minimize();
  }
});

// Drag region — handled by data-tauri-drag-region attribute in HTML.
// Stop propagation on buttons so clicks don't initiate a drag.
document.querySelectorAll('.titlebar-btn').forEach(btn => {
  btn.addEventListener('mousedown', e => e.stopPropagation());
});

function setStatus(connected) {
  statusEl.className = `status ${connected ? 'connected' : 'disconnected'}`;
  statusText.textContent = connected ? 'Connected' : 'ModelWeaver not running';
}

function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function shortModel(model) {
  return model
    .replace(/^claude-/, '')
    .replace(/^anthropic\//, '')
    .replace(/-\d{8,}$/, '')
    .replace(/-latest$/, '');
}

function updateSummary(summary) {
  statSpeed.textContent = summary.avgTokensPerSec.toFixed(1);
  statRequests.textContent = summary.totalRequests;
  statInputTokens.textContent = formatNumber(summary.totalInputTokens);
  statOutputTokens.textContent = formatNumber(summary.totalOutputTokens);

  // Active models
  if (summary.activeModels.length === 0) {
    modelsEl.textContent = '';
    modelsEl.appendChild(createEmptyEl('No requests yet'));
  } else {
    const maxCount = Math.max(...summary.activeModels.map(m => m.count));
    modelsEl.textContent = '';
    for (const m of summary.activeModels) {
      const pct = maxCount > 0 ? (m.count / maxCount * 100) : 0;
      const cls = (m.actualModel || m.model).toLowerCase();
      let barClass = '';
      if (cls.includes('sonnet')) barClass = 'sonnet';
      else if (cls.includes('haiku')) barClass = 'haiku';
      else if (cls.includes('opus')) barClass = 'opus';

      const bar = document.createElement('div');
      bar.className = 'model-bar';

      const name = document.createElement('span');
      name.className = 'model-name';
      const displayModel = m.actualModel || m.model;
      name.title = displayModel;
      name.textContent = shortModel(displayModel);

      const track = document.createElement('div');
      track.className = 'model-bar-track';

      const fill = document.createElement('div');
      fill.className = 'model-bar-fill ' + barClass;
      fill.style.width = pct + '%';

      const count = document.createElement('span');
      count.className = 'model-count';
      count.textContent = m.count;

      track.appendChild(fill);
      bar.appendChild(name);
      bar.appendChild(track);
      bar.appendChild(count);
      modelsEl.appendChild(bar);
    }
  }

  // Providers
  if (summary.providerDistribution.length === 0) {
    providersEl.textContent = '';
    providersEl.appendChild(createEmptyEl('No requests yet'));
  } else {
    const total = summary.providerDistribution.reduce((s, p) => s + p.count, 0);
    providersEl.textContent = '';
    for (const p of summary.providerDistribution) {
      const pct = total > 0 ? Math.round(p.count / total * 100) : 0;

      const row = document.createElement('div');
      row.className = 'provider-row';

      const name = document.createElement('span');
      name.className = 'provider-name';
      name.textContent = p.provider;

      const count = document.createElement('span');
      count.className = 'provider-count';
      count.textContent = p.count + ' (' + pct + '%)';

      row.appendChild(name);
      row.appendChild(count);
      providersEl.appendChild(row);
    }
  }

  // Recent requests
  if (summary.recentRequests.length === 0) {
    recentEl.textContent = '';
    recentEl.appendChild(createEmptyEl('No requests yet'));
  } else {
    recentEl.textContent = '';
    const reversed = summary.recentRequests.slice(-10).reverse();
    for (const r of reversed) {
      const latency = r.latencyMs >= 1000 ? (r.latencyMs / 1000).toFixed(1) + 's' : r.latencyMs + 'ms';

      const item = document.createElement('div');
      item.className = 'recent-item';

      const model = document.createElement('span');
      model.className = 'recent-model';
      const displayModel = r.actualModel || r.model;
      model.title = displayModel;
      model.textContent = shortModel(displayModel);

      const provider = document.createElement('span');
      provider.className = 'recent-provider';
      provider.textContent = r.provider;

      const tokens = document.createElement('span');
      tokens.className = 'recent-tokens';
      tokens.textContent = formatNumber(r.inputTokens + r.outputTokens) + ' ' + latency;

      item.appendChild(model);
      item.appendChild(provider);
      item.appendChild(tokens);
      recentEl.appendChild(item);
    }
  }
}

function createEmptyEl(text) {
  const el = document.createElement('div');
  el.className = 'empty';
  el.textContent = text;
  return el;
}

function connect() {
  if (ws) ws.close();  // Close existing connection before reconnecting
  // Try to determine port — in Tauri, the GUI connects to the ModelWeaver process
  const url = `ws://localhost:${DEFAULT_PORT}/ws`;

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('WebSocket create failed:', err);
    setStatus(false);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('Connected to ModelWeaver');
    setStatus(true);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'summary') {
        updateSummary(msg.data);
      } else if (msg.type === 'request') {
        // Fetch fresh summary after a short delay so metrics are recorded
        setTimeout(fetchSummary, 200);
      }
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  };

  ws.onclose = () => {
    console.log('Disconnected from ModelWeaver');
    setStatus(false);
    scheduleReconnect();
  };

  ws.onerror = () => {
    setStatus(false);
  };
}

function fetchSummary() {
  console.log('[fetchSummary] fetching metrics at', Date.now());
  fetch(`http://localhost:${DEFAULT_PORT}/api/metrics/summary?t=${Date.now()}`)
    .then(r => {
      console.log('[fetchSummary] response status:', r.status);
      return r.json();
    })
    .then(data => {
      console.log('[fetchSummary] data:', JSON.stringify(data).substring(0, 100));
      updateSummary(data);
      setStatus(true); // REST success = backend is running
      // Update last-refresh timestamp in status bar
      const refreshEl = document.getElementById('last-refresh');
      if (refreshEl) refreshEl.textContent = new Date().toLocaleTimeString();
    })
    .catch((err) => {
      console.error('[fetchSummary] failed:', err);
      setStatus(false); // REST failure = backend not reachable
    });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY);
}

// Periodic refresh — always poll via REST; WebSocket is real-time bonus
setInterval(() => {
  fetchSummary();
}, 5000);

// Start
connect();
