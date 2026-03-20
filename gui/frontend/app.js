// app.js — ModelWeaver GUI (Tauri) — uses invoke() for all HTTP calls
const DEFAULT_PORT = 3456;
const POLL_INTERVAL = 5000;

// Tauri invoke helper
async function invoke(cmd, args) {
  if (window.__TAURI__) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  throw new Error('Tauri API not available');
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
  if (window.__TAURI__) {
    window.__TAURI__.window.getCurrentWindow().close();
  } else {
    window.close();
  }
});

document.getElementById('btn-minimize').addEventListener('click', () => {
  if (window.__TAURI__) {
    window.__TAURI__.window.getCurrentWindow().minimize();
  }
});

// Drag region — stop propagation on buttons so clicks don't initiate a drag
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

function updateSummary(data) {
  statSpeed.textContent = (data.avgTokensPerSec || 0).toFixed(1);
  statRequests.textContent = data.totalRequests || 0;
  statInputTokens.textContent = formatNumber(data.totalInputTokens || 0);
  statOutputTokens.textContent = formatNumber(data.totalOutputTokens || 0);

  // Active models
  const activeModels = data.activeModels || [];
  if (activeModels.length === 0) {
    modelsEl.textContent = '';
    modelsEl.appendChild(createEmptyEl('No requests yet'));
  } else {
    const maxCount = Math.max(...activeModels.map(m => m.count));
    modelsEl.textContent = '';
    for (const m of activeModels) {
      const pct = maxCount > 0 ? (m.count / maxCount * 100) : 0;
      const cls = (m.actualModel || m.model || '').toLowerCase();
      let barClass = '';
      if (cls.includes('sonnet')) barClass = 'sonnet';
      else if (cls.includes('haiku')) barClass = 'haiku';
      else if (cls.includes('opus')) barClass = 'opus';

      const bar = document.createElement('div');
      bar.className = 'model-bar';

      const name = document.createElement('span');
      name.className = 'model-name';
      const displayModel = m.actualModel || m.model || 'unknown';
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
  const providers = data.providerDistribution || [];
  if (providers.length === 0) {
    providersEl.textContent = '';
    providersEl.appendChild(createEmptyEl('No requests yet'));
  } else {
    const total = providers.reduce((s, p) => s + p.count, 0);
    providersEl.textContent = '';
    for (const p of providers) {
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
  const recentRequests = data.recentRequests || [];
  if (recentRequests.length === 0) {
    recentEl.textContent = '';
    recentEl.appendChild(createEmptyEl('No requests yet'));
  } else {
    recentEl.textContent = '';
    const reversed = recentRequests.slice(-10).reverse();
    for (const r of reversed) {
      const latency = r.latencyMs >= 1000 ? (r.latencyMs / 1000).toFixed(1) + 's' : r.latencyMs + 'ms';

      const item = document.createElement('div');
      item.className = 'recent-item';

      const model = document.createElement('span');
      model.className = 'recent-model';
      const displayModel = r.actualModel || r.model || 'unknown';
      model.title = displayModel;
      model.textContent = shortModel(displayModel);

      const provider = document.createElement('span');
      provider.className = 'recent-provider';
      provider.textContent = r.provider || '';

      const tokens = document.createElement('span');
      tokens.className = 'recent-tokens';
      tokens.textContent = formatNumber((r.inputTokens || 0) + (r.outputTokens || 0)) + ' ' + latency;

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

async function fetchSummary() {
  try {
    const data = await invoke('fetch_metrics', { port: DEFAULT_PORT });
    updateSummary(data);
    setStatus(true);
    const refreshEl = document.getElementById('last-refresh');
    if (refreshEl) refreshEl.textContent = new Date().toLocaleTimeString();
  } catch (err) {
    console.error('[fetchSummary] failed:', err);
    setStatus(false);
  }
}

// Poll via Tauri invoke — no direct fetch/WebSocket to localhost
setInterval(fetchSummary, POLL_INTERVAL);

// Start immediately
fetchSummary();
