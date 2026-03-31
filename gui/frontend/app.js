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

// Glow state — counter-based so concurrent requests don't fight
let glowActiveCount = 0;

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
const COMPACT_HEIGHT = 420;
const NORMAL_HEIGHT = 800;
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

// --- Config validation error banner ---

let configErrorTimer = null;

function showConfigError(fieldErrors) {
  // Remove any existing banner
  const existing = document.getElementById('config-error-banner');
  if (existing) existing.remove();
  if (configErrorTimer) { clearTimeout(configErrorTimer); configErrorTimer = null; }

  if (!fieldErrors || fieldErrors.length === 0) return;

  const banner = document.createElement('div');
  banner.id = 'config-error-banner';
  banner.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);max-width:560px;width:calc(100% - 32px);background:#1a1a2e;border:1px solid #e74c3c;border-radius:8px;padding:12px 16px;z-index:9999;font-family:inherit;box-shadow:0 4px 20px rgba(0,0,0,0.5);';

  const title = document.createElement('div');
  title.style.cssText = 'color:#e74c3c;font-weight:600;font-size:13px;margin-bottom:6px;';
  title.textContent = 'Config validation failed (' + fieldErrors.length + ' error' + (fieldErrors.length > 1 ? 's' : '') + ')';
  banner.appendChild(title);

  const list = document.createElement('div');
  list.style.cssText = 'max-height:120px;overflow-y:auto;font-size:12px;';
  for (const fe of fieldErrors) {
    const row = document.createElement('div');
    row.style.cssText = 'color:#ccc;margin:2px 0;white-space:pre-wrap;word-break:break-word;';
    row.textContent = fe.path + ': ' + fe.message + (fe.expected ? ' (expected: ' + fe.expected + ')' : '');
    list.appendChild(row);
  }
  banner.appendChild(list);

  const dismiss = document.createElement('div');
  dismiss.style.cssText = 'color:#666;font-size:11px;margin-top:8px;text-align:right;cursor:pointer;';
  dismiss.textContent = 'dismiss';
  dismiss.addEventListener('click', () => { banner.remove(); if (configErrorTimer) { clearTimeout(configErrorTimer); configErrorTimer = null; } });
  banner.appendChild(dismiss);

  document.body.appendChild(banner);

  // Auto-dismiss after 30 seconds
  configErrorTimer = setTimeout(() => {
    banner.remove();
    configErrorTimer = null;
  }, 30000);
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

  // Active models — performance indicators
  const modelStats = data.modelStats || [];
  if (modelStats.length === 0) {
    modelsEl.textContent = '';
    modelsEl.appendChild(createEmptyEl('No requests yet'));
  } else {
    const maxLatency = Math.max(...modelStats.map(m => m.avgLatencyMs), 1);
    modelsEl.textContent = '';
    // Column headers
    const header = document.createElement('div');
    header.className = 'perf-row perf-header';
    const cols = ['Model', 'Reqs', 'Latency', '', 'Success', 'T/s', '%'];
    for (const col of cols) {
      const span = document.createElement('span');
      span.textContent = col;
      header.appendChild(span);
    }
    modelsEl.appendChild(header);
    for (const m of modelStats) {
      const row = document.createElement('div');
      row.className = 'perf-row';
      row.setAttribute('data-model', m.model || '');

      // Model name
      const nameEl = document.createElement('span');
      nameEl.className = 'model-name';
      nameEl.textContent = shortModel(m.model);
      nameEl.title = m.model;
      row.appendChild(nameEl);

      // Request count
      const countEl = document.createElement('span');
      countEl.className = 'perf-count';
      countEl.textContent = m.count + ' reqs';
      row.appendChild(countEl);

      // Latency bar + value
      const latencyWrap = document.createElement('span');
      latencyWrap.className = 'perf-latency';
      const barTrack = document.createElement('span');
      barTrack.className = 'perf-bar';
      const barFill = document.createElement('span');
      barFill.className = 'perf-bar-fill';
      const pct = maxLatency > 0 ? (m.avgLatencyMs / maxLatency * 100) : 0;
      barFill.style.width = Math.max(pct, 2) + '%';
      if (m.avgLatencyMs < 500) barFill.classList.add('perf-fast');
      else if (m.avgLatencyMs < 1500) barFill.classList.add('perf-medium');
      else barFill.classList.add('perf-slow');
      barTrack.appendChild(barFill);
      const latencyVal = document.createElement('span');
      latencyVal.className = 'perf-latency-val';
      if (m.avgLatencyMs < 500) latencyVal.classList.add('perf-fast');
      else if (m.avgLatencyMs < 1500) latencyVal.classList.add('perf-medium');
      else latencyVal.classList.add('perf-slow');
      latencyVal.textContent = m.avgLatencyMs >= 1000
        ? (m.avgLatencyMs / 1000).toFixed(1) + 's'
        : m.avgLatencyMs + 'ms';
      latencyWrap.appendChild(barTrack);
      latencyWrap.appendChild(latencyVal);
      row.appendChild(latencyWrap);

      // Success rate
      const successEl = document.createElement('span');
      successEl.className = 'perf-success';
      if (m.successRate >= 95) {
        successEl.classList.add('perf-good');
        successEl.textContent = '\u2713 ' + m.successRate.toFixed(0) + '%';
      } else if (m.successRate >= 80) {
        successEl.classList.add('perf-warn');
        successEl.textContent = '\u26A0 ' + m.successRate.toFixed(0) + '%';
      } else {
        successEl.classList.add('perf-bad');
        successEl.textContent = '\u26A0 ' + m.successRate.toFixed(0) + '%';
      }
      row.appendChild(successEl);

      // Tokens/sec
      const tokensEl = document.createElement('span');
      tokensEl.className = 'perf-tokens';
      tokensEl.textContent = m.avgTokensPerSec > 0 ? m.avgTokensPerSec.toFixed(0) + ' t/s' : '\u2014';
      row.appendChild(tokensEl);

      // Cache hit %
      const cacheEl = document.createElement('span');
      cacheEl.className = 'perf-cache';
      cacheEl.textContent = m.avgCacheHitRate > 0 ? m.avgCacheHitRate.toFixed(0) + '%' : '\u2014';
      row.appendChild(cacheEl);

      modelsEl.appendChild(row);
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
    const sorted = [...recentRequests]
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 10);
    for (const r of sorted) {
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

  // Update active models list — model bar UI is now replaced by perf-row from modelStats;
  // appendRequestMetric no longer updates the models section since updateSummary handles it

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

// --- Glow helpers ---
function activateGlow() {
  if (glowActiveCount === 0) {
    document.body.classList.add('glow-active');
  }
  glowActiveCount++;
}

function deactivateGlow() {
  glowActiveCount = Math.max(0, glowActiveCount - 1);
  if (glowActiveCount === 0) {
    const body = document.body;
    // Fade out — CSS transition handles opacity
    body.classList.remove('glow-active');
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
let cachedFullSummary = null;
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
    activateGlow();
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
    deactivateGlow();
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
    deactivateGlow();
    // Dismiss track immediately so it fades together with the fill
    setTimeout(() => {
      entry.element.classList.add('dismissing');
      setTimeout(() => removeActivityBar(data.requestId), 800);
    }, 2000);
  }
}

function connectWebSocket(port) {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  // Clear any pending reconnect timer from a previous close event
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
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
    wsBackoff = 3000;
    setStatus('live');
    // Defensive: fetch summary via HTTP to ensure active models/providers
    // are populated even if the initial WS summary message is missed
    fetchSummary();
    fetchDaemonVersion();
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
        cachedFullSummary = msg.data;
        scheduleSummaryUpdate(msg.data);
      } else if (msg.type === 'summary_delta') {
        // Apply delta to cached full summary
        if (cachedFullSummary) {
          const merged = Object.assign({}, cachedFullSummary, msg.data);
          // Handle recentRequests delta: only new entries, append
          if (msg.data.recentRequests && cachedFullSummary.recentRequests) {
            const prevIds = new Set(cachedFullSummary.recentRequests.map(r => r.requestId));
            const newOnly = msg.data.recentRequests.filter(r => !prevIds.has(r.requestId));
            merged.recentRequests = [...newOnly, ...cachedFullSummary.recentRequests.filter(r => !new Set(msg.data.recentRequests.map(r => r.requestId)).has(r.requestId))];
          }
          cachedFullSummary = merged;
          scheduleSummaryUpdate(merged);
        }
        // If no cached state yet, ignore — full summary will arrive soon
      } else if (msg.type === 'request') {
        appendRequestMetric(msg.data);
      } else if (msg.type === 'stream') {
        handleStreamEvent(msg.data);
      } else if (msg.type === 'config_error') {
        showConfigError(msg.data.fieldErrors);
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
    cachedFullSummary = data;
    scheduleSummaryUpdate(data);
    // Don't overwrite status if WebSocket is already live
    if (ws) setStatus('live');
    fetchDaemonVersion();
  } catch (err) {
    console.error('[fetchSummary] failed:', err);
    setStatus(false);
  }
}

async function fetchDaemonVersion() {
  try {
    const data = await invoke('fetch_version', { port: DEFAULT_PORT });
    const el = document.querySelector('.app-credit__version');
    if (el) el.textContent = 'v' + data.version;
  } catch {
    // daemon not running — leave version blank
  }
}

// WebSocket state
let ws = null;
let pollTimer = null;
let wsBackoff = 3000;  // was 1000 — gives daemon time to restart
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
