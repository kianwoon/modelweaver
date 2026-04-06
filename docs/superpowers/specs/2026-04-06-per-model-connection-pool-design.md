# Per-Model Connection Pool Isolation

> Issue: kianwoon/modelweaver#186
> Date: 2026-04-06

## Problem

Currently the proxy creates **one `undici.Agent` per provider** with a shared connection pool (default 10 connections). All model IDs share this pool — a slow `opus` streaming response can occupy a connection and block a fast `haiku` request via head-of-line blocking.

## Design

Replace the single `_agent` on `ProviderConfig` with a `Map<string, Agent>` keyed by model ID. Each model gets its own `undici.Agent` with an isolated connection pool, created lazily on first request.

### Current vs Proposed

```
CURRENT:
  Provider "anthropic" → 1 Agent (10 shared connections)
    ├── claude-sonnet-4-6 requests ──┐
    ├── claude-haiku-4-5 requests ──┤ competing for same pool
    └── claude-opus-4 requests     ──┘

PROPOSED:
  Provider "anthropic" → 3 Agents (1 per model ID, lazy-created)
    ├── claude-sonnet-4-6 → Agent (4 connections, from modelPools config)
    ├── claude-haiku-4-5 → Agent (3 connections, from modelPools config)
    └── claude-opus-4    → Agent (2 connections, DEFAULT_MODEL_POOL_SIZE)
```

## Section 1: Type & Config Changes

### `src/types.ts`

Replace `_agent` with `_agents`:

```ts
// Before:
_agent?: import("undici").Agent;

// After:
_agents: Map<string, import("undici").Agent> = new Map();
```

Add `modelPools` to `ProviderConfig`:

```ts
modelPools?: Record<string, number>;
```

### `src/config.ts`

Add `modelPools` to provider Zod schema:

```ts
modelPools: z.record(z.string(), z.number().int().min(1).max(50)).optional(),
```

### YAML Config

```yaml
providers:
  anthropic:
    poolSize: 10              # total hint (informational for stats)
    modelPools:
      claude-sonnet-4-6: 4
      claude-haiku-4-5: 3
    # unconfigured models auto-get 2 connections
```

- `poolSize` remains as an informational total and backward-compat config
- `modelPools` is optional — when absent, every model gets `DEFAULT_MODEL_POOL_SIZE`
- When present, listed models use their configured size, unlisted models get default

## Section 2: Agent Lifecycle (`src/pool.ts`)

### New constant

```ts
const DEFAULT_MODEL_POOL_SIZE = 2;
```

### New helper: `getOrCreateAgent()`

```ts
export function getOrCreateAgent(provider: ProviderConfig, modelId: string): Agent {
  let agent = provider._agents.get(modelId);
  if (!agent) {
    const poolSize = provider.modelPools?.[modelId] ?? DEFAULT_MODEL_POOL_SIZE;
    agent = new Agent({
      connections: poolSize,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      allowH2: true,
    });
    provider._agents.set(modelId, agent);
  }
  return agent;
}
```

### Warmup changes

- `warmupProvider()` iterates all agents in `_agents` Map
- If Map is empty (no models seen yet), creates a default agent using `poolSize` and warms it
- Maintains backward compatibility for providers that haven't seen requests yet

### Stats changes

- `getPoolStats()` reports per-model breakdown via new `models` field on `ProviderPoolStats`
- Each model entry shows: `{ poolSize, inFlight }`

### Cleanup

- New `closeAllAgents(provider)` helper closes all agents in the Map
- Called during config reload when providers are destroyed/replaced

## Section 3: Proxy Integration & Init Changes

### `src/proxy.ts`

Dispatcher selection at line 779 changes from:

```ts
const dispatcher = sessionPool?.get(ctx.sessionId, poolModel) ?? provider._agent;
```

To:

```ts
import { getOrCreateAgent } from "./pool.js";
const dispatcher = sessionPool?.get(ctx.sessionId, poolModel)
  ?? getOrCreateAgent(provider, poolModel);
```

### `src/init.ts`

Update agent creation to use `_agents` Map instead of `_agent`. Remove direct `new Agent()` calls that set `provider._agent`.

### Config Reload

- On reload, `closeAllAgents()` is called for each provider before replacing configs
- New config's providers start with empty `_agents` Maps — agents are lazily created as requests arrive

### Session Pool (`src/session-pool.ts`)

No changes — `SessionAgentPool` already handles per-session, per-model isolation independently. It takes priority over the shared model agents via the `??` fallback chain.

## Backward Compatibility

- If `modelPools` is not configured, all models get `DEFAULT_MODEL_POOL_SIZE = 2` connections each
- This is a behavior change from the current single shared pool — this is the intended improvement
- The old `_agent` field is removed entirely; all code uses `_agents` Map
- `poolSize` config field remains for informational purposes and as a fallback for warmup stats

## Acceptance Criteria

- [ ] Each model ID gets its own `undici.Agent` with isolated connection pool
- [ ] Pool stats API (`/api/pool`) reports per-model breakdown
- [ ] Existing circuit breaker, hedging, and fallback logic work unchanged
- [ ] Config reload properly creates/destroys per-model agents
- [ ] Backward compatible — if `modelPools` not configured, auto-creates agents with default size
