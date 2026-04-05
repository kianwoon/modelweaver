# Circuit Breaker Half-Open Stuck — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two root causes that permanently lock circuit breakers in `half-open` ("Resuming") state: (1) probe timeouts don't clear probe flags, and (2) health-based routing deprioritizes unhealthy providers so no probe traffic reaches them.

**Architecture:**
- **Fix 1 (probe deadlock):** Add `recordProbeTimeout(probeId)` to circuit-breaker.ts that clears probe flags and transitions to open state. In proxy.ts, call it for probe requests that timeout/conn-error — so the next request can retry.
- **Fix 2 (passive-only probing):** Add an active health-probe manager (server.ts) that periodically fires lightweight HTTP HEAD requests at `half-open` providers via a 15-second interval, independent of router chain ordering.

**Tech Stack:** TypeScript (src/), Node.js built-in http/https for lightweight probes, Vitest for tests.

---

## File Map

| File | Role |
|------|------|
| `src/circuit-breaker.ts` | Add `recordProbeTimeout()`, clear probe flags on timeout |
| `src/proxy.ts` | Track probeId per request; call `recordProbeTimeout()` on timeout/conn-err |
| `src/server.ts` | Register/unregister half-open providers; `setInterval` active probe loop |
| `tests/circuit-breaker.test.ts` | Add tests for probe timeout → open transition |
| `tests/proxy.test.ts` | (optional) integration test for probe timeout path |

---

## Task 1: Add `recordProbeTimeout(probeId)` to CircuitBreaker

**Files:**
- Modify: `src/circuit-breaker.ts:88-91` (replace `recordTimeout` body), add new method after it

- [ ] **Step 1: Add failing test for `recordProbeTimeout`**

In `tests/circuit-breaker.test.ts`, add:

```typescript
it('recordProbeTimeout clears probe flags and transitions to open', () => {
  const cb = new CircuitBreaker();
  // Force half-open via private manipulation (use any cast — test file)
  (cb as any).state = 'half-open';
  (cb as any).halfOpenInProgress = true;
  (cb as any).halfOpenProbeId = 99;
  (cb as any)._probeGranted = true;

  cb.recordProbeTimeout(99);

  const s = cb.getStatus();
  assert.equal(s.state, 'open');
});
```

Run: `npx vitest run tests/circuit-breaker.test.ts -t "recordProbeTimeout"`
Expected: FAIL — `recordProbeTimeout` not defined

- [ ] **Step 2: Add the method to `circuit-breaker.ts`**

Replace the no-op `recordTimeout()` with two methods:

```typescript
/**
 * Record a timeout on a probe request in half-open state.
 * Clears probe flags and transitions back to open (counts as a flap)
 * so the next request after cooldown can probe again.
 *
 * For non-probe timeouts (regular requests in closed state), timeouts
 * are still a no-op — they don't count toward the failure threshold.
 */
recordProbeTimeout(probeId: number): void {
  // Only act if this probe is the one in flight
  if (!this.halfOpenInProgress || probeId !== this.halfOpenProbeId) return;

  // Timeout of a half-open probe = treat as a flap, go back to open
  // and let the next cooldown-elapsed request trigger a fresh probe.
  this.halfOpenInProgress = false;
  this.halfOpenProbeId = null;
  this._probeGranted = false;
  this.state = 'open';
  this.openedAt = Date.now();
  this._cooldownMs = this.escalateCooldown(false /* not a rate-limit */);
  this._flapCount++;
  console.warn(`[circuit-breaker] HALF-OPEN PROBE TIMED OUT — back to OPEN (flap=${this._flapCount}, cooldown=${this._cooldownMs}ms)`);
}

/**
 * Record a timeout without tripping the circuit breaker.
 * Timeouts are often caused by stale connections or transient load —
 * retrying with a fresh connection usually succeeds. Only actual server
 * errors (5xx, 429) should count toward the failure threshold.
 * NOTE: For probe timeouts, use recordProbeTimeout() instead — that
 * clears probe flags so a new probe can be attempted.
 */
recordTimeout(): void {
  // No-op for non-probe requests: timeouts don't count as circuit breaker failures.
  // This prevents cascading breaker trips during upstream degradation.
}
```

Run test again: `npx vitest run tests/circuit-breaker.test.ts -t "recordProbeTimeout"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/circuit-breaker.ts tests/circuit-breaker.test.ts
git commit -m "fix(circuit-breaker): add recordProbeTimeout to clear probe flags on probe timeout"
```

---

## Task 2: Call `recordProbeTimeout` from Proxy on probe timeout/conn-err

**Files:**
- Modify: `src/proxy.ts` — replace 3 `recordTimeout()` calls with `recordProbeTimeout(probeId)` for probe requests

- [ ] **Step 1: Understand the call sites in proxy.ts**

The 3 `recordTimeout()` call sites:
- Line ~761: In `hedgedForwardRequest` — inside a streaming stall/TTFB timeout path
- Line ~1359: After `response.status === 0` (connection error)
- Line ~1432: After a connection error in streaming

All 3 happen after `hedgedForwardRequest` is called. We need to pass the probeId from `canProceed()` through the call chain to these handlers.

**Find the exact context** — read the lines around each call site in proxy.ts to understand how probeId flows (or doesn't):

```
grep -n 'recordTimeout\|canProceed\|probeId\|probeGranted\|hedgedForwardRequest' src/proxy.ts
```

From the indexed search, we know:
- Line 1237: `canProceed()` in single-provider path
- Line 1274: `canProceed()` in multi-provider sequential path
- Line 761: `recordTimeout()` after stall/TTFB timeout in hedgedForwardRequest
- Line 1359: `recordTimeout()` after connection error (status === 0)
- Line 1432: `recordTimeout()` after connection error in streaming

The probeId from `canProceed()` needs to be threaded through `hedgedForwardRequest` and its inner callbacks (onStall, onTTFBTimeout) and the connection-error handlers.

- [ ] **Step 2: Read proxy.ts around key call sites**

Run:
```
sed -n '740,770p' src/proxy.ts
sed -n '1350,1370p' src/proxy.ts
sed -n '1420,1445p' src/proxy.ts
```

- [ ] **Step 3: Thread probeId through `hedgedForwardRequest` signature and internal handlers**

`hedgedForwardRequest` is called with `cbProbeId` (line ~1297). The probeId is available in scope. We need to:
1. Pass `probeId: number | undefined` as a parameter to `hedgedForwardRequest`
2. Store it on the abort controller or ctx so timeout/err handlers can read it
3. Replace `recordTimeout()` calls with `recordProbeTimeout(probeId)` when probeId > 0

The cleanest approach: add `cbProbeId?: number` to the `HedgeCtx` type or pass it as a parameter that flows through the function.

Actually, the simplest approach: instead of threading probeId through all callbacks, add a new optional parameter `probeId?: number` to `recordTimeout()` overload — but TypeScript doesn't support overloads well here.

Better approach: Add a new method `recordProbeTimeout` on CircuitBreaker and call it directly from the proxy at the three call sites where we have `cbProbeId` in scope.

- [ ] **Step 4: Implement — replace 3 `recordTimeout()` calls in proxy.ts**

**Call site 1 (line ~761 — stall/TTFB timeout):** This is inside `hedgedForwardRequest`. The `cbProbeId` is not directly available at that inner scope. We need to pass it through.

The flow is:
```
hedgedForwardRequest(provider, entry, ctx, req, abortCtrl, attemptIdx, logger, hedge)
  → calls forwardToProvider() or raceProviders()
  → inside: TTFB timeout handler calls recordTimeout()
  → inside: stall handler calls recordTimeout()
```

The probeId is obtained by the **caller** of `hedgedForwardRequest`, not inside it. So the timeout callbacks inside `hedgedForwardRequest` don't have access to probeId unless we thread it.

**Simplest fix:** Add `probeId?: number` as a parameter to `hedgedForwardRequest`. Pass `undefined` from non-distribution callers. Pass `cbProbeId` from the distribution callers.

**Call site 2 (line ~1359 — connection error):** `cbProbeId` is available at line ~1273.

**Call site 3 (line ~1432 — streaming connection error):** `cbProbeId` is available at the same scope.

So the implementation is:
1. Add `probeId?: number` parameter to `hedgedForwardRequest`
2. At all 3 `recordTimeout()` calls: if `probeId !== undefined`, call `recordProbeTimeout(probeId)` instead
3. Pass `cbProbeId` from distribution callers

Specific edits (approximate — exact lines from reading in Step 2):

**For the stall/TTFB timeout inside hedgedForwardRequest (line ~761):**
```typescript
// Before: recordTimeout()
// After: if (probeId !== undefined) { provider._circuitBreaker?.recordProbeTimeout(probeId); } else { provider._circuitBreaker?.recordTimeout(); }
```

**For connection error at line ~1359:**
```typescript
// Before: if (provider._circuitBreaker) provider._circuitBreaker.recordTimeout();
// After: if (provider._circuitBreaker) { if (cbProbeId !== undefined) provider._circuitBreaker.recordProbeTimeout(cbProbeId); else provider._circuitBreaker.recordTimeout(); }
```

**For connection error at line ~1432:**
```typescript
// Same pattern
```

Run tests: `npx vitest run tests/proxy.test.ts`
Expected: PASS (or skip if no proxy tests yet)

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts
git commit -m "fix(proxy): call recordProbeTimeout on probe timeout/conn-error instead of recordTimeout"
```

---

## Task 3: Add Active Health Probe Manager to Server

**Files:**
- Modify: `src/server.ts` — add active probe interval
- Create: `src/health-probe.ts` (optional — or inline in server.ts)

- [ ] **Step 1: Design the active probe manager**

The manager needs to:
1. Know about all providers and their circuit breakers
2. Periodically (every 15s) collect providers in `half-open` state
3. For each half-open provider, fire a lightweight HTTP HEAD request to the provider's base URL
4. Call `recordResult(status, probeId)` on success, `recordProbeTimeout(probeId)` on timeout/err
5. Provide `registerProvider(name, cb)` and `unregisterProvider(name)` API

Registration happens when a circuit breaker transitions to `half-open`. We can hook this in server.ts when building the status.

Actually, simpler: instead of a registry, the probe manager just calls `getStatus()` on all registered circuit breakers each interval and probes those in `half-open` state.

Implementation options:
- **A)** Inline in server.ts: `setInterval` at the module level, closure over `config.providers`
- **B)** Separate class `ActiveProbeManager` in a new file `src/health-probe.ts`

Option A is simpler for a small addition. Option B is cleaner for testability. Given this is a reliability fix, Option B with a simple class is worth it.

- [ ] **Step 2: Write failing test for ActiveProbeManager**

Create `tests/health-probe.test.ts`:

```typescript
import { describe, it, assert, vi, beforeEach } from 'vitest';
import { ActiveProbeManager } from '../src/health-probe.js';

describe('ActiveProbeManager', () => {
  it('probes half-open providers on each interval', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    const cb1 = { getState: () => 'half-open', canProceed: () => ({ allowed: true, probeId: 1 }), recordProbeTimeout: vi.fn(), recordResult: vi.fn() };
    const cb2 = { getState: () => 'closed', canProceed: () => ({ allowed: true, probeId: 0 }), recordProbeTimeout: vi.fn(), recordResult: vi.fn() };
    const providers = new Map([['glm', { name: 'glm', baseUrl: 'https://glm.example.com', _circuitBreaker: cb1 }], ['other', { name: 'other', baseUrl: 'https://other.example.com', _circuitBreaker: cb2 }]]);

    const mgr = new ActiveProbeManager(providers, mockFetch as any);
    mgr.start(15000); // 15s interval, but we tick manually
    // Advance to first interval
    vi.advanceTimersByTime(15000);
    // Wait for async fetch
    await Promise.resolve();

    assert.equal(mockFetch.mock.calls.length, 1);
    assert.include(mockFetch.mock.calls[0][0], 'glm');
    assert.equal(cb1.recordResult.mock.calls.length, 1);
    assert.equal(cb1.recordProbeTimeout.mock.calls.length, 0);

    mgr.stop();
  });
});
```

Run: `npx vitest run tests/health-probe.test.ts`
Expected: FAIL — file doesn't exist / `ActiveProbeManager` not found

- [ ] **Step 3: Implement `ActiveProbeManager`**

Create `src/health-probe.ts`:

```typescript
import type { CircuitBreaker } from './circuit-breaker.js';

const PROBE_INTERVAL_MS = 15_000; // 15 seconds
const PROBE_TIMEOUT_MS = 5_000;   // 5 second timeout per probe

export class ActiveProbeManager {
  private providers: Map<string, { baseUrl: string; _circuitBreaker?: CircuitBreaker }>;
  private fetchFn: typeof fetch;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    providers: Map<string, { baseUrl: string; _circuitBreaker?: CircuitBreaker }>,
    fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.providers = providers;
    this.fetchFn = fetchFn;
  }

  start(intervalMs: number = PROBE_INTERVAL_MS): void {
    if (this.intervalId !== null) return; // already running
    this.intervalId = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Run one probe cycle (useful for testing) */
  async tick(): Promise<void> {
    const halfOpen: Array<{ name: string; baseUrl: string; cb: CircuitBreaker }> = [];

    for (const [name, provider] of this.providers) {
      const cb = provider._circuitBreaker;
      if (!cb) continue;
      if (cb.getState() === 'half-open') {
        halfOpen.push({ name, baseUrl: provider.baseUrl, cb });
      }
    }

    // Probe all half-open providers in parallel
    await Promise.all(halfOpen.map(p => this.probeProvider(p)));
  }

  private async probeProvider(entry: { name: string; baseUrl: string; cb: CircuitBreaker }): Promise<void> {
    // Grant a probe ID for this active health check
    const { allowed, probeId } = entry.cb.canProceed();
    if (!allowed) return; // another probe already in flight

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

      let status = 0;
      try {
        // Lightweight HEAD request — GLM/most providers accept it
        const res = await this.fetchFn(entry.baseUrl, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'follow',
        });
        status = res.status;
      } catch (err: any) {
        if (err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
          entry.cb.recordProbeTimeout(probeId);
          console.warn(`[health-probe] half-open probe timed out for ${entry.name}`);
          return;
        }
        // Other error — ignore, let the next interval try again
        return;
      } finally {
        clearTimeout(timeout);
      }

      entry.cb.recordResult(status, probeId);
      console.warn(`[health-probe] half-open probe result for ${entry.name}: ${status}`);
    } catch {
      // Non-fetch errors — ignore
    }
  }
}
```

Run tests: `npx vitest run tests/health-probe.test.ts`
Expected: PASS

- [ ] **Step 4: Wire up `ActiveProbeManager` in `server.ts`**

In `src/server.ts`, after the app is initialized and `config.providers` is available, instantiate and start the manager:

Find the right location — after `buildProviderHealth` / after the health broadcast interval is set up (around line 786).

Add:
```typescript
import { ActiveProbeManager } from './health-probe.js';

// ... after health broadcast setup ...
const activeProbeManager = new ActiveProbeManager(config.providers);
activeProbeManager.start();
```

Run: `npx vitest run tests/health-probe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/health-probe.ts src/server.ts tests/health-probe.test.ts
git commit -m "fix(server): add active health probe manager to unstick half-open circuit breakers"
```

---

## Task 4: Full Integration Test + Rebuild

- [ ] **Step 1: Run all tests**

```bash
npx vitest run
```

Expected: all pass

- [ ] **Step 2: Build daemon**

```bash
npm run build
```

Expected: TypeScript compiles, tsup bundles to dist/

- [ ] **Step 3: Reload daemon**

```bash
npx modelweaver reload
```

Expected: daemon reloads successfully (no API Error 400)

- [ ] **Step 4: Run the full test suite**

```bash
npx vitest run
```

---

## Self-Review Checklist

- [ ] `recordProbeTimeout` clears `halfOpenInProgress`, `_probeGranted`, transitions to `open`
- [ ] `recordTimeout()` is still a no-op for non-probe requests
- [ ] Proxy calls `recordProbeTimeout(probeId)` only when `probeId !== undefined`
- [ ] `ActiveProbeManager.tick()` calls `canProceed()` to get probe ID before probing
- [ ] `ActiveProbeManager` handles probe timeout with `recordProbeTimeout`
- [ ] `ActiveProbeManager` handles probe success with `recordResult(status, probeId)`
- [ ] `ActiveProbeManager` handles probe failure (5xx/429) with `recordResult`
- [ ] Manager is started in `server.ts` and runs every 15s
- [ ] No TypeScript errors after build
- [ ] All vitest tests pass
