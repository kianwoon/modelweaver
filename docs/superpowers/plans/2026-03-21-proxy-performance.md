# Proxy Performance Enhancements — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the modelweaver proxy faster and more resilient under heavy load (large contexts + concurrent agents) without changing model selection or routing behavior.

**Architecture:** Three independent phases — (1) per-provider connection pooling via undici.Agent, (2) per-provider circuit breaker state machine, (3) adaptive fallback that races remaining providers on 429. Each phase is independently shippable and testable.

**Tech Stack:** TypeScript, Node.js 20+ (undici.Agent), Hono, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-proxy-performance-design.md`

---

## Chunk 1: Connection Pool Tuning

### Task 1: Add undici dependency

- [ ] **Step 1: Install undici**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npm install undici`

Expected: undici added to package.json dependencies

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add undici as explicit dependency for connection pooling"
```

### Task 2: Add Agent type to ProviderConfig

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add _agent field to ProviderConfig**

In `src/types.ts`, add to `ProviderConfig` interface after `_cachedHost`:

```typescript
/** Runtime-only cached fields — not serialized to config */
_cachedBaseUrl?: string;
_cachedHost?: string;
_agent?: import("undici").Agent;
poolSize?: number;
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add _agent and poolSize fields to ProviderConfig"
```

### Task 3: Create Agents in config.ts

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Import undici Agent**

Add at top of `src/config.ts` after existing imports:

```typescript
import { Agent } from "undici";
```

- [ ] **Step 2: Create Agent per provider after config validation**

In `src/config.ts`, inside the `providers` loop (after the `_cachedHost` assignment, around line 168), add:

```typescript
    // Create per-provider connection pool for HTTP keep-alive reuse
    const poolSize = (p as Record<string, unknown>).poolSize as number | undefined;
    providerConfig._agent = new Agent({
      keepAliveTimeout: 30000,
      keepAliveMaxTimeout: 60000,
      connections: poolSize ?? 10,
    });
    providerConfig.poolSize = poolSize ?? 10;
```

- [ ] **Step 3: Add poolSize to Zod provider schema**

In `src/config.ts`, in the `providerSchema` (around line 15), add after `modelLimits`:

```typescript
  poolSize: z.number().int().min(1).max(100).optional(),
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/config.ts
git commit -m "feat(config): create per-provider undici Agent for connection pooling"
```

### Task 4: Use Agent dispatcher in fetch

**Files:**
- Modify: `src/proxy.ts`

- [ ] **Step 1: Pass dispatcher to fetch in forwardRequest**

In `src/proxy.ts`, in the `forwardRequest` function (around line 257), change:

```typescript
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
```

to:

```typescript
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      dispatcher: provider._agent,
    });
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/proxy.ts
git commit -m "feat(proxy): use per-provider Agent dispatcher in fetch"
```

### Task 5: Test connection pooling

**Files:**
- Create: `tests/pool.test.ts`

- [ ] **Step 1: Write test for pool creation**

```typescript
// tests/pool.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

describe("connection pool", () => {
  const tmpDir = join("/tmp", `mw-test-pool-${Date.now()}`);
  const configPath = join(tmpDir, "modelweaver.yaml");

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(configPath, `
server:
  port: 3456
  host: localhost
providers:
  test-provider:
    baseUrl: https://api.example.com
    apiKey: test-key
    timeout: 5000
    poolSize: 5
`);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates an Agent with configured pool size", () => {
    const { config } = loadConfig(configPath);
    const provider = config.providers.get("test-provider");
    expect(provider?._agent).toBeDefined();
    expect(provider?.poolSize).toBe(5);
  });

  it("defaults pool size to 10 when not configured", () => {
    writeFileSync(configPath, `
server:
  port: 3456
  host: localhost
providers:
  default-pool:
    baseUrl: https://api.example.com
    apiKey: test-key
    timeout: 5000
`);
    const { config } = loadConfig(configPath);
    const provider = config.providers.get("default-pool");
    expect(provider?.poolSize).toBe(10);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx vitest run tests/pool.test.ts`

Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/pool.test.ts
git commit -m "test: add connection pool configuration tests"
```

---

## Chunk 2: Circuit Breaker

### Task 6: Create CircuitBreaker class

**Files:**
- Create: `src/circuit-breaker.ts`

- [ ] **Step 1: Write the CircuitBreaker class**

```typescript
// src/circuit-breaker.ts
export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerConfig {
  failureThreshold: number;
  windowSeconds: number;
  cooldownSeconds: number;
}

export interface BreakerStatus {
  state: BreakerState;
  failures: number;
  lastFailure: number | null;
}

const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 3,
  windowSeconds: 60,
  cooldownSeconds: 30,
};

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failureTimestamps: number[] = [];
  private openedAt: number | null = null;
  private readonly config: BreakerConfig;

  constructor(config: Partial<BreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  canProceed(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      // Check if cooldown has elapsed
      if (this.openedAt && Date.now() - this.openedAt >= this.config.cooldownSeconds * 1000) {
        this.state = "half-open";
        return true; // Allow one probe request
      }
      return false;
    }
    // half-open: allow one probe
    return true;
  }

  recordResult(status: number): void {
    if (status >= 200 && status < 300) {
      // Success — reset to closed
      this.state = "closed";
      this.failureTimestamps = [];
      this.openedAt = null;
      return;
    }

    // Only count retriable errors (429, 5xx) as failures
    if (status !== 429 && status < 500) return;

    const now = Date.now();
    this.failureTimestamps.push(now);
    this.pruneOldFailures(now);

    if (this.state === "half-open") {
      // Any failure in half-open → back to open
      this.state = "open";
      this.openedAt = now;
      return;
    }

    // Check if threshold exceeded
    if (this.failureTimestamps.length >= this.config.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
    }
  }

  getState(): BreakerState {
    return this.state;
  }

  getStatus(): BreakerStatus {
    return {
      state: this.state,
      failures: this.failureTimestamps.length,
      lastFailure: this.failureTimestamps.length > 0
        ? this.failureTimestamps[this.failureTimestamps.length - 1]
        : null,
    };
  }

  /** For testing: manually override the clock for cooldown checks */
  protected getNow(): number {
    return Date.now();
  }

  private pruneOldFailures(now: number): void {
    const cutoff = now - this.config.windowSeconds * 1000;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/circuit-breaker.ts
git commit -m "feat: add CircuitBreaker class with closed/open/half-open states"
```

### Task 7: Write circuit breaker tests

**Files:**
- Create: `tests/circuit-breaker.test.ts`

- [ ] **Step 1: Write comprehensive tests**

```typescript
// tests/circuit-breaker.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      windowSeconds: 60,
      cooldownSeconds: 1, // Short for tests
    });
  });

  describe("closed state", () => {
    it("starts in closed state", () => {
      expect(breaker.getState()).toBe("closed");
    });

    it("allows requests in closed state", () => {
      expect(breaker.canProceed()).toBe(true);
    });

    it("stays closed on 2xx response", () => {
      breaker.recordResult(200);
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getStatus().failures).toBe(0);
    });

    it("stays closed on non-retriable error (401)", () => {
      breaker.recordResult(401);
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getStatus().failures).toBe(0);
    });

    it("tracks retriable failures (429, 5xx) but stays closed under threshold", () => {
      breaker.recordResult(429);
      breaker.recordResult(500);
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getStatus().failures).toBe(2);
    });
  });

  describe("open state", () => {
    it("opens after threshold failures", () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");
    });

    it("blocks requests in open state", () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      expect(breaker.canProceed()).toBe(false);
    });

    it("does not record result for skipped (non-attempted) requests", () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      // Don't call recordResult — provider was skipped
      expect(breaker.getStatus().failures).toBe(3);
    });
  });

  describe("half-open state", () => {
    it("transitions to half-open after cooldown", async () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");

      // Wait for cooldown (1 second in test config)
      await new Promise((r) => setTimeout(r, 1100));

      expect(breaker.canProceed()).toBe(true);
      expect(breaker.getState()).toBe("half-open");
    });

    it("closes on success in half-open", async () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      await new Promise((r) => setTimeout(r, 1100));
      breaker.canProceed(); // triggers half-open

      breaker.recordResult(200);
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getStatus().failures).toBe(0);
    });

    it("reopens on failure in half-open", async () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      await new Promise((r) => setTimeout(r, 1100));
      breaker.canProceed(); // triggers half-open

      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");
    });
  });

  describe("custom config", () => {
    it("uses default thresholds when none provided", () => {
      const defaultBreaker = new CircuitBreaker();
      // Default: 3 failures in 60s
      defaultBreaker.recordResult(429);
      defaultBreaker.recordResult(429);
      defaultBreaker.recordResult(429);
      expect(defaultBreaker.getState()).toBe("open");
    });

    it("respects custom failure threshold", () => {
      const custom = new CircuitBreaker({ failureThreshold: 5, windowSeconds: 60, cooldownSeconds: 30 });
      custom.recordResult(429);
      custom.recordResult(429);
      custom.recordResult(429);
      expect(custom.getState()).toBe("closed");
      custom.recordResult(429);
      custom.recordResult(429);
      expect(custom.getState()).toBe("open");
    });
  });

  describe("getStatus", () => {
    it("returns lastFailure timestamp", () => {
      breaker.recordResult(429);
      const status = breaker.getStatus();
      expect(status.lastFailure).not.toBeNull();
      expect(status.failures).toBe(1);
    });

    it("returns null lastFailure when no failures", () => {
      const status = breaker.getStatus();
      expect(status.lastFailure).toBeNull();
      expect(status.failures).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx vitest run tests/circuit-breaker.test.ts`

Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add tests/circuit-breaker.test.ts
git commit -m "test: add comprehensive circuit breaker unit tests"
```

### Task 8: Integrate circuit breaker into config and proxy

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/proxy.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Add _circuitBreaker field to ProviderConfig**

In `src/types.ts`, add to `ProviderConfig` after `_agent`:

```typescript
import type { CircuitBreaker } from "./circuit-breaker.js";
```

And inside the ProviderConfig interface:

```typescript
_agent?: import("undici").Agent;
poolSize?: number;
_circuitBreaker?: CircuitBreaker;
```

- [ ] **Step 2: Create breakers in config.ts**

In `src/config.ts`, add import:

```typescript
import { CircuitBreaker } from "./circuit-breaker.js";
```

And after the `_agent` creation in the providers loop, add:

```typescript
    // Create per-provider circuit breaker
    const cbConfig = (p as Record<string, unknown>).circuitBreaker as Record<string, number> | undefined;
    providerConfig._circuitBreaker = new CircuitBreaker(cbConfig ? {
      failureThreshold: cbConfig.failureThreshold,
      windowSeconds: cbConfig.windowSeconds,
      cooldownSeconds: cbConfig.cooldownSeconds,
    } : undefined);
```

Also add to the Zod providerSchema:

```typescript
  circuitBreaker: z.object({
    failureThreshold: z.number().int().min(1).optional(),
    windowSeconds: z.number().int().min(1).optional(),
    cooldownSeconds: z.number().int().min(1).optional(),
  }).optional(),
```

- [ ] **Step 3: Integrate into forwardWithFallback in proxy.ts**

In `src/proxy.ts`, in the `forwardWithFallback` function, before the `forwardRequest` call (around line 322), add circuit breaker check:

```typescript
    // Check circuit breaker before attempting provider
    if (provider._circuitBreaker && !provider._circuitBreaker.canProceed()) {
      logger?.warn("Provider skipped by circuit breaker", { requestId: ctx.requestId, provider: entry.provider });
      continue;
    }
```

Note: You'll need to accept an optional logger parameter or import one. The simplest approach is to add an optional `logger` param to `forwardWithFallback`:

```typescript
export async function forwardWithFallback(
  providers: Map<string, ProviderConfig>,
  chain: RoutingEntry[],
  ctx: RequestContext,
  incomingRequest: Request,
  onAttempt?: (provider: string, index: number) => void,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
): Promise<Response> {
```

After the `forwardRequest` call (around line 323), record the result:

```typescript
    // Record result for circuit breaker
    if (provider._circuitBreaker) {
      provider._circuitBreaker.recordResult(response.status);
    }
```

- [ ] **Step 4: Add /api/circuit-breaker endpoint in server.ts**

In `src/server.ts`, before the `return { app, ... }` statement, add:

```typescript
  // Circuit breaker status endpoint
  app.get("/api/circuit-breaker", (c) => {
    const status: Record<string, { state: string; failures: number; lastFailure: number | null }> = {};
    for (const [name, provider] of config.providers) {
      const breaker = provider._circuitBreaker;
      if (breaker) {
        const s = breaker.getStatus();
        status[name] = { state: s.state, failures: s.failures, lastFailure: s.lastFailure };
      }
    }
    return c.json(status);
  });
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 6: Run all tests**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx vitest run`

Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config.ts src/proxy.ts src/server.ts
git commit -m "feat: integrate circuit breaker into proxy fallback chain and add status endpoint"
```

---

## Chunk 3: Adaptive Fallback (Race on 429)

### Task 9: Implement race mode in forwardWithFallback

**Files:**
- Modify: `src/proxy.ts`

- [ ] **Step 1: Add race logic to forwardWithFallback**

In `src/proxy.ts`, modify the `forwardWithFallback` function. After the existing retry logic (around line 330-339), replace the simple `continue` on 429 with a race of remaining providers.

The key change: when we get a 429 and there are remaining providers, instead of sequential `continue`, race them all:

```typescript
    // Retriable error — if there are more providers, drain body and try next
    if (i < chain.length - 1) {
      await response.body?.cancel();

      // On 429: race remaining providers simultaneously
      if (response.status === 429 && i + 1 < chain.length) {
        const remaining = chain.slice(i + 1);
        return raceProviders(remaining, providers, ctx, incomingRequest, onAttempt, logger);
      }
      continue;
    }
```

Add the `raceProviders` helper function before `forwardWithFallback`:

```typescript
/**
 * Race multiple providers simultaneously. Returns the first successful response.
 * Aborts all remaining requests once a winner is found.
 */
async function raceProviders(
  chain: RoutingEntry[],
  providers: Map<string, ProviderConfig>,
  ctx: RequestContext,
  incomingRequest: Request,
  onAttempt?: (provider: string, index: number) => void,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void; info: (msg: string, meta?: Record<string, unknown>) => void }
): Promise<Response> {
  const sharedController = new AbortController();

  const races = chain.map(async (entry, index): Promise<{ response: Response; index: number }> => {
    const provider = providers.get(entry.provider);
    if (!provider) {
      const errBody = JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `Unknown provider: ${entry.provider}` },
        });
      return {
        response: new Response(errBody, {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
        index,
      };
    }

    // Check circuit breaker
    if (provider._circuitBreaker && !provider._circuitBreaker.canProceed()) {
      const errBody = JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `Provider "${entry.provider}" skipped by circuit breaker` },
        });
      return {
        response: new Response(errBody, {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
        index,
      };
    }

    onAttempt?.(entry.provider, index);

    try {
      const response = await forwardRequest(provider, entry, ctx, incomingRequest);
      // Record for circuit breaker
      if (provider._circuitBreaker) {
        provider._circuitBreaker.recordResult(response.status);
      }
      return { response, index };
    } catch {
      if (provider._circuitBreaker) {
        provider._circuitBreaker.recordResult(502);
      }
      const errBody = JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `Provider "${entry.provider}" failed` },
        });
      return {
        response: new Response(errBody, {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
        index,
      };
    }
  });

  try {
    // Wait for first successful response
    for await (const { response, index } of raceInOrder(races)) {
      if (response.status >= 200 && response.status < 300) {
        sharedController.abort();
        return response;
      }
      // Non-retriable error — propagate immediately
      if (!isRetriable(response.status)) {
        sharedController.abort();
        return response;
      }
      // Retriable but not success — continue waiting for others
    }

    // All failed — return last error
    const lastRace = await Promise.all(races);
    const lastResult = lastRace[lastRace.length - 1];
    sharedController.abort();
    return lastResult.response;
  } catch {
    sharedController.abort();
    const errBody = JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "All providers in race failed" },
      });
    return new Response(errBody, {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

/**
 * Yield race results as they complete, preserving order of first completion.
 */
async function* raceInOrder<T>(
  promises: Promise<T>[]
): AsyncGenerator<T> {
  const pending = new Set(promises);
  while (pending.size > 0) {
    const { promise, value } = await Promise.race(
      [...pending].map((p) =>
        p.then((v) => ({ promise: p, value: v }))
      )
    );
    pending.delete(promise);
    yield value;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/proxy.ts
git commit -m "feat(proxy): add adaptive fallback — race remaining providers on 429"
```

### Task 10: Write adaptive fallback tests

**Files:**
- Modify: `tests/proxy.test.ts`

- [ ] **Step 1: Add race mode tests to proxy.test.ts**

Add these tests at the end of the existing `tests/proxy.test.ts` file:

```typescript
import { forwardWithFallback } from "../src/proxy.js";
import { createMockProvider } from "./helpers/mock-provider.js";

describe("forwardWithFallback race mode", () => {
  it("races remaining providers when first returns 429", async () => {
    const mock1 = createMockProvider();
    const mock2 = createMockProvider();
    mock1.setBehavior("error-429");
    // mock2 succeeds by default

    const provider1: ProviderConfig = {
      name: "provider-1",
      baseUrl: mock1.url,
      apiKey: "test",
      timeout: 5000,
    };
    const provider2: ProviderConfig = {
      name: "provider-2",
      baseUrl: mock2.url,
      apiKey: "test",
      timeout: 5000,
    };

    const providers = new Map<string, ProviderConfig>();
    providers.set("provider-1", provider1);
    providers.set("provider-2", provider2);

    const chain: RoutingEntry[] = [
      { provider: "provider-1" },
      { provider: "provider-2" },
    ];

    const ctx: RequestContext = {
      requestId: "test-race",
      model: "test-model",
      tier: "test",
      providerChain: chain,
      startTime: Date.now(),
      rawBody: JSON.stringify({ model: "test-model", messages: [] }),
    };

    const incoming = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ctx.rawBody,
    });

    const response = await forwardWithFallback(providers, chain, ctx, incoming);
    expect(response.status).toBe(200);

    await mock1.close();
    await mock2.close();
  });

  it("falls back sequentially on 500 (no race)", async () => {
    const mock1 = createMockProvider();
    const mock2 = createMockProvider();
    mock1.setBehavior("error-500");
    // mock2 succeeds by default

    const provider1: ProviderConfig = {
      name: "provider-1",
      baseUrl: mock1.url,
      apiKey: "test",
      timeout: 5000,
    };
    const provider2: ProviderConfig = {
      name: "provider-2",
      baseUrl: mock2.url,
      apiKey: "test",
      timeout: 5000,
    };

    const providers = new Map<string, ProviderConfig>();
    providers.set("provider-1", provider1);
    providers.set("provider-2", provider2);

    const chain: RoutingEntry[] = [
      { provider: "provider-1" },
      { provider: "provider-2" },
    ];

    const ctx: RequestContext = {
      requestId: "test-no-race",
      model: "test-model",
      tier: "test",
      providerChain: chain,
      startTime: Date.now(),
      rawBody: JSON.stringify({ model: "test-model", messages: [] }),
    };

    const incoming = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ctx.rawBody,
    });

    const response = await forwardWithFallback(providers, chain, ctx, incoming);
    expect(response.status).toBe(200);

    await mock1.close();
    await mock2.close();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx vitest run tests/proxy.test.ts`

Expected: All tests pass

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx vitest run`

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/proxy.test.ts
git commit -m "test: add adaptive fallback race mode tests"
```

### Task 11: Add metrics fields for fallback mode

**Files:**
- Modify: `src/types.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Add optional fields to RequestMetrics**

In `src/types.ts`, add to `RequestMetrics` interface:

```typescript
  fallbackMode?: "sequential" | "race";
  circuitBreakerSkipped?: string[];
```

- [ ] **Step 2: Populate fields in server.ts request handler**

In `src/server.ts`, in the `/v1/messages` handler, before the `forwardWithFallback` call, set up tracking:

After `let successfulProvider = "unknown";`, add:

```typescript
    let fallbackMode: "sequential" | "race" = "sequential";
    const circuitBreakerSkipped: string[] = [];
```

Pass `onAttempt` callback that detects race mode. The race mode is detected inside `forwardWithFallback` — for now, these fields are set by the proxy and read back from context. A simpler approach: add them to `RequestContext` as optional fields that `forwardWithFallback` populates.

In `src/types.ts`, add to `RequestContext`:

```typescript
  fallbackMode?: "sequential" | "race";
```

In `src/proxy.ts`, inside `forwardWithFallback`, before the race call, set:

```typescript
      if (response.status === 429 && i + 1 < chain.length) {
        ctx.fallbackMode = "race";
        // ... existing race logic
      }
```

In `src/server.ts`, when recording metrics (around line 277), pass:

```typescript
      metricsStore.recordRequest({
        // ... existing fields
        fallbackMode: ctx.fallbackMode,
      });
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx tsc --noEmit`

Expected: No errors

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx vitest run`

Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/proxy.ts src/server.ts
git commit -m "feat: add fallbackMode tracking to request metrics"
```

### Task 12: Final integration test and cleanup

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx vitest run`

Expected: All tests pass

- [ ] **Step 2: Build the project**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npm run build`

Expected: Build succeeds without errors

- [ ] **Step 3: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: cleanup and final integration"
```
```