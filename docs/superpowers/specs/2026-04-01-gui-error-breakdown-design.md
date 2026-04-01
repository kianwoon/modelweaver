# Fix: GUI Provider Error Breakdown Not Displaying

**Issue:** kianwoon/modelweaver#114
**Date:** 2026-04-01
**Scope:** Status-code-only fix (no semantic error categorization)

## Problem

Provider cards should show error type counters (e.g. "26x 429 . 16x 502") but the data never reaches the GUI after the initial WebSocket connection.

**Root cause:** `buildProviderHealth()` (ws.ts:118) flattens the per-status-code error map into a single `errorCount` scalar. The GUI falls back to stale `cachedFullSummary.providerErrors` which is frozen at initial WS snapshot and never updated.

## Design

### Approach: Send `errorBreakdown` in `provider_health` messages

The `provider_health` WS broadcast already runs — we just need to include the per-status breakdown that already exists in `MetricsStore._providerErrors`.

### Changes

#### 1. `src/types.ts` — Add `errorBreakdown` field to `ProviderHealthEntry`

```typescript
export interface ProviderHealthEntry {
  state: string;
  failures: number;
  lastFailure: number | null;
  lastErrorCode: number | null;
  lastErrorTime: number | null;
  errorCount: number;
  errorBreakdown?: {
    total: number;
    errors: { [status: number]: number };
    lastErrorCode: number | null;
    lastErrorTime: number | null;
  };
}
```

#### 2. `src/ws.ts` — Populate `errorBreakdown` in `buildProviderHealth()`

In the loop over providers, set `errorBreakdown: errEntry ?? null` where `errEntry` comes from `errors[name]` (already fetched from `metricsStore.getProviderErrors()`).

#### 3. `gui/frontend/app.js` — Read `errorBreakdown` from WS data

In `handleProviderHealth()`, use `entry.errorBreakdown` (from the `provider_health` message) instead of `providerErrors[name]` (from the stale `cachedFullSummary`).

#### 4. No changes needed

- `MetricsSummaryDelta` — not touched
- `metrics.ts` — data already tracked correctly
- `proxy.ts` — error recording unchanged

### Data Flow After Fix

```
MetricsStore._providerErrors
  -> buildProviderHealth() reads getProviderErrors() [already does]
  -> NOW: includes errorBreakdown in each ProviderHealthEntry [NEW]
  -> broadcastProviderHealth() sends via WS [already does]
  -> GUI handleProviderHealth() reads from WS data [CHANGED]
  -> renderProviders() renders error chips [already does]
```
