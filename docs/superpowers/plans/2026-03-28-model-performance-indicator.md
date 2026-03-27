# Model Performance Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend MetricsSummary with per-model performance aggregates and display them in the GUI

**Architecture:** Aggregate ring buffer entries by model name on read, include in existing getSummary() response. No new endpoint — piggyback on WebSocket summary push.

**Tech Stack:** TypeScript (metrics), vanilla JS + CSS (GUI)

---

## Task 1: Backend types.ts — Add ModelPerformanceStats interface

**Files:**
- `src/types.ts`

**Steps:**
1. Add new `ModelPerformanceStats` interface after line 74 (after `RequestMetrics`):
```typescript
export interface ModelPerformanceStats {
  model: string;
  count: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  successRate: number;       // 0-100
  avgTokensPerSec: number;
  avgCacheHitRate: number;   // 0-100
  errorCount: number;
  providerBreakdown: {
    provider: string;
    count: number;
    avgLatencyMs: number;
    errorCount: number;
  }[];
}
```

2. Add `modelStats` field to `MetricsSummary` interface (line 76):
```typescript
export interface MetricsSummary {
  uptimeSeconds: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgTokensPerSec: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  avgCacheHitRate: number;
  activeModels: { model: string; actualModel?: string; count: number; lastSeen: number }[];
  providerDistribution: { provider: string; count: number }[];
  recentRequests: RequestMetrics[];
  modelStats: ModelPerformanceStats[];  // <-- NEW FIELD
}
```

**Commit:**
```bash
git add src/types.ts
git commit -m "feat(types): add ModelPerformanceStats interface and modelStats field"
```

**Verification:**
```bash
# TypeScript compilation should pass
npm run build
```

---

## Task 2: Backend metrics.ts — Add getModelStats() method

**Files:**
- `src/metrics.ts`

**Steps:**
1. Add private `getModelStats()` method to `MetricsStore` class (after `getRecentRequests()` method, around line 185):

```typescript
private getModelStats(): ModelPerformanceStats[] {
  // Group buffer entries by model name
  const modelMap = new Map<string, RequestMetrics[]>();

  for (let i = 0; i < this.count; i++) {
    const index = ((this.head - 1 - i) % this.maxSize + this.maxSize) % this.maxSize;
    const entry = this.buffer[index];
    if (entry === null) continue;

    const key = entry.actualModel || entry.model;
    if (!modelMap.has(key)) {
      modelMap.set(key, []);
    }
    modelMap.get(key)!.push(entry);
  }

  // Compute stats for each model
  const stats: ModelPerformanceStats[] = [];

  for (const [model, entries] of modelMap) {
    const count = entries.length;

    // Latency stats
    const latencies = entries.map(e => e.latencyMs).sort((a, b) => a - b);
    const avgLatencyMs = latencies.reduce((sum, v) => sum + v, 0) / count;
    const p50LatencyMs = latencies[Math.floor(count * 0.5)];
    const p95LatencyMs = latencies[Math.floor(count * 0.95)];

    // Success rate (status 200-299)
    const successCount = entries.filter(e => e.status >= 200 && e.status < 300).length;
    const successRate = (successCount / count) * 100;
    const errorCount = count - successCount;

    // Tokens/sec
    const avgTokensPerSec = entries.reduce((sum, e) => sum + (e.tokensPerSec || 0), 0) / count;

    // Cache hit rate
    let cacheHitRateSum = 0;
    let cacheHitRateCount = 0;
    for (const e of entries) {
      const totalInput = (e.inputTokens || 0) + (e.cacheReadTokens || 0) + (e.cacheCreationTokens || 0);
      if (totalInput > 0 && (e.cacheReadTokens || 0) > 0) {
        cacheHitRateSum += (e.cacheReadTokens! / totalInput) * 100;
        cacheHitRateCount++;
      }
    }
    const avgCacheHitRate = cacheHitRateCount > 0 ? cacheHitRateSum / cacheHitRateCount : 0;

    // Provider breakdown
    const providerMap = new Map<string, { count: number; latencySum: number; errorCount: number }>();
    for (const e of entries) {
      const pKey = e.targetProvider ?? e.provider;
      if (!providerMap.has(pKey)) {
        providerMap.set(pKey, { count: 0, latencySum: 0, errorCount: 0 });
      }
      const p = providerMap.get(pKey)!;
      p.count++;
      p.latencySum += e.latencyMs;
      if (e.status < 200 || e.status >= 300) p.errorCount++;
    }

    const providerBreakdown = [...providerMap.entries()].map(([provider, data]) => ({
      provider,
      count: data.count,
      avgLatencyMs: data.latencySum / data.count,
      errorCount: data.errorCount,
    }));

    stats.push({
      model,
      count,
      avgLatencyMs: Math.round(avgLatencyMs),
      p50LatencyMs: Math.round(p50LatencyMs),
      p95LatencyMs: Math.round(p95LatencyMs),
      successRate: Math.round(successRate * 10) / 10,
      avgTokensPerSec: Math.round(avgTokensPerSec * 10) / 10,
      avgCacheHitRate: Math.round(avgCacheHitRate * 10) / 10,
      errorCount,
      providerBreakdown,
    });
  }

  // Sort by count descending
  return stats.sort((a, b) => b.count - a.count);
}
```

2. Call `getModelStats()` in `getSummary()` and add to returned object (modify line 144-157):

```typescript
return {
  totalRequests: this._lifetimeRequests,
  totalInputTokens: this._totalInputTokens,
  totalOutputTokens: this._totalOutputTokens,
  avgTokensPerSec: this.count > 0 ? Math.round((this._totalTokensPerSec / this.count) * 10) / 10 : 0,
  totalCacheReadTokens: this._totalCacheReadTokens,
  totalCacheCreationTokens: this._totalCacheCreationTokens,
  avgCacheHitRate: cacheHitRateCount > 0 ? Math.round((cacheHitRateSum / cacheHitRateCount) * 10) / 10 : 0,
  activeModels,
  providerDistribution,
  recentRequests: requests,
  uptimeSeconds: Math.floor((Date.now() - this.createdAt) / 1000),
  modelStats: this.getModelStats(),  // <-- NEW FIELD
};
```

**Commit:**
```bash
git add src/metrics.ts
git commit -m "feat(metrics): add getModelStats() method with per-model performance aggregates"
```

**Verification:**
```bash
# TypeScript compilation should pass
npm run build

# Optional: Run tests if available
npm test
```

---

## Task 3: GUI app.js — Update updateSummary() to display performance stats

**Files:**
- `gui/frontend/app.js`

**Steps:**
1. Modify `updateSummary()` function (line 133) — replace the "Active models" section (lines 144-192) with new performance-aware rendering:

Find this block:
```javascript
  // Active models
  const activeModels = data.activeModels || [];
  if (activeModels.length === 0) {
    modelsEl.textContent = '';
    modelsEl.appendChild(createEmptyEl('No requests yet'));
  } else {
    // ... existing model bar code ...
  }
```

Replace with:
```javascript
  // Active models with performance stats
  const modelStats = data.modelStats || [];
  if (modelStats.length === 0) {
    modelsEl.textContent = '';
    modelsEl.appendChild(createEmptyEl('No requests yet'));
  } else {
    const maxCount = Math.max(...modelStats.map(m => m.count));
    const maxLatency = Math.max(...modelStats.map(m => m.avgLatencyMs));
    modelsEl.textContent = '';

    for (const m of modelStats) {
      const cls = m.model.toLowerCase();
      let barClass = '';
      if (cls.includes('sonnet')) barClass = 'sonnet';
      else if (cls.includes('haiku')) barClass = 'haiku';
      else if (cls.includes('opus')) barClass = 'opus';

      const row = document.createElement('div');
      row.className = 'perf-row';
      row.setAttribute('data-model', m.model);

      // Model name
      const name = document.createElement('span');
      name.className = 'model-name';
      name.title = m.model;
      name.textContent = shortModel(m.model);

      // Count
      const count = document.createElement('span');
      count.className = 'model-count';
      count.textContent = m.count + ' reqs';

      // Latency bar
      const latencyBar = document.createElement('div');
      latencyBar.className = 'perf-bar';
      const latencyFill = document.createElement('div');
      latencyFill.className = 'perf-bar-fill ' + barClass;
      const latencyPct = maxLatency > 0 ? (m.avgLatencyMs / maxLatency * 100) : 0;
      latencyFill.style.width = latencyPct + '%';
      latencyBar.appendChild(latencyFill);

      // Latency value
      const latencyVal = document.createElement('span');
      latencyVal.className = 'perf-latency';
      const latencyClass = m.avgLatencyMs < 500 ? 'perf-fast' : m.avgLatencyMs < 1500 ? 'perf-medium' : 'perf-slow';
      latencyVal.classList.add(latencyClass);
      latencyVal.textContent = m.avgLatencyMs + 'ms';

      // Success rate
      const success = document.createElement('span');
      success.className = 'perf-success';
      const successClass = m.successRate >= 95 ? 'perf-good' : m.successRate >= 80 ? 'perf-warn' : 'perf-bad';
      success.classList.add(successClass);
      const successIcon = m.successRate >= 95 ? '✓' : m.successRate >= 80 ? '⚠' : '⚠';
      success.textContent = successIcon + ' ' + m.successRate + '%';

      // Tokens/sec
      const tokens = document.createElement('span');
      tokens.className = 'perf-tokens';
      tokens.textContent = m.avgTokensPerSec.toFixed(1) + ' t/s';

      // Cache hit rate
      const cache = document.createElement('span');
      cache.className = 'perf-cache';
      cache.textContent = m.avgCacheHitRate > 0 ? m.avgCacheHitRate.toFixed(0) + '%' : '—';

      row.appendChild(name);
      row.appendChild(count);
      row.appendChild(latencyBar);
      row.appendChild(latencyVal);
      row.appendChild(success);
      row.appendChild(tokens);
      row.appendChild(cache);
      modelsEl.appendChild(row);
    }
  }
```

**Note:** `appendRequestMetric()` (line 286) does NOT need changes — it still updates model bar counts incrementally. The new performance stats come from the summary push (debounced 1s).

**Commit:**
```bash
git add gui/frontend/app.js
git commit -m "feat(gui): add per-model performance indicators to active models section"
```

**Verification:**
```bash
# Rebuild GUI app bundle (Tauri)
cd gui && npx tauri build --bundles app

# Restart daemon
npx modelweaver stop
npx modelweaver start

# GUI should show performance columns for each model
```

---

## Task 4: GUI styles.css — Add CSS for performance indicators

**Files:**
- `gui/frontend/styles.css`

**Steps:**
1. Add new CSS rules after the existing `.model-count` rule (after line 412):

```css
/* Performance model rows */
.perf-row {
  display: grid;
  grid-template-columns: 100px 60px 60px 50px 50px 50px 30px;
  gap: 6px;
  align-items: center;
  padding: 4px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.perf-row:last-child {
  border-bottom: none;
}

/* Performance metrics */
.perf-latency {
  font-size: 11px;
  text-align: right;
}

.perf-latency.perf-fast { color: var(--green); }
.perf-latency.perf-medium { color: var(--yellow); }
.perf-latency.perf-slow { color: var(--accent); }

.perf-success {
  font-size: 11px;
  text-align: right;
}

.perf-success.perf-good { color: var(--green); }
.perf-success.perf-warn { color: var(--yellow); }
.perf-success.perf-bad { color: var(--accent); }

.perf-tokens {
  font-size: 11px;
  color: var(--text-dim);
  text-align: right;
}

.perf-cache {
  font-size: 11px;
  color: var(--text-dim);
  text-align: right;
}

/* Latency bar */
.perf-bar {
  height: 4px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 2px;
  overflow: hidden;
}

.perf-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.perf-bar-fill.sonnet { background: var(--green); }
.perf-bar-fill.haiku { background: var(--yellow); }
.perf-bar-fill.opus { background: var(--purple); }
```

**Commit:**
```bash
git add gui/frontend/styles.css
git commit -m "feat(styles): add CSS for performance indicator rows and metrics"
```

**Verification:**
```bash
# Rebuild GUI app bundle (required after CSS changes)
cd gui && npx tauri build --bundles app

# Restart daemon and GUI to see changes
npx modelweaver stop
npx modelweaver start
```

---

## Self-Review

### 1. Spec Coverage Check
- [x] `ModelPerformanceStats` interface includes all required fields (model, count, avgLatencyMs, p50LatencyMs, p95LatencyMs, successRate, avgTokensPerSec, avgCacheHitRate, errorCount, providerBreakdown)
- [x] `getModelStats()` computes percentiles correctly (sort array, index = 0.5 * length for p50, 0.95 * length for p95)
- [x] Success rate calculation: (status 200-299) / total * 100
- [x] Provider breakdown groups by `targetProvider ?? provider`
- [x] GUI displays: model name, count, latency bar + value, success rate with ✓/⚠, tokens/sec, cache hit rate
- [x] CSS includes color classes for latency (fast/medium/slow) and success rate (good/warn/bad)

### 2. Placeholder Scan
- [x] No TODO/FIXME comments added
- [x] No hardcoded values that should be configurable (latency thresholds 500ms/1500s are UI display logic only)
- [x] No console.log statements left in production code

### 3. Type Consistency Check
- [x] `ModelPerformanceStats` interface matches field names used in `getModelStats()`
- [x] `MetricsSummary.modelStats` field is typed as `ModelPerformanceStats[]`
- [x] GUI code accesses `data.modelStats` (matches new field name)
- [x] All latency values are rounded (`Math.round()`) for consistency
- [x] All rate values (tokens/sec, cache hit rate, success rate) use 1 decimal place (`* 10 / 10` pattern)

---

## Final Verification Commands

```bash
# 1. Rebuild daemon
npm run build

# 2. Rebuild GUI app bundle
cd gui && npx tauri build --bundles app

# 3. Restart daemon
npx modelweaver stop
npx modelweaver start

# 4. Test with sample requests (use curl or your LLM client)
# Check GUI for performance columns in Active Models section

# 5. Run tests (if available)
npm test
```

---

## Success Criteria

- [ ] Daemon compiles without TypeScript errors
- [ ] GUI app bundle builds successfully
- [ ] Active Models section shows new performance columns (count, latency bar, latency value, success rate, tokens/sec, cache hit rate)
- [ ] Latency values use color coding (green < 500ms, yellow < 1500ms, red >= 1500ms)
- [ ] Success rate shows ✓ for >= 95%, ⚠ for 80-95%, ⚠ (red) for < 80%
- [ ] Performance stats update on each summary push (1s debounce)
- [ ] Model count still updates incrementally via WebSocket `request` events
- [ ] No performance regression (aggregation is O(n) where n = buffer size)
