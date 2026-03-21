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

function setStatus(mode) {
  if (mode === 'live') {
    statusEl.className = 'status connected';
    statusText.textContent = 'Connected (live)';
  } else if (mode === 'reconnecting') {
    statusEl.className = 'status reconnecting';
    statusText.textContent = 'Reconnecting...';
  } else if (mode === 'poll') {
    statusEl.className = 'status connected';
    statusText.textContent = 'Connected (polling)';
  } else if (mode) {
    // Bare truthy (e.g. true from fetchSummary) means HTTP-connected
    statusEl.className = 'status connected';
    statusText.textContent = 'Connected';
  } else {
    statusEl.className = 'status disconnected';
    statusText.textContent = 'ModelWeaver not running';
  }
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

  // Uptime
  const uptimeEl = document.getElementById('last-refresh');
  if (uptimeEl) uptimeEl.textContent = formatUptime(data.uptimeSeconds || 0);

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
      bar.setAttribute('data-model', m.model || '');

      const name = document.createElement('span');
      name.className = 'model-name';
      const displayModel = m.model || 'unknown';
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
      row.setAttribute('data-provider', p.provider);

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
      const displayModel = r.model || 'unknown';
      model.title = displayModel;
      model.textContent = shortModel(displayModel);

      const provider = document.createElement('span');
      provider.className = 'recent-provider';
      provider.textContent = r.targetProvider || r.provider || '';

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

function formatUptime(seconds) {
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h + 'h ' + m + 'm';
}

function parseFormattedNumber(str) {
  if (!str) return 0;
  str = String(str).trim();
  if (str.endsWith('M')) return parseFloat(str) * 1_000_000;
  if (str.endsWith('K')) return parseFloat(str) * 1_000;
  return parseInt(str, 10) || 0;
}

function appendRequestMetric(r) {
  // Increment request count
  const currentRequests = parseInt(statRequests.textContent, 10) || 0;
  statRequests.textContent = currentRequests + 1;

  // Accumulate input tokens
  const currentInput = parseFormattedNumber(statInputTokens.textContent);
  statInputTokens.textContent = formatNumber(currentInput + (r.inputTokens || 0));

  // Accumulate output tokens
  const currentOutput = parseFormattedNumber(statOutputTokens.textContent);
  statOutputTokens.textContent = formatNumber(currentOutput + (r.outputTokens || 0));

  // Running average speed
  const oldAvg = parseFloat(statSpeed.textContent) || 0;
  const newTotal = currentRequests + 1;
  if (r.tokensPerSec != null) {
    statSpeed.textContent = (oldAvg + (r.tokensPerSec - oldAvg) / newTotal).toFixed(1);
  }

  // Prepend to recent requests list (cap at 10 visible)
  const emptyEl = recentEl.querySelector('.empty');
  if (emptyEl) emptyEl.remove();

  const latency = r.latencyMs >= 1000
    ? (r.latencyMs / 1000).toFixed(1) + 's'
    : r.latencyMs + 'ms';

  const item = document.createElement('div');
  item.className = 'recent-item';

  const model = document.createElement('span');
  model.className = 'recent-model';
  const displayModel = r.model || 'unknown';
  model.title = displayModel;
  model.textContent = shortModel(displayModel);

  const provider = document.createElement('span');
  provider.className = 'recent-provider';
  provider.textContent = r.targetProvider || r.provider || '';

  const tokens = document.createElement('span');
  tokens.className = 'recent-tokens';
  tokens.textContent = formatNumber((r.inputTokens || 0) + (r.outputTokens || 0)) + ' ' + latency;

  item.appendChild(model);
  item.appendChild(provider);
  item.appendChild(tokens);
  recentEl.prepend(item);

  // Cap visible items at 10
  while (recentEl.children.length > 10) {
    recentEl.removeChild(recentEl.lastChild);
  }

  // Update active models list
  const modelKey = r.model || 'unknown';
  let modelBar = modelsEl.querySelector(`[data-model="${CSS.escape(modelKey)}"]`);
  if (modelBar) {
    const countEl = modelBar.querySelector('.model-count');
    countEl.textContent = (parseInt(countEl.textContent, 10) || 0) + 1;
  } else {
    const emptyEl = modelsEl.querySelector('.empty');
    if (emptyEl) emptyEl.remove();

    const barClass = modelKey.toLowerCase().includes('sonnet') ? 'sonnet'
      : modelKey.toLowerCase().includes('haiku') ? 'haiku'
      : modelKey.toLowerCase().includes('opus') ? 'opus'
      : '';

    modelBar = document.createElement('div');
    modelBar.className = 'model-bar';
    modelBar.setAttribute('data-model', modelKey);

    const name = document.createElement('span');
    name.className = 'model-name';
    name.title = modelKey;
    name.textContent = shortModel(modelKey);

    const track = document.createElement('div');
    track.className = 'model-bar-track';

    const fill = document.createElement('div');
    fill.className = 'model-bar-fill ' + barClass;

    const count = document.createElement('span');
    count.className = 'model-count';
    count.textContent = '1';

    track.appendChild(fill);
    modelBar.appendChild(name);
    modelBar.appendChild(track);
    modelBar.appendChild(count);
    modelsEl.appendChild(modelBar);
  }

  // Re-sort model bars by count (descending)
  const modelBars = Array.from(modelsEl.querySelectorAll('.model-bar'));
  modelBars.sort((a, b) => {
    return (parseInt(b.querySelector('.model-count').textContent, 10) || 0)
         - (parseInt(a.querySelector('.model-count').textContent, 10) || 0);
  });
  modelBars.forEach(bar => modelsEl.appendChild(bar));

  // Recalculate model bar widths
  const maxModelCount = Math.max(1, ...modelBars.map(b => parseInt(b.querySelector('.model-count').textContent, 10) || 0));
  modelBars.forEach(bar => {
    const cnt = parseInt(bar.querySelector('.model-count').textContent, 10) || 0;
    bar.querySelector('.model-bar-fill').style.width = (cnt / maxModelCount * 100) + '%';
  });

  // Update providers list
  const providerKey = r.targetProvider || r.provider || '';
  if (providerKey) {
    let providerRow = providersEl.querySelector(`[data-provider="${CSS.escape(providerKey)}"]`);
    if (providerRow) {
      const countEl = providerRow.querySelector('.provider-count');
      const currentMatch = countEl.textContent.match(/^(\d+)/);
      const currentCount = currentMatch ? parseInt(currentMatch[1], 10) : 0;
      const newCount = currentCount + 1;

      // Recalculate all provider percentages (total = existing sum + 1 for this request)
      const allRows = Array.from(providersEl.querySelectorAll('.provider-row'));
      const totalNew = allRows.reduce((s, row) => {
        const m = row.querySelector('.provider-count').textContent.match(/^(\d+)/);
        return s + (m ? parseInt(m[1], 10) : 0);
      }, 0) + 1;
      allRows.forEach(row => {
        const match = row.querySelector('.provider-count').textContent.match(/^(\d+)/);
        const existingCount = match ? parseInt(match[1], 10) : 0;
        const count = row === providerRow ? newCount : existingCount;
        row.querySelector('.provider-count').textContent = count + ' (' + Math.round(count / totalNew * 100) + '%)';
      });
    } else {
      const emptyEl = providersEl.querySelector('.empty');
      if (emptyEl) emptyEl.remove();

      providerRow = document.createElement('div');
      providerRow.className = 'provider-row';
      providerRow.setAttribute('data-provider', providerKey);

      const name = document.createElement('span');
      name.className = 'provider-name';
      name.textContent = providerKey;

      const count = document.createElement('span');
      count.className = 'provider-count';
      count.textContent = '1 (100%)';

      providerRow.appendChild(name);
      providerRow.appendChild(count);
      providersEl.appendChild(providerRow);
    }

    // Re-sort provider rows by count (descending)
    const providerRows = Array.from(providersEl.querySelectorAll('.provider-row'));
    providerRows.sort((a, b) => {
      const aMatch = a.querySelector('.provider-count').textContent.match(/^(\d+)/);
      const bMatch = b.querySelector('.provider-count').textContent.match(/^(\d+)/);
      return (bMatch ? parseInt(bMatch[1], 10) : 0) - (aMatch ? parseInt(aMatch[1], 10) : 0);
    });
    providerRows.forEach(row => providersEl.appendChild(row));
  }
}

function connectWebSocket(port) {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  // Close stale sockets stuck in CONNECTING or CLOSING state
  if (ws) {
    ws.close();
    ws = null;
  }

  try {
    ws = new WebSocket('ws://localhost:' + port + '/ws');
  } catch (err) {
    console.error('[WebSocket] create failed:', err);
    return;
  }

  // Force-close the socket if it never reaches OPEN within WS_CONNECT_TIMEOUT
  const connectTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      console.warn('[WebSocket] connect timeout — force closing');
      ws.close();
    }
  }, WS_CONNECT_TIMEOUT);

  ws.addEventListener('open', () => {
    clearTimeout(connectTimer);
    console.log('[WebSocket] connected');
    // Stop HTTP polling — WS is now the primary data source
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    wsBackoff = 1000;
    setStatus('live');
    // Defensive: fetch summary via HTTP to ensure active models/providers
    // are populated even if the initial WS summary message is missed
    fetchSummary();
  });

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'summary') {
        updateSummary(msg.data);
      } else if (msg.type === 'request') {
        appendRequestMetric(msg.data);
      }
    } catch (err) {
      console.error('[WebSocket] parse error:', err);
    }
  });

  ws.addEventListener('close', () => {
    ws = null;
    console.log('[WebSocket] closed');
    // Restart HTTP polling as fallback
    if (!pollTimer) {
      pollTimer = setInterval(fetchSummary, POLL_INTERVAL);
    }
    // Schedule reconnection with exponential backoff
    reconnectTimer = setTimeout(() => connectWebSocket(port), wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, WS_MAX_BACKOFF);
    // Show reconnecting state while backoff timer is pending
    setStatus('reconnecting');
  });

  ws.addEventListener('error', (err) => {
    console.error('[WebSocket] error:', err);
    // close event fires right after error, so no status change here
  });
}

async function fetchSummary() {
  try {
    const data = await invoke('fetch_metrics', { port: DEFAULT_PORT });
    updateSummary(data);
    // Don't overwrite status if WebSocket is already live
    if (ws) setStatus('live');
  } catch (err) {
    console.error('[fetchSummary] failed:', err);
    setStatus(false);
  }
}

// WebSocket state
let ws = null;
let pollTimer = null;
let wsBackoff = 1000;
let reconnectTimer = null;
const WS_MAX_BACKOFF = 30000;
const WS_CONNECT_TIMEOUT = 5000;

// Initial HTTP fetch for instant data
fetchSummary();
// Start polling as fallback
pollTimer = setInterval(fetchSummary, POLL_INTERVAL);
// Attempt WebSocket connection
connectWebSocket(DEFAULT_PORT);
