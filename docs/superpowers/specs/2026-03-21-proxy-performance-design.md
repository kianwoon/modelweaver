# Proxy Performance Enhancements

**Date:** 2026-03-21
**Status:** Approved
**Scope:** Transport-level optimizations to modelweaver proxy — no model selection or routing changes

## Problem

Under heavy load (large conversation contexts + concurrent multi-agent sessions), the proxy exhibits:
1. **Connection overhead** — no per-provider connection pooling; new TCP/TLS per request
2. **Wasted time on degraded providers** — sequential fallback waits for timeout on failing providers
3. **Cascading latency on rate limits** — sequential fallback means 429s add linear delay

## Constraints

- **No model interference** — the proxy must not change which model or provider the user gets
- **Fallback chain order is sacred** — user's `modelweaver.yaml` routing config is the source of truth
- **Backward compatible** — all changes are additive; existing config works without modification

## Phase 1: Connection Pool Tuning

### Approach

Create a shared `undici.Agent` per provider at config load time, pass to each `fetch()` call.

### Implementation

- In `config.ts`: after building `ProviderConfig`, create a `undici.Agent` per provider:
  - `keepAliveTimeout: 30000`
  - `keepAliveMaxTimeout: 60000`
  - `connections: 10` per provider (configurable)
- Store on `ProviderConfig._agent` (runtime-only field, like `_cachedBaseUrl`)
- In `proxy.ts`: pass `dispatcher: provider._agent` to `fetch()`

### Config Addition

```yaml
providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    apiKey: ${ANTHROPIC_API_KEY}
    poolSize: 10  # optional, default 10
```

### Files Changed

- `src/config.ts` — create Agent per provider at load time
- `src/proxy.ts` — pass dispatcher to fetch()
- `src/types.ts` — add `_agent` to ProviderConfig
- `tests/circuit-breaker.test.ts` — pool configuration tests

## Phase 2: Circuit Breaker

### Approach

Per-provider state machine: CLOSED → OPEN → HALF-OPEN. Tracks failures, skips degraded providers without reordering the fallback chain.

### State Machine

```
CLOSED ──(3 failures in 60s)──> OPEN ──(30s cooldown)──> HALF-OPEN ──(1 success)──> CLOSED
                                                        └──(1 failure)──> OPEN
```

### Implementation

- New file: `src/circuit-breaker.ts` — pure class, no I/O, fully unit-testable
- Interface:
  - `canProceed(): boolean` — called before each forwardRequest
  - `recordResult(status: number): void` — called after each forwardRequest
  - `getState(): "closed" | "open" | "half-open"`
- Per-provider instance at config load, stored on `ProviderConfig._circuitBreaker`
- `forwardWithFallback` calls `breaker.canProceed()` before each attempt:
  - CLOSED → proceed normally
  - OPEN → skip, try next in chain
  - HALF-OPEN → allow 1 probe request
- After attempt: `breaker.recordResult(status)`
  - 429/5xx → increment failure count
  - 2xx → reset

### API Endpoint

`GET /api/circuit-breaker` — returns per-provider status:
```json
{
  "anthropic": { "state": "closed", "failures": 0, "lastFailure": null },
  "bedrock": { "state": "open", "failures": 4, "lastFailure": "2026-03-21T10:30:00Z" }
}
```

### Key Constraint

The breaker never reorders the chain. It only skips a provider. If Anthropic is open and Bedrock is closed, the request goes straight to Bedrock — same provider the user configured, just faster.

### Files Changed

- `src/circuit-breaker.ts` — new file
- `src/config.ts` — create breaker per provider
- `src/proxy.ts` — integrate canProceed/recordResult into fallback loop
- `src/server.ts` — add `/api/circuit-breaker` endpoint
- `src/types.ts` — add `_circuitBreaker` to ProviderConfig
- `tests/circuit-breaker.test.ts` — comprehensive unit tests

## Phase 3: Adaptive Fallback (Sequential → Race on 429)

### Approach

Default sequential fallback (current behavior). When a provider returns 429, fire all remaining providers simultaneously — first successful response wins.

### Flow

```
Current:
  A → 429 → B → success

New:
  A → 429 → race(B, C, D...) → first 2xx wins, abort rest
  A → 500 → B → 429 → race(C, D...) → first 2xx wins, abort rest
```

### Implementation

Changes to `forwardWithFallback` in `proxy.ts`:

1. Loop through chain sequentially (same as now)
2. On 429 with remaining providers:
   - Create shared `AbortController`
   - `Promise.race()` all remaining `forwardRequest()` calls with shared signal
   - First 2xx → return it, abort the rest
   - All fail → return last error response
3. Non-429 retriable errors (5xx) → stay sequential
4. Non-retriable errors → fail immediately (unchanged)

### Why 429-Only Racing

- 429 = "rate limited, try elsewhere" — safe to parallelize
- 5xx = "server error" — could indicate shared infrastructure outage; racing makes it worse

### Body Safety

Each `forwardRequest` already does its own `structuredClone`, so parallel calls have independent body copies. No shared mutable state.

### Files Changed

- `src/proxy.ts` — modify `forwardWithFallback` to add race mode on 429
- `tests/proxy.test.ts` — add tests for race behavior on 429

## Implementation Order

1. **Phase 1** — connection pool (standalone, no dependencies, immediate perf gain)
2. **Phase 2** — circuit breaker (standalone module, depends on ProviderConfig)
3. **Phase 3** — adaptive fallback (modifies proxy.ts, benefits from circuit breaker context)

Each phase is independently shippable and testable.

## Testing Strategy

- **Unit tests** for circuit breaker state machine (all transitions, edge cases)
- **Integration tests** for adaptive fallback (mock providers, verify race cancellation)
- **Manual verification** — observe connection reuse via `ss -tn` or provider logs
- **Load test** — concurrent requests to verify pool behavior and circuit breaker thresholds

## Metrics Integration

All three phases feed into existing `MetricsStore`:
- Connection pool: track reuse count via provider metadata
- Circuit breaker: track skip events as skipped requests in metrics
- Adaptive fallback: track which fallback mode was used per request
