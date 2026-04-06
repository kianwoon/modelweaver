# Per-Model Connection Pool Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single shared `undici.Agent` per provider with per-model isolated agents.

**Architecture:** `ProviderConfig._agent` (single Agent) → `ProviderConfig._agents` (Map<string, Agent>). Lazy creation via `getOrCreateAgent()`. Config reload closes old agents, creates fresh Maps.

**Tech Stack:** TypeScript, undici, vitest

---

### Task 1: Add `modelPools` config schema and type

**Files:**
- Modify: `src/types.ts:22-28`
- Modify: `src/config.ts:136`

- [ ] **Step 1: Update `ProviderConfig` in types.ts**

Replace `_agent` with `_agents`, add `modelPools`:

```ts
// Replace line 22:
// _agent?: import("undici").Agent;
// With:
_agents: Map<string, import("undici").Agent> = new Map();

// Add after poolSize (line 25):
modelPools?: Record<string, number>;
```

- [ ] **Step 2: Add `modelPools` to Zod schema in config.ts**

After line 136 (`poolSize`), add:

```ts
modelPools: z.record(z.string(), z.number().int().min(1).max(50)).optional(),
```

- [ ] **Step 3: Pass `modelPools` through config parsing in config.ts**

In the `loadConfig` function where providers are built (~line 257-268), add:

```ts
modelPools: config.modelPools !== undefined ? { ...config.modelPools } : undefined,
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts
git commit -m "feat: add modelPools config schema and _agents Map type (#186)"
```

---

### Task 2: Replace `_agent` creation with `_agents` Map in config.ts

**Files:**
- Modify: `src/config.ts:452-462`

- [ ] **Step 1: Replace `new Agent()` + `_agent` assignment with empty `_agents` Map**

In `loadConfig()`, replace lines 452-462:

```ts
// BEFORE:
const poolSize = p.poolSize;
providerConfig._agent = new Agent({
  keepAliveTimeout: 120_000,
  keepAliveMaxTimeout: 300_000,
  connections: poolSize ?? 10,
  allowH2: true,
  pingInterval: 10_000,
});
createdAgents.push(providerConfig._agent);
providerConfig.poolSize = poolSize ?? 10;

// AFTER:
providerConfig._agents = new Map();
providerConfig.poolSize = p.poolSize ?? 10;
```

Note: `createdAgents` array is no longer needed since agents are lazy-created. Remove it from the function if unused elsewhere.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: replace per-provider _agent with empty _agents Map (#186)"
```

---

### Task 3: Implement `getOrCreateAgent()` and `closeAllAgents()` in pool.ts

**Files:**
- Modify: `src/pool.ts`

- [ ] **Step 1: Add imports and constants**

At top of pool.ts, add:

```ts
import { Agent } from "undici";

const DEFAULT_MODEL_POOL_SIZE = 2;
```

- [ ] **Step 2: Add `getOrCreateAgent()` helper**

```ts
export function getOrCreateAgent(provider: ProviderConfig, modelId: string): Agent {
  let agent = provider._agents.get(modelId);
  if (!agent) {
    const poolSize = provider.modelPools?.[modelId] ?? DEFAULT_MODEL_POOL_SIZE;
    agent = new Agent({
      connections: poolSize,
      keepAliveTimeout: 120_000,
      keepAliveMaxTimeout: 300_000,
      allowH2: true,
      pingInterval: 10_000,
    });
    provider._agents.set(modelId, agent);
  }
  return agent;
}
```

- [ ] **Step 3: Add `closeAllAgents()` helper**

```ts
export async function closeAllAgents(provider: ProviderConfig): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const agent of provider._agents.values()) {
    promises.push(agent.close().catch(() => {}));
  }
  provider._agents.clear();
  await Promise.all(promises);
}
```

- [ ] **Step 4: Update `warmupProvider()` to iterate `_agents`**

Replace the `if (!provider._agent)` check and `provider._agent` usage:

```ts
// BEFORE (line 78):
if (!provider._agent) {
  state.status = "failed";
  console.warn(`[pool] Provider "${provider.name}" has no agent — skipping warmup`);
  return false;
}

// AFTER:
if (provider._agents.size === 0) {
  // No models seen yet — create a default agent for warmup
  getOrCreateAgent(provider, "__warmup__");
}

// Warm all agents in the map
const agents = [...provider._agents.values()];
const results = await Promise.allSettled(
  agents.map(async (agent) => {
    // ... same HEAD request logic, using `agent` instead of `provider._agent`
  })
);
```

- [ ] **Step 5: Commit**

```bash
git add src/pool.ts
git commit -m "feat: add getOrCreateAgent and closeAllAgents helpers (#186)"
```

---

### Task 4: Update proxy.ts dispatcher selection

**Files:**
- Modify: `src/proxy.ts:1-5,779`

- [ ] **Step 1: Add import**

```ts
import { getOrCreateAgent } from "./pool.js";
```

- [ ] **Step 2: Update dispatcher selection at line 779**

```ts
// BEFORE:
const dispatcher = sessionPool?.get(ctx.sessionId, poolModel) ?? provider._agent;

// AFTER:
const dispatcher = sessionPool?.get(ctx.sessionId, poolModel) ?? getOrCreateAgent(provider, poolModel);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: use per-model agent in proxy dispatcher selection (#186)"
```

---

### Task 5: Update server.ts — setConfig reload and closeAgents

**Files:**
- Modify: `src/server.ts:869-920`

- [ ] **Step 1: Import `closeAllAgents` from pool.ts**

- [ ] **Step 2: Rewrite `setConfig()` agent reuse logic**

Replace the single-agent reuse block with per-model agent transfer:

```ts
setConfig: async (newConfig: AppConfig) => {
  // Close all old per-model agents
  const closePromises: Promise<void>[] = [];
  for (const provider of config.providers.values()) {
    for (const agent of provider._agents.values()) {
      closePromises.push(agent.close().catch(() => {}));
    }
  }
  await Promise.all(closePromises);

  // New providers start with empty _agents Maps — agents are lazy-created
  config = newConfig;
  activeProbeManager.updateProviders(newConfig.providers);
  clearRoutingCache();
  clearHedgeStats();
},
```

Note: The old `agentKey()` reuse logic is removed since per-model agents are lightweight and lazily recreated. Simplifies the reload path significantly.

- [ ] **Step 3: Update `closeAgents()`**

```ts
closeAgents: async () => {
  const closePromises: Promise<void>[] = [];
  for (const provider of config.providers.values()) {
    for (const agent of provider._agents.values()) {
      closePromises.push(agent.close().catch(() => {}));
    }
  }
  await Promise.all(closePromises);
},
```

- [ ] **Step 4: Remove unused `agentKey()` function** (line 419-423)

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: update config reload and closeAgents for per-model pools (#186)"
```

---

### Task 6: Update pool stats to report per-model breakdown

**Files:**
- Modify: `src/pool.ts:12-22,204-227`
- Modify: `tests/pool.test.ts`

- [ ] **Step 1: Update `ProviderPoolStats` type**

```ts
export interface ProviderPoolStats {
  poolSize: number;
  inFlight: number;
  estimatedFree: number;
  warmupStatus: WarmupStatus;
  lastWarmupAttempt: number | null;
  lastWarmupSuccess: number | null;
  circuitBreakerState: string;
  models?: Record<string, { poolSize: number }>;
}
```

- [ ] **Step 2: Update `getPoolStats()` to include per-model data**

```ts
export function getPoolStats(
  providers: Map<string, ProviderConfig>,
  inFlightCounter: InFlightCounterLike,
): PoolStats {
  const stats: PoolStats = {};
  for (const [name, provider] of providers) {
    const poolSize = provider.poolSize ?? 10;
    const inFlight = inFlightCounter.get(name);
    const state = getOrCreateState(name);
    const models: Record<string, { poolSize: number }> = {};
    for (const [modelId] of provider._agents) {
      models[modelId] = {
        poolSize: provider.modelPools?.[modelId] ?? DEFAULT_MODEL_POOL_SIZE,
      };
    }
    stats[name] = {
      poolSize,
      inFlight,
      estimatedFree: Math.max(0, poolSize - inFlight),
      warmupStatus: state.status,
      lastWarmupAttempt: state.lastAttempt,
      lastWarmupSuccess: state.lastSuccess,
      circuitBreakerState: provider._circuitBreaker?.getState() ?? "closed",
      models: Object.keys(models).length > 0 ? models : undefined,
    };
  }
  return stats;
}
```

- [ ] **Step 3: Update tests in tests/pool.test.ts**

Update `makeProvider` helper and add per-model stats test:

```ts
function makeProvider(name: string, baseUrl: string, poolSize = 10): ProviderConfig {
  return {
    name,
    baseUrl,
    apiKey: "test-key",
    timeout: 5000,
    poolSize,
    _agents: new Map(),
    _cachedOrigin: baseUrl.replace(/\/$/, ""),
    _cachedHost: new URL(baseUrl).host,
  };
}
```

Add test:

```ts
it("includes per-model breakdown when agents exist", () => {
  const provider = makeProvider("anthropic", "http://api.anthropic.com", 10);
  provider.modelPools = { "claude-sonnet-4-6": 4, "claude-haiku-4-5": 3 };
  getOrCreateAgent(provider, "claude-sonnet-4-6");
  getOrCreateAgent(provider, "claude-opus-4");

  const stats = getPoolStats(new Map([["anthropic", provider]]), makeInFlightCounter());

  expect(stats.anthropic.models).toBeDefined();
  expect(stats.anthropic.models!["claude-sonnet-4-6"].poolSize).toBe(4);
  expect(stats.anthropic.models!["claude-haiku-4-5"]).toBeUndefined();
  expect(stats.anthropic.models!["claude-opus-4"].poolSize).toBe(2);
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/pool.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/pool.ts tests/pool.test.ts
git commit -m "feat: add per-model breakdown to pool stats (#186)"
```

---

### Task 7: Update existing tests for `_agents` Map

**Files:**
- Modify: `tests/pool.test.ts` (remaining references)
- Modify: `tests/server.test.ts` (if any `_agent` references)
- Modify: `tests/config.test.ts` (pool size tests)

- [ ] **Step 1: Find and fix all `_agent` references in tests**

Run: `grep -rn '_agent' tests/`
Fix each reference to use `_agents` Map pattern.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add tests/
git commit -m "test: update tests for per-model _agents Map (#186)"
```

---

### Task 8: Update init screens and YAML config support

**Files:**
- Modify: `src/init/screens/shared/types.ts`
- Modify: `src/init/screens/shared/write.ts`
- Modify: `src/init/screens/providers.ts`

- [ ] **Step 1: Add `modelPools` to init types and write**

In `types.ts`, add to provider config type:
```ts
modelPools?: Record<string, number>;
```

In `write.ts`, add to provider YAML output:
```ts
...(provider.modelPools && Object.keys(provider.modelPools).length > 0 && { modelPools: provider.modelPools }),
```

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/init/
git commit -m "feat: add modelPools to init screens (#186)"
```

---

### Task 9: Build, reload, and manual verification

- [ ] **Step 1: Build**

Run: `npx tsc --noEmit && npm run build`

- [ ] **Step 2: Reload daemon**

Run: `node dist/index.js reload`

- [ ] **Step 3: Verify /api/pool returns per-model data**

Send a request through the proxy, then check `/api/pool` — should show `models` field.

- [ ] **Step 4: Verify backward compatibility**

Without `modelPools` in config, verify requests still work with default 2-connection per-model agents.

- [ ] **Step 5: Final commit if any fixes needed**
