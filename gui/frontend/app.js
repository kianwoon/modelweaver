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
const statCache = document.getElementById('stat-cache');
const modelsEl = document.getElementById('models');
const providersEl = document.getElementById('providers');
const recentEl = document.getElementById('recent');

// Activity bar state
const activityContent = document.getElementById('activity-content');
const activeRequests = new Map();
const MAX_VISIBLE_BARS = 3;
const STALE_BAR_TIMEOUT_MS = 120_000; // 2 minutes

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

// --- Compact Mode ---
const COMPACT_HEIGHT = 320;
const NORMAL_HEIGHT = 520;
const COMPACT_KEY = 'modelweaver-compact-mode';

function setCompactMode(enabled) {
  const app = document.getElementById('app');
  const btn = document.getElementById('btn-compact');
  if (enabled) {
    app.classList.add('compact-mode');
    btn.textContent = '\u2193';
    btn.title = 'Expand';
  } else {
    app.classList.remove('compact-mode');
    btn.textContent = '\u2191';
    btn.title = 'Toggle Compact Mode';
  }
  localStorage.setItem(COMPACT_KEY, enabled ? '1' : '0');

  // Resize window via Tauri API
  if (window.__TAURI__) {
    try {
      const { getCurrentWindow } = window.__TAURI__.window;
      const win = getCurrentWindow();
      const height = enabled ? COMPACT_HEIGHT : NORMAL_HEIGHT;
      win.setSize({ type: 'Logical', width: 360, height: height });
      if (enabled) {
        win.setMinSize({ type: 'Logical', width: 360, height: COMPACT_HEIGHT });
      } else {
        win.setMinSize({ type: 'Logical', width: 360, height: NORMAL_HEIGHT });
      }
    } catch (err) {
      console.warn('[Compact] Tauri resize failed:', err);
    }
  }
}

document.getElementById('btn-compact').addEventListener('click', () => {
  const app = document.getElementById('app');
  const isCompact = app.classList.contains('compact-mode');
  setCompactMode(!isCompact);
});

// Restore compact state from localStorage
if (localStorage.getItem(COMPACT_KEY) === '1') {
  setCompactMode(true);
}

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
  statCache.textContent = data.avgCacheHitRate > 0 ? data.avgCacheHitRate.toFixed(0) + '%' : '\u2014';

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
      const actualModel = m.actualModel || m.model || 'unknown';
      const requestedModel = m.model || 'unknown';
      const displayModel = actualModel;
      const showAlias = actualModel !== requestedModel;
      name.title = showAlias ? `${actualModel} (via ${requestedModel})` : displayModel;
      name.textContent = showAlias
        ? `${shortModel(actualModel)} (${shortModel(requestedModel)})`
        : shortModel(displayModel);

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
      const actualModel = r.actualModel || r.model || 'unknown';
      const requestedModel = r.model || 'unknown';
      const showAlias = actualModel !== requestedModel;
      model.title = showAlias ? `${actualModel} (via ${requestedModel})` : actualModel;
      model.textContent = showAlias
        ? `${shortModel(actualModel)} (${shortModel(requestedModel)})`
        : shortModel(actualModel);

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
  const actualModel = r.actualModel || r.model || 'unknown';
  const requestedModel = r.model || 'unknown';
  const showAlias = actualModel !== requestedModel;
  model.title = showAlias ? `${actualModel} (via ${requestedModel})` : actualModel;
  model.textContent = showAlias
    ? `${shortModel(actualModel)} (${shortModel(requestedModel)})`
    : shortModel(actualModel);

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

    const actualKey = r.actualModel || r.model || 'unknown';
    const barClass = actualKey.toLowerCase().includes('sonnet') ? 'sonnet'
      : actualKey.toLowerCase().includes('haiku') ? 'haiku'
      : actualKey.toLowerCase().includes('opus') ? 'opus'
      : '';

    modelBar = document.createElement('div');
    modelBar.className = 'model-bar';
    modelBar.setAttribute('data-model', modelKey);

    const name = document.createElement('span');
    name.className = 'model-name';
    const showModelAlias = actualKey !== modelKey;
    name.title = showModelAlias ? `${actualKey} (via ${modelKey})` : actualKey;
    name.textContent = showModelAlias
      ? `${shortModel(actualKey)} (${shortModel(modelKey)})`
      : shortModel(actualKey);

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

// --- Activity progress bar helpers ---

function createActivityBar(requestId, model, tier) {
  const track = document.createElement('div');
  track.className = 'activity-track';
  track.title = '';

  const fill = document.createElement('div');
  fill.className = 'activity-fill state-start';
  track.appendChild(fill);

  const label = document.createElement('span');
  label.className = 'activity-label';
  const modelName = document.createElement('span');
  modelName.textContent = shortModel(model);
  const statusSpan = document.createElement('span');
  statusSpan.textContent = '';
  label.appendChild(modelName);
  label.appendChild(statusSpan);
  track.appendChild(label);

  // Hide idle text
  const idle = activityContent.querySelector('.activity-idle');
  if (idle) idle.style.display = 'none';

  track.dataset.requestId = requestId;
  activityContent.appendChild(track);
  trimBars();

  const entry = { element: track, fill, label, statusSpan, startTime: Date.now(), lastOutputTokens: 0, prevTimestamp: 0, model, tier, ttfbTimer: null, staleTimer: null };

  entry.staleTimer = setTimeout(() => {
    console.warn('[Activity] Bar stale — auto-dismissing', requestId);
    entry.fill.classList.remove('state-streaming', 'state-fallback', 'state-start');
    entry.fill.classList.add('state-error');
    entry.statusSpan.textContent = 'stalled';
    setTimeout(() => {
      entry.element.classList.add('dismissing');
      setTimeout(() => removeActivityBar(requestId), 800);
    }, 2000);
  }, STALE_BAR_TIMEOUT_MS);

  return entry;
}

function trimBars() {
  const bars = activityContent.querySelectorAll('.activity-track');
  while (bars.length > MAX_VISIBLE_BARS) {
    bars[0].remove();
  }
}

function removeActivityBar(requestId) {
  const entry = activeRequests.get(requestId);
  if (!entry) return;
  if (entry.staleTimer) clearTimeout(entry.staleTimer);
  if (entry) entry.ttfbCleared = true;
  if (entry?.ttfbTimer) cancelAnimationFrame(entry.ttfbTimer);
  if (entry) entry.ttfbTimer = null;
  const bar = entry.element;
  bar.remove();
  activeRequests.delete(requestId);
  if (activeRequests.size === 0) {
    let idle = activityContent.querySelector('.activity-idle');
    if (!idle) {
      idle = document.createElement('span');
      idle.className = 'activity-idle';
      idle.textContent = 'Idle';
      activityContent.appendChild(idle);
    }
    idle.style.display = '';
  }
}

// rAF batching state for streaming events — prevents layout thrash at ~60 mutations/sec
const pendingStreamUpdates = new Map();
let rafScheduled = false;

// Throttle updateSummary to prevent DOM destruction/reconstruction freeze
let lastSummaryUpdate = 0;
const SUMMARY_THROTTLE_MS = 1000;
let summaryDirty = false;
let summaryData = null;
let summaryThrottleTimer = null;

function flushStreamUpdates() {
  rafScheduled = false;
  for (const [requestId, data] of pendingStreamUpdates) {
    applyStreamingUpdate(requestId, data);
  }
  pendingStreamUpdates.clear();
}

function applyStreamingUpdate(requestId, data) {
  const entry = activeRequests.get(requestId);
  if (!entry) return;
  if (entry) entry.ttfbCleared = true;
  if (entry?.ttfbTimer) cancelAnimationFrame(entry.ttfbTimer);
  if (entry) entry.ttfbTimer = null;
  resetStaleTimer(entry);
  entry.fill.classList.remove('state-start');
  entry.fill.classList.add('state-streaming');
  const elapsed = (Date.now() - entry.startTime) / 1000;
  const pct = Math.min(80, elapsed * 5);
  entry.fill.style.width = pct + '%';
  const tok = data.outputTokens || 0;
  // Compute tok/s from delta between consecutive streaming events
  let tps = '';
  const prevTok = entry.lastOutputTokens;
  if (entry.prevTimestamp > 0 && data.timestamp > entry.prevTimestamp && tok > prevTok) {
    const deltaSec = (data.timestamp - entry.prevTimestamp) / 1000;
    const rate = (tok - prevTok) / deltaSec;
    tps = rate.toFixed(0) + ' tok/s';
  }
  entry.lastOutputTokens = tok;
  entry.prevTimestamp = data.timestamp || Date.now();
  const secs = elapsed >= 1 ? elapsed.toFixed(1) + 's' : Math.round(elapsed * 1000) + 'ms';
  let meta = tok > 0
    ? tok + ' tok' + (tps ? ' \u00b7 ' + tps : '') + ' \u00b7 ' + secs
    : (entry.headerInfo || '') + ' \u00b7 ' + secs;
  // Cache hit rate and context usage
  const cacheHit = data.cacheHitRate;
  const ctxPct = data.contextPercent;
  if (cacheHit != null && cacheHit > 0) meta += ' \u00b7 ' + cacheHit.toFixed(0) + '% cache';
  if (ctxPct != null && ctxPct > 0) meta += ' \u00b7 ' + ctxPct.toFixed(0) + '% ctx';
  entry.statusSpan.textContent = meta;
  // Show response preview as tooltip only (CSS ::after removed to avoid layout thrash)
  if (data.preview) {
    entry.element.title = data.preview;
    entry.element.setAttribute('data-preview', data.preview);
    entry.element.style.marginBottom = '16px';
  }
}

function scheduleSummaryUpdate(data) {
  summaryData = data;
  summaryDirty = true;
  const now = Date.now();
  const elapsed = now - lastSummaryUpdate;
  if (elapsed >= SUMMARY_THROTTLE_MS) {
    flushSummaryUpdate();
  } else if (!summaryThrottleTimer) {
    summaryThrottleTimer = setTimeout(flushSummaryUpdate, SUMMARY_THROTTLE_MS - elapsed);
  }
}

function flushSummaryUpdate() {
  if (summaryThrottleTimer) { clearTimeout(summaryThrottleTimer); summaryThrottleTimer = null; }
  if (!summaryDirty || !summaryData) return;
  summaryDirty = false;
  lastSummaryUpdate = Date.now();
  updateSummary(summaryData);
  summaryData = null;
}

function resetStaleTimer(entry) {
  if (entry.staleTimer) clearTimeout(entry.staleTimer);
  const requestId = entry.element.dataset.requestId;
  entry.staleTimer = setTimeout(() => {
    console.warn('[Activity] Bar stale — auto-dismissing', requestId);
    entry.fill.classList.remove('state-streaming', 'state-fallback', 'state-start');
    entry.fill.classList.add('state-error');
    entry.statusSpan.textContent = 'stalled';
    setTimeout(() => {
      entry.element.classList.add('dismissing');
      setTimeout(() => removeActivityBar(requestId), 800);
    }, 2000);
  }, STALE_BAR_TIMEOUT_MS);
}

function handleStreamEvent(data) {
  if (data.state === 'start') {
    // Guard: don't create duplicate bars for the same request
    if (activeRequests.has(data.requestId)) return;
    const bar = createActivityBar(data.requestId, data.model, data.tier);
    activeRequests.set(data.requestId, bar);
    bar.provider = data.provider || '';
    bar.statusSpan.textContent = (bar.provider || '') + ' connecting...';
    bar.ttfbTimer = null;
    bar.ttfbCleared = true;

  } else if (data.state === 'ttfb') {
    const entry = activeRequests.get(data.requestId);
    if (!entry) return;
    if (entry) entry.ttfbCleared = true;
    if (entry?.ttfbTimer) cancelAnimationFrame(entry.ttfbTimer);
    if (entry) entry.ttfbTimer = null;
    entry.fill.classList.remove('state-start');
    entry.fill.classList.add('state-streaming');
    const secs = ((Date.now() - entry.startTime) / 1000).toFixed(1);
    const hdr = data.headerSize || 0;
    entry.statusSpan.textContent = hdr + 'B hdr \u00b7 ' + secs + 's';
    entry.headerInfo = hdr + 'B hdr';
    resetStaleTimer(entry);

  } else if (data.state === 'streaming') {
    if (activeRequests.size >= 2) return;
    if (!activeRequests.has(data.requestId)) return;
    // Batch streaming DOM updates via rAF — coalesces multiple events per frame
    pendingStreamUpdates.set(data.requestId, data);
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(flushStreamUpdates);
    }

  } else if (data.state === 'fallback') {
    const entry = activeRequests.get(data.requestId);
    if (!entry) return;
    if (entry) entry.ttfbCleared = true;
    if (entry?.ttfbTimer) cancelAnimationFrame(entry.ttfbTimer);
    if (entry) entry.ttfbTimer = null;
    entry.fill.classList.remove('state-streaming');
    entry.fill.classList.add('state-fallback');
    entry.statusSpan.textContent = 'fallback \u2192 ' + (data.to || '?');
    resetStaleTimer(entry);

  } else if (data.state === 'complete') {
    const entry = activeRequests.get(data.requestId);
    if (!entry) return;
    if (entry) entry.ttfbCleared = true;
    if (entry?.ttfbTimer) cancelAnimationFrame(entry.ttfbTimer);
    if (entry) entry.ttfbTimer = null;
    if (entry.staleTimer) clearTimeout(entry.staleTimer);
    entry.element.removeAttribute('data-preview');
    entry.element.style.marginBottom = '';
    entry.fill.classList.remove('state-streaming', 'state-fallback', 'state-start');
    entry.fill.classList.add('state-complete');
    entry.fill.style.width = '100%';
    const tps = data.tokensPerSec ? data.tokensPerSec.toFixed(0) + ' tok/s' : '';
    const latency = data.latencyMs >= 1000 ? (data.latencyMs / 1000).toFixed(1) + 's' : data.latencyMs + 'ms';
    let finalMeta = (data.outputTokens || 0) + ' tok \u00b7 ' + tps + ' \u00b7 ' + latency;
    if (data.cacheHitRate != null && data.cacheHitRate > 0) finalMeta += ' \u00b7 ' + data.cacheHitRate.toFixed(0) + '% cache';
    if (data.contextPercent != null && data.contextPercent > 0) finalMeta += ' \u00b7 ' + data.contextPercent.toFixed(0) + '% ctx';
    entry.statusSpan.textContent = finalMeta;
    // Dismiss track immediately so it fades together with the fill
    setTimeout(() => {
      entry.element.classList.add('dismissing');
      setTimeout(() => removeActivityBar(data.requestId), 800);
    }, 2000);

  } else if (data.state === 'error') {
    const entry = activeRequests.get(data.requestId);
    if (!entry) return;
    if (entry) entry.ttfbCleared = true;
    if (entry?.ttfbTimer) cancelAnimationFrame(entry.ttfbTimer);
    if (entry) entry.ttfbTimer = null;
    if (entry.staleTimer) clearTimeout(entry.staleTimer);
    entry.element.removeAttribute('data-preview');
    entry.element.style.marginBottom = '';
    entry.fill.classList.remove('state-streaming', 'state-fallback', 'state-start');
    entry.fill.classList.add('state-error');
    if (!entry.fill.style.width || entry.fill.style.width === '0%') {
      entry.fill.style.width = '10%';
    }
    entry.statusSpan.textContent = 'error ' + (data.status || '');
    // Dismiss track immediately so it fades together with the fill
    setTimeout(() => {
      entry.element.classList.add('dismissing');
      setTimeout(() => removeActivityBar(data.requestId), 800);
    }, 2000);
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
    // Allow start/complete/error/ttfb for bar lifecycle, skip summary/request/streaming
    if (activeRequests.size >= 2) {
      const raw = typeof event.data === 'string' ? event.data : '';
      if (!raw.includes('"complete"') && !raw.includes('"error"')) return;
    }
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'summary') {
        scheduleSummaryUpdate(msg.data);
      } else if (msg.type === 'request') {
        appendRequestMetric(msg.data);
      } else if (msg.type === 'stream') {
        handleStreamEvent(msg.data);
      }
    } catch (err) {
      console.error('[WebSocket] parse error:', err);
    }
  });

  ws.addEventListener('close', () => {
    ws = null;
    console.log('[WebSocket] closed');
    // Clean up orphaned progress bars — server won't send events for them after reconnect
    for (const [reqId] of activeRequests) {
      removeActivityBar(reqId);
    }
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
    scheduleSummaryUpdate(data);
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

// Set custom titlebar version from the native window title (set by Rust backend)
if (window.__TAURI__) {
  const titleEl = document.querySelector('.titlebar .title');
  if (titleEl) {
    window.__TAURI__.window.getCurrentWindow().title().then((nativeTitle) => {
      if (nativeTitle) titleEl.textContent = nativeTitle;
    });
  }
}

// Initial HTTP fetch for instant data
fetchSummary();
// Start polling as fallback
pollTimer = setInterval(fetchSummary, POLL_INTERVAL);
// Attempt WebSocket connection
connectWebSocket(DEFAULT_PORT);
