// app.js — ModelWeaver GUI (Tauri) — uses invoke() for all HTTP calls
const DEFAULT_PORT = 3456;
const POLL_INTERVAL = 5000;

/** Safely append a styled chip span to a parent element. */
function appendChip(parent, className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  parent.appendChild(span);
}

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
const sessionsEl = document.getElementById('sessions');

// Raw accumulator variables — avoid parseFormattedNumber round-trip precision loss
let _rawInputTokens = 0;
let _rawOutputTokens = 0;
let _rawRequests = 0;
let _rawTpsSum = 0;
let _rawTpsCount = 0;
let _rawCacheRead = 0;
let _rawCacheCreation = 0;

// Activity bar state
const activityContent = document.getElementById('activity-content');
const activeRequests = new Map();
const STALE_BAR_TIMEOUT_MS = 120_000; // 2 minutes
const barLifecycle = new Map(); // requestId -> 'active' | 'closing' | 'removed'

// Provider health cache (from provider_health WS messages)
let providerHealthCache = null;

// Keyed DOM diffing Maps for updateSummary
const modelRows = new Map();
const providerRows = new Map();
const recentRows = new Map();
const sessionRows = new Map();

// Provider rendering: renderProviders() reads cachedFullSummary directly

// Global stale check interval (replaces per-bar timers)
const STALE_CHECK_INTERVAL_MS = 5000;
let staleCheckTimer = null;

function ensureStaleChecker() {
  if (staleCheckTimer || activeRequests.size === 0) return;
  staleCheckTimer = setInterval(() => {
    if (activeRequests.size === 0) {
      clearInterval(staleCheckTimer);
      staleCheckTimer = null;
      return;
    }
    const now = Date.now();
    for (const [requestId, entry] of activeRequests) {
      if (now - entry.startTime > STALE_BAR_TIMEOUT_MS && barLifecycle.get(requestId) === 'active') {
        console.warn('[Activity] Bar stale — auto-dismissing', requestId);
        entry.fill.classList.remove('state-streaming', 'state-fallback', 'state-start');
        entry.fill.classList.add('state-error');
        entry.statusSpan.textContent = 'stalled';
        removeActivityBar(requestId);
      }
    }
  }, STALE_CHECK_INTERVAL_MS);
}

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
const COMPACT_HEIGHT = 560;
const NORMAL_HEIGHT = 960;
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
  // Sync raw accumulators from backend (authoritative source of truth)
  _rawRequests = data.totalRequests || 0;
  _rawInputTokens = data.totalInputTokens || 0;
  _rawOutputTokens = data.totalOutputTokens || 0;
  _rawCacheRead = data.totalCacheReadTokens || 0;
  _rawCacheCreation = data.totalCacheCreationTokens || 0;
  _rawTpsSum = (data.avgTokensPerSec || 0) * _rawRequests;
  _rawTpsCount = _rawRequests;

  // Render from raw accumulators
  statSpeed.textContent = (data.avgTokensPerSec || 0).toFixed(1);
  statRequests.textContent = _rawRequests;
  statInputTokens.textContent = formatNumber(_rawInputTokens);
  statOutputTokens.textContent = formatNumber(_rawOutputTokens);
  statCache.textContent = data.avgCacheHitRate > 0 ? data.avgCacheHitRate.toFixed(0) + '%' : '\u2014';
  // Uptime
  const uptimeEl = document.getElementById('last-refresh');
  if (uptimeEl) uptimeEl.textContent = formatUptime(data.uptimeSeconds || 0);
  // --- Models: keyed DOM diffing ---
  const modelStats = data.modelStats || [];
  const modelKeys = new Set(modelStats.map(m => m.model));
  // Remove rows for models no longer present
  for (const [key, row] of modelRows) {
    if (!modelKeys.has(key)) {
      row.remove();
      modelRows.delete(key);
    }
  }
  if (modelStats.length === 0) {
    // Show empty state in place of rows (keep header if already built)
    if (modelRows.size === 0 && !modelsEl.querySelector('.empty')) {
      modelsEl.appendChild(createEmptyEl('No requests yet'));
    }
  } else {
    const maxLatency = Math.max(...modelStats.map(m => m.avgLatencyMs), 1);
    // Ensure header exists
    if (!modelsEl.querySelector('.perf-header')) {
      const header = document.createElement('div');
      header.className = 'perf-row perf-header';
      const cols = ['Model', 'Reqs', 'Latency', '', 'Success', 'T/s', '%'];
      for (const col of cols) {
        const span = document.createElement('span');
        span.textContent = col;
        header.appendChild(span);
      }
      modelsEl.appendChild(header);
    }
    // Remove empty placeholder if present
    const empty = modelsEl.querySelector('.empty');
    if (empty) empty.remove();
    for (const m of modelStats) {
      const key = m.model || '';
      let row = modelRows.get(key);
      if (!row) {
        row = document.createElement('div');
        row.className = 'perf-row';
        row.setAttribute('data-model', key);
        // Build sub-elements, append to row, and cache refs
        const specs = [
          ['model-name', '_nameEl'], ['perf-count', '_countEl'],
          ['perf-latency', null], ['perf-success', '_successEl'],
          ['perf-tokens', '_tokensEl'], ['perf-cache', '_cacheEl'],
        ];
        let barFill, latencyVal;
        for (const [cls, ref] of specs) {
          const span = document.createElement('span');
          span.className = cls;
          row.appendChild(span);
          if (ref) row[ref] = span;
          if (cls === 'perf-latency') {
            const track = document.createElement('span');
            track.className = 'perf-bar';
            barFill = document.createElement('span');
            barFill.className = 'perf-bar-fill';
            track.appendChild(barFill);
            latencyVal = document.createElement('span');
            latencyVal.className = 'perf-latency-val';
            span.appendChild(track);
            span.appendChild(latencyVal);
          }
        }
        row._barFill = barFill;
        row._latencyVal = latencyVal;
        modelsEl.appendChild(row);
        modelRows.set(key, row);
      }
      // Patch values — only update DOM if changed
      const short = shortModel(m.model);
      if (row._nameEl.textContent !== short) {
        row._nameEl.textContent = short;
        row._nameEl.title = m.model;
      }
      const countText = m.count + ' reqs';
      if (row._countEl.textContent !== countText) row._countEl.textContent = countText;
      const pct = maxLatency > 0 ? (m.avgLatencyMs / maxLatency * 100) : 0;
      const newWidth = Math.max(pct, 2) + '%';
      if (row._barFill.style.width !== newWidth) row._barFill.style.width = newWidth;
      // Latency color class
      const lc = m.avgLatencyMs < 500 ? 'perf-fast' : m.avgLatencyMs < 1500 ? 'perf-medium' : 'perf-slow';
      for (const el of [row._barFill, row._latencyVal]) {
        el.classList.toggle('perf-fast', lc === 'perf-fast');
        el.classList.toggle('perf-medium', lc === 'perf-medium');
        el.classList.toggle('perf-slow', lc === 'perf-slow');
      }
      const latencyText = m.avgLatencyMs >= 1000
        ? (m.avgLatencyMs / 1000).toFixed(1) + 's' : m.avgLatencyMs + 'ms';
      if (row._latencyVal.textContent !== latencyText) row._latencyVal.textContent = latencyText;
      // Success rate
      const sr = m.successRate >= 0 ? m.successRate.toFixed(0) + '%' : '\u2014';
      const sp = m.successRate >= 95 ? '\u2713 ' : '\u26A0 ';
      const sc = m.successRate >= 95 ? 'perf-good' : m.successRate >= 80 ? 'perf-warn' : 'perf-bad';
      const successText = sp + sr;
      if (row._successEl.textContent !== successText) {
        row._successEl.textContent = successText;
        row._successEl.className = 'perf-success ' + sc;
      }
      // Tokens/sec
      const tokenText = m.avgTokensPerSec > 0 ? m.avgTokensPerSec.toFixed(0) + ' t/s' : '\u2014';
      if (row._tokensEl.textContent !== tokenText) row._tokensEl.textContent = tokenText;
      // Cache hit rate
      const cacheText = m.avgCacheHitRate > 0 ? m.avgCacheHitRate.toFixed(0) + '%' : '\u2014';
      if (row._cacheEl.textContent !== cacheText) row._cacheEl.textContent = cacheText;
    }
  }
  // --- Sessions: keyed DOM diffing ---
  renderSessions(cachedFullSummary);
  // --- Providers: renderProviders reads cachedFullSummary directly, called by handleProviderHealth ---
  // --- Recent requests: keyed DOM diffing (cap 10) ---
  const recentRequests = (data.recentRequests || [])
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 10);
  const recentKeys = new Set(recentRequests.map(r => r.requestId));
  // Remove rows for requestIds no longer present
  for (const [key, row] of recentRows) {
    if (!recentKeys.has(key)) {
      row.remove();
      recentRows.delete(key);
    }
  }
  if (recentRequests.length === 0) {
    if (recentRows.size === 0 && !recentEl.querySelector('.empty')) {
      recentEl.appendChild(createEmptyEl('No requests yet'));
    }
  } else {
    const empty = recentEl.querySelector('.empty');
    if (empty) empty.remove();
    for (const r of recentRequests) {
      const key = r.requestId || '';
      let item = recentRows.get(key);
      if (!item) {
        item = document.createElement('div');
        item.className = 'recent-item';
        const refs = ['recent-model', 'recent-provider', 'recent-tokens'];
        const cacheKeys = ['_modelEl', '_providerEl', '_tokensEl'];
        refs.forEach((cls, i) => {
          const el = document.createElement('span');
          el.className = cls;
          item.appendChild(el);
          item[cacheKeys[i]] = el;
        });
        recentEl.appendChild(item);
        recentRows.set(key, item);
      }
      const latency = r.latencyMs >= 1000 ? (r.latencyMs / 1000).toFixed(1) + 's' : r.latencyMs + 'ms';
      const actualModel = r.actualModel || r.model || 'unknown';
      const requestedModel = r.model || 'unknown';
      const showAlias = actualModel !== requestedModel;
      const newModelText = showAlias
        ? shortModel(actualModel) + ' (' + shortModel(requestedModel) + ')'
        : shortModel(actualModel);
      const newTitle = showAlias ? actualModel + ' (via ' + requestedModel + ')' : actualModel;
      if (item._modelEl.textContent !== newModelText) {
        item._modelEl.textContent = newModelText;
        item._modelEl.title = newTitle;
      }
      const newProvider = r.targetProvider || r.provider || '';
      if (item._providerEl.textContent !== newProvider) item._providerEl.textContent = newProvider;
      const newTokens = formatNumber((r.inputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0) + (r.outputTokens || 0)) + ' ' + latency;
      if (item._tokensEl.textContent !== newTokens) item._tokensEl.textContent = newTokens;
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
  // Update raw accumulators (no precision loss from DOM round-trips)
  _rawRequests++;
  const allInput = (r.inputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0);
  _rawInputTokens += allInput;
  _rawOutputTokens += (r.outputTokens || 0);
  _rawCacheRead += (r.cacheReadTokens || 0);
  _rawCacheCreation += (r.cacheCreationTokens || 0);

  // Render from raw accumulators
  statRequests.textContent = _rawRequests;
  statInputTokens.textContent = formatNumber(_rawInputTokens);
  statOutputTokens.textContent = formatNumber(_rawOutputTokens);

  // Running average speed (only count non-zero TPS entries)
  if (r.tokensPerSec != null && r.tokensPerSec > 0) {
    _rawTpsSum += r.tokensPerSec;
    _rawTpsCount++;
    statSpeed.textContent = (_rawTpsSum / _rawTpsCount).toFixed(1);
  }

  // Cache hit rate
  if (_rawInputTokens > 0 && _rawCacheRead > 0) {
    statCache.textContent = (Math.round((_rawCacheRead / _rawInputTokens) * 1000) / 10).toFixed(0) + '%';
  }

  // Deduplicate — skip DOM creation if this requestId was already rendered
  if (recentRows.has(r.requestId)) return;

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
  tokens.textContent = formatNumber((r.inputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheCreationTokens || 0) + (r.outputTokens || 0)) + ' ' + latency;

  item.appendChild(model);
  item.appendChild(provider);
  item.appendChild(tokens);
  recentEl.prepend(item);
  recentRows.set(r.requestId, item);

  // Cap visible items at 10
  while (recentEl.children.length > 10) {
    recentEl.removeChild(recentEl.lastChild);
  }

  // Update active models list — model bar UI is now replaced by perf-row from modelStats;
  // appendRequestMetric no longer updates the models section since updateSummary handles it

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

  barLifecycle.set(requestId, 'active');
  ensureStaleChecker();

  const entry = { element: track, fill, label, statusSpan, modelName, startTime: Date.now(), lastOutputTokens: 0, prevTimestamp: 0, model, tier, ttfbTimer: null, lastStreamMs: 0, maxTokens: null, provider: null, slowWarned: false };

  return entry;
}


function removeActivityBar(requestId) {
  deactivateGlow();
  const entry = activeRequests.get(requestId);
  if (!entry) return;
  if (entry.barDismissed) return;
  entry.barDismissed = true;
  if (entry.ttfbTimer) { cancelAnimationFrame(entry.ttfbTimer); entry.ttfbTimer = null; }
  entry.ttfbCleared = true;
  const bar = entry.element;
  const fill = bar.querySelector('.activity-fill');
  if (fill && fill.style.width !== '100%') {
    fill.style.width = '100%';
  }
  // Clean up Maps immediately (bar is still in DOM for CSS animation)
  barLifecycle.delete(requestId);
  activeRequests.delete(requestId);

  // Apply dismissing class for CSS fade-out animation
  bar.classList.add('dismissing');

  // Remove bar after CSS transition completes
  const cleanup = () => {
    if (bar.parentNode) bar.parentNode.removeChild(bar);
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
  };

  // D: Keep completed bar for 2s before dismissing — let user read final stats
  bar.addEventListener('transitionend', cleanup, { once: true });
  setTimeout(cleanup, 2600); // 2.5s fallback (2s visible + 0.5s animation)
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
  entry.fill.classList.remove('state-start');
  entry.fill.classList.add('state-streaming');
  const elapsed = (Date.now() - entry.startTime) / 1000;
  // A: Token-based progress — use outputTokens/maxTokens when available
  const tok = data.outputTokens || 0;
  let pct;
  if (entry.maxTokens && entry.maxTokens > 0 && tok > 0) {
    pct = Math.min(95, (tok / entry.maxTokens) * 100);
  } else {
    // Fallback: logarithmic time-based progress (fast ramp, slow plateau)
    pct = Math.min(80, Math.log(1 + elapsed * 2) / Math.log(31) * 80);
  }
  entry.fill.style.width = pct + '%';
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
  // C: Slow provider warning after 10s
  if (elapsed > 10 && !entry.slowWarned && tok === 0) {
    entry.slowWarned = true;
    entry.fill.classList.add('state-slow');
    entry.statusSpan.textContent = secs + ' \u00b7 slow...';
    return;
  }
  let meta = tok > 0
    ? tok + ' tok' + (tps ? ' \u00b7 ' + tps : '') + ' \u00b7 ' + secs
    : secs;
  // Cache hit rate and context usage (only show when non-zero)
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

function handleStreamEvent(data) {
  if (data.state === 'start') {
    activateGlow();
    // Guard: don't create duplicate bars for the same request
    if (activeRequests.has(data.requestId)) return;
    const bar = createActivityBar(data.requestId, data.model, data.tier);
    activeRequests.set(data.requestId, bar);
    ensureStaleChecker();
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
    // Update bar label if model differed (e.g. fallback, ttfb provider switch)
    if (data.model) {
      entry.modelName.textContent = shortModel(data.model);
      entry.modelName.title = data.model;
    }

  } else if (data.state === 'streaming') {
    if (!activeRequests.has(data.requestId)) return;
    const entry = activeRequests.get(data.requestId);
    // Per-bar throttle: skip if updated within 200ms
    const STREAM_THROTTLE_MS = 200;
    const now = Date.now();
    if (entry.lastStreamMs && now - entry.lastStreamMs < STREAM_THROTTLE_MS) return;
    entry.lastStreamMs = now;
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

  } else if (data.state === 'complete') {
    const entry = activeRequests.get(data.requestId);
    if (!entry) return;
    if (entry) entry.ttfbCleared = true;
    if (entry?.ttfbTimer) cancelAnimationFrame(entry.ttfbTimer);
    if (entry) entry.ttfbTimer = null;
    entry.element.removeAttribute('data-preview');
    entry.element.style.marginBottom = '';
    entry.fill.classList.remove('state-streaming', 'state-fallback', 'state-start', 'state-slow');
    entry.fill.classList.add('state-complete');
    entry.fill.style.width = '100%';
    const tps = data.tokensPerSec ? data.tokensPerSec.toFixed(0) + ' tok/s' : '';
    const latency = data.latencyMs >= 1000 ? (data.latencyMs / 1000).toFixed(1) + 's' : data.latencyMs + 'ms';
    let finalMeta = (data.outputTokens || 0) + ' tok \u00b7 ' + tps + ' \u00b7 ' + latency;
    if (data.cacheHitRate != null && data.cacheHitRate > 0) finalMeta += ' \u00b7 ' + data.cacheHitRate.toFixed(0) + '% cache';
    if (data.contextPercent != null && data.contextPercent > 0) finalMeta += ' \u00b7 ' + data.contextPercent.toFixed(0) + '% ctx';
    entry.statusSpan.textContent = finalMeta;
    // Update bar label to show actual model that served the request
    if (data.model) {
      entry.modelName.textContent = shortModel(data.model);
      entry.modelName.title = data.model;
    }
    removeActivityBar(data.requestId);

  } else if (data.state === 'error') {
    const entry = activeRequests.get(data.requestId);
    if (!entry) return;
    if (entry) entry.ttfbCleared = true;
    if (entry?.ttfbTimer) cancelAnimationFrame(entry.ttfbTimer);
    if (entry) entry.ttfbTimer = null;
    entry.element.removeAttribute('data-preview');
    entry.element.style.marginBottom = '';
    entry.fill.classList.remove('state-streaming', 'state-fallback', 'state-start');
    entry.fill.classList.add('state-error');
    if (!entry.fill.style.width || entry.fill.style.width === '0%') {
      entry.fill.style.width = '10%';
    }
    entry.statusSpan.textContent = 'error ' + (data.status || '');
    removeActivityBar(data.requestId);
  }
}

function handleProviderHealth(data) {
  const distArr = cachedFullSummary?.providerDistribution || [];
  const distMap = {};
  for (const d of distArr) distMap[d.provider] = d.count;
  const merged = {};
  for (const [name, entry] of Object.entries(data)) {
    merged[name] = {
      ...entry,
      totalRequests: distMap[name] || 0,
      errorBreakdown: entry.errorBreakdown || null,
    };
  }
  providerHealthCache = merged;
  renderProviders();
}

function renderSessions(summary) {
  const sessions = summary?.sessionStats || [];
  const sessionKeys = new Set(sessions.map(s => s.sessionId));

  // Remove rows for sessionIds no longer present
  for (const [key, row] of sessionRows) {
    if (!sessionKeys.has(key)) {
      row.remove();
      sessionRows.delete(key);
    }
  }

  // Empty state
  const empty = sessionsEl.querySelector('.empty');
  if (sessions.length === 0) {
    if (!empty) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No active sessions';
      sessionsEl.appendChild(e);
    }
    return;
  }
  if (empty) empty.remove();

  // Sort by lastSeen descending
  const sorted = [...sessions].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const now = Date.now();

  for (const s of sorted) {
    let row = sessionRows.get(s.sessionId);
    if (!row) {
      row = document.createElement('div');
      row.className = 'session-card';
      row.setAttribute('data-session', s.sessionId);
      const header = document.createElement('div');
      header.className = 'session-header';
      const idEl = document.createElement('span');
      idEl.className = 'session-id';
      idEl.title = s.sessionId;
      const connBadge = document.createElement('span');
      connBadge.className = 'session-conn-badge';
      header.appendChild(idEl);
      header.appendChild(connBadge);
      row.appendChild(header);
      const meta = document.createElement('div');
      meta.className = 'session-meta';
      row.appendChild(meta);
      sessionsEl.appendChild(row);
      row._idEl = idEl;
      row._connEl = connBadge;
      row._metaEl = meta;
      sessionRows.set(s.sessionId, row);
    }
    // Show model names (e.g. "glm-5.1, MiniMax-M2.7") as primary identifier
    const modelNames = s.models && s.models.length > 0
      ? s.models.join(', ')
      : (s.sessionId.length > 12 ? s.sessionId.slice(0, 8) + '\u2026' : s.sessionId);
    if (row._idEl.textContent !== modelNames) row._idEl.textContent = modelNames;
    // Connection count badge (show modelCount from pool, or "—" if unavailable)
    const connCount = s.modelCount ?? 0;
    const badgeText = connCount > 0 ? connCount + ' conn' + (connCount !== 1 ? 's' : '') : '\u2014';
    if (row._connEl.textContent !== badgeText) row._connEl.textContent = badgeText;
    // Meta line: request count + last seen
    const reqCount = s.requestCount || 0;
    const ago = s.lastSeen ? Math.round((now - s.lastSeen) / 1000) : null;
    const agoText = ago !== null && ago < 60 ? ago + 's ago'
      : ago !== null && ago < 3600 ? Math.round(ago / 60) + 'm ago'
      : ago !== null ? Math.round(ago / 3600) + 'h ago'
      : '\u2014';
    const metaText = reqCount + ' reqs \u00B7 ' + agoText;
    if (row._metaEl.textContent !== metaText) row._metaEl.textContent = metaText;
  }
}

function renderProviders() {
  if (!providerHealthCache) return;
  const health = providerHealthCache;
  const keys = Object.keys(health);
  for (const [key, row] of providerRows) {
    if (!keys.includes(key)) {
      row.remove();
      providerRows.delete(key);
    }
  }
  const empty = providersEl.querySelector('.empty');
  if (empty) empty.remove();
  const stateMap = { closed: '\uD83D\uDFE2 OK', 'half-open': '\uD83D\uDFE1 Resuming', open: '\uD83D\uDD34 Not OK' };
  for (const [name, entry] of Object.entries(health)) {
    let row = providerRows.get(name);
    if (!row) {
      row = document.createElement('div');
      row.className = 'provider-card';
      row.setAttribute('data-provider', name);
      const row1 = document.createElement('div');
      row1.className = 'provider-card-row1';
      const nameEl = document.createElement('span');
      nameEl.className = 'provider-name';
      nameEl.textContent = name;
      const stateEl = document.createElement('span');
      stateEl.className = 'provider-state';
      row1.appendChild(nameEl);
      row1.appendChild(stateEl);
      row.appendChild(row1);
      const statsEl = document.createElement('span');
      statsEl.className = 'provider-stats';
      row.appendChild(statsEl);
      const errsEl = document.createElement('span');
      errsEl.className = 'provider-errs';
      row.appendChild(errsEl);
      providersEl.appendChild(row);
      row._nameEl = nameEl;
      row._stateEl = stateEl;
      row._statsEl = statsEl;
      row._errsEl = errsEl;
      providerRows.set(name, row);
    }
    row._nameEl.textContent = name;
    row._stateEl.textContent = stateMap[entry.state] || entry.state || '\u2014';
    const total = entry.totalRequests || 0;
    const errTotal = entry.errorBreakdown?.total || 0;
    const successRate = total > 0 ? Math.round((total - errTotal) / total * 100) : null;
    row._statsEl.textContent = total + ' req \u00B7 ' + (successRate !== null ? successRate + '% success' : '\u2014 success');
    const errs = entry.errorBreakdown?.errors || {};
    const connErrs = entry.connectionErrors || {};
    // Clear previous chips
    row._errsEl.replaceChildren();
    let hasChips = false;
    if (errs[429] > 0) { appendChip(row._errsEl, 'err-429', errs[429] + '\u00D7 429'); hasChips = true; }
    for (const [code, count] of Object.entries(errs)) {
      if (parseInt(code) >= 500 && code !== '429' && count > 0) {
        appendChip(row._errsEl, 'err-5xx', count + '\u00D7 ' + code);
        hasChips = true;
      }
    }
    if (connErrs.stalls > 0) { appendChip(row._errsEl, 'err-stall', connErrs.stalls + '\u00D7 stall'); hasChips = true; }
    if (connErrs.ttfbTimeouts > 0) { appendChip(row._errsEl, 'err-ttfb', connErrs.ttfbTimeouts + '\u00D7 TTFB'); hasChips = true; }
    if (connErrs.connectionErrors > 0) { appendChip(row._errsEl, 'err-conn', connErrs.connectionErrors + '\u00D7 conn'); hasChips = true; }
    if (!hasChips) appendChip(row._errsEl, 'no-errors', '\u2014');
  }
  const cards = Array.from(providersEl.querySelectorAll('.provider-card'));
  cards.sort((a, b) => {
    const aName = a.getAttribute('data-provider');
    const bName = b.getAttribute('data-provider');
    const aEntry = providerHealthCache[aName] || {};
    const bEntry = providerHealthCache[bName] || {};
    const aHasErr = (aEntry.errorBreakdown?.total > 0) || ((aEntry.connectionErrors?.stalls + aEntry.connectionErrors?.ttfbTimeouts + aEntry.connectionErrors?.connectionErrors) > 0);
    const bHasErr = (bEntry.errorBreakdown?.total > 0) || ((bEntry.connectionErrors?.stalls + bEntry.connectionErrors?.ttfbTimeouts + bEntry.connectionErrors?.connectionErrors) > 0);
    if (aHasErr && !bHasErr) return -1;
    if (!aHasErr && bHasErr) return 1;
    return aName.localeCompare(bName);
  });
  cards.forEach(r => providersEl.appendChild(r));
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
    if (pageReloadTimer) { clearInterval(pageReloadTimer); pageReloadTimer = null; }
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
            const combined = [...msg.data.recentRequests, ...cachedFullSummary.recentRequests];
            const seen = new Set();
            const deduped = [];
            for (const r of combined) {
              if (r.requestId && !seen.has(r.requestId)) {
                seen.add(r.requestId);
                deduped.push(r);
              }
            }
            merged.recentRequests = deduped
              .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
              .slice(0, 10);
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
      } else if (msg.type === 'provider_health') {
        handleProviderHealth(msg.data);
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
    // WKWebView cannot reconnect WS after server restart — reload page once daemon is back
    schedulePageReload();
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

// After WS close, once HTTP polling confirms daemon is back,
// reload the page to get a fresh WebSocket. WKWebView cannot
// reliably reconnect WebSocket to a restarted server.
let pageReloadTimer = null;
function schedulePageReload() {
  if (pageReloadTimer) return; // already scheduled
  pageReloadTimer = setInterval(async () => {
    try {
      await invoke('fetch_metrics', { port: DEFAULT_PORT });
      clearInterval(pageReloadTimer);
      pageReloadTimer = null;
      window.location.reload();
    } catch {
      // daemon still down
    }
  }, 2000);
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

// --- Section Reorder (mousedown/mousemove/mouseup for WKWebView compat) ---
const DEFAULT_SECTION_ORDER = ['models-section', 'providers-section', 'sessions-section', 'recent-section'];
const SECTION_ORDER_KEY = 'sectionOrder';

function getSectionAnchor() {
  return document.querySelector('.app-credit');
}

function getCurrentSectionOrder() {
  const anchor = getSectionAnchor();
  const app = document.getElementById('app');
  const order = [];
  let node = app.firstElementChild;
  while (node && node !== anchor) {
    if (node.classList && node.classList.contains('section') && node.id) order.push(node.id);
    node = node.nextElementSibling;
  }
  return order;
}

function applySectionOrder(order) {
  const anchor = getSectionAnchor();
  const app = document.getElementById('app');
  order.forEach(sectionId => {
    const section = document.getElementById(sectionId);
    if (section && section.parentElement === app) {
      app.insertBefore(section, anchor);
    }
  });
}

function saveSectionOrder(order) {
  try {
    localStorage.setItem(SECTION_ORDER_KEY, JSON.stringify(order));
  } catch (e) {}
}

function isDefaultOrder() {
  const current = getCurrentSectionOrder();
  return current.length === DEFAULT_SECTION_ORDER.length &&
    current.every((id, i) => id === DEFAULT_SECTION_ORDER[i]);
}

function updateResetIcon() {
  const icon = document.getElementById('reset-section-order');
  if (!icon) return;
  icon.style.display = isDefaultOrder() ? 'none' : '';
}

(function initSectionDragDrop() {
  let draggedEl = null;   // the .section being dragged

  // Find which section the cursor is over, and whether top or bottom half
  function getDropTarget(y) {
    const sections = document.querySelectorAll('#app > .section');
    for (const sec of sections) {
      if (sec === draggedEl) continue;
      const rect = sec.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) {
        return { section: sec, before: y < rect.top + rect.height / 2 };
      }
    }
    return null;
  }

  function clearIndicators() {
    document.querySelectorAll('.section').forEach(s => {
      s.classList.remove('drag-over-top', 'drag-over-bottom');
    });
  }

  document.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    e.preventDefault();

    draggedEl = handle.closest('.section');
    if (!draggedEl) return;

    startY = e.clientY;
    draggedEl.classList.add('dragging');
  });

  document.addEventListener('mousemove', (e) => {
    if (!draggedEl) return;
    e.preventDefault();

    const target = getDropTarget(e.clientY);
    clearIndicators();

    if (target) {
      if (target.before) {
        target.section.classList.add('drag-over-top');
      } else {
        target.section.classList.add('drag-over-bottom');
      }
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (!draggedEl) return;

    const target = getDropTarget(e.clientY);
    if (target) {
      const parent = draggedEl.parentNode;
      if (target.before) {
        parent.insertBefore(draggedEl, target.section);
      } else {
        parent.insertBefore(draggedEl, target.section.nextSibling);
      }
      saveSectionOrder(getCurrentSectionOrder());
      updateResetIcon();
    }

    clearIndicators();
    draggedEl.classList.remove('dragging');
    draggedEl = null;
  });

  // Reset icon
  document.getElementById('reset-section-order').addEventListener('click', () => {
    applySectionOrder(DEFAULT_SECTION_ORDER);
    saveSectionOrder(DEFAULT_SECTION_ORDER);
    updateResetIcon();
  });
})();

// Apply saved section order on load
(function() {
  let order = DEFAULT_SECTION_ORDER;
  try {
    const saved = localStorage.getItem(SECTION_ORDER_KEY);
    if (saved) order = JSON.parse(saved);
  } catch (e) {}
  applySectionOrder(order);
  updateResetIcon();
})();

// Set custom titlebar version from the native window title (set by Rust backend)
if (window.__TAURI__) {
  const titleEl = document.querySelector('.titlebar .title');
  if (titleEl) {
    window.__TAURI__.window.getCurrentWindow().title().then((nativeTitle) => {
      if (nativeTitle) titleEl.textContent = nativeTitle;
    });
  }
}

// Initial HTTP fetch, start polling, and attempt WebSocket connection
fetchSummary();
pollTimer = setInterval(fetchSummary, POLL_INTERVAL);
connectWebSocket(DEFAULT_PORT);
