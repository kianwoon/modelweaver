# Model Performance Indicator

> **Date**: 2026-03-28
> **Status**: Approved
> **Scope**: Extend existing MetricsSummary with per-model performance stats

## Context

Users have no visibility into per-model performance (latency, success rate, throughput). When MiniMax degrades (90s timeouts, 1.9% error rate), users can't see this in the GUI and can't make data-driven decisions about adjusting routing weights. The data already exists in the `MetricsStore` ring buffer — it just needs aggregation and display.

## Design

### Backend: `src/metrics.ts`

Add `getModelStats()` method to `MetricsStore`. Scans ring buffer entries, groups by model name, computes per-model aggregates.

**New interface** (add to `src/types.ts`):

```typescript
interface ModelPerformanceStats {
  model: string;
  count: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  successRate: number;       // 0-100, % of requests with status 200-299
  avgTokensPerSec: number;
  avgCacheHitRate: number;   // 0-100, cacheRead / (cacheRead + cacheCreation + input)
  errorCount: number;
  providerBreakdown: {
    provider: string;
    count: number;
    avgLatencyMs: number;
    errorCount: number;
  }[];
}
```

**Changes to `MetricsSummary`** (in `src/types.ts`):

Add field: `modelStats: ModelPerformanceStats[]`

**`getModelStats()` implementation**:

- Iterate ring buffer entries (already in-memory, max 1000)
- Group by `model` field
- For each model: compute avg latency, percentile latencies, success rate, tokens/sec, cache hit rate
- Build provider breakdown from `provider` field within each model's entries
- Sort by count descending

**`getSummary()` change**: Call `getModelStats()` and include in returned object.

### API: `src/server.ts`

No new endpoint. `GET /api/metrics/summary` response now includes `modelStats` field. WebSocket `summary` push includes it too.

### GUI: `gui/frontend/app.js` + `styles.css`

**Active Models section enhancement**:

Replace current model list (name + count bar) with performance rows:

```
┌──────────────────────────────────────────────────────────────┐
│ Active Models                                                 │
├──────────────────────────────────────────────────────────────┤
│ glm-5-turbo   50 reqs  ▓▓▓░  466ms  100% ✓  982 t/s  45% cache │
│ glm-5        110 reqs  ▓▓▓░  555ms  100% ✓  950 t/s  38% cache │
│ glm-5.1      438 reqs  ▓▓▓░  1.8s   100% ✓  880 t/s  52% cache │
│ MiniMax-M2.7 581 reqs  ▓▓▓▓  3.8s    98% ⚠  720 t/s  30% cache │
└──────────────────────────────────────────────────────────────┘
```

Each row: model name | request count | latency bar (visual) | avg latency | success rate | tokens/sec | cache hit %

**Color coding**:
- Latency: green (<1s) → yellow (1-5s) → red (>5s)
- Success rate: green (100%) → yellow (95-99%) → red (<95%)
- Token throughput: green (high) → red (low) — relative to max in view

**Layout**: Compact single-line per model. Tooltip on hover shows p50/p95 latencies and provider breakdown.

### Files Modified

| File | Change |
|------|--------|
| `src/types.ts` | Add `ModelPerformanceStats` interface, add `modelStats` to `MetricsSummary` |
| `src/metrics.ts` | Add `getModelStats()` method, update `getSummary()` |
| `gui/frontend/app.js` | Update `updateSummary()` to render performance rows |
| `gui/frontend/styles.css` | Add performance indicator styles (color coding, bars) |

### Data Flow

Unchanged — piggybacks on existing WebSocket summary push:

```
request completes
  → recordRequest() updates ring buffer
  → getSummary() now includes modelStats
  → WebSocket push to GUI
  → updateSummary() renders performance rows
```

### Performance Considerations

- `getModelStats()` scans max 1000 ring buffer entries — sub-millisecond
- Called on every summary push (debounced to 1s in GUI)
- No additional memory — computes from existing data
- Provider breakdown is bounded by number of providers (typically 2-5)

### Verification

1. Start daemon, make requests to different models
2. `curl localhost:3456/api/metrics/summary` — verify `modelStats` array present with correct aggregates
3. Open GUI — verify active models section shows latency, success rate, tokens/sec
4. Verify color coding changes when a model degrades
5. Verify tooltip shows p50/p95 and provider breakdown on hover
