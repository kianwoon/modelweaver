// src/pool.ts — Connection pool lifecycle: warmup, keep-alive refresh, stats

import type { ProviderConfig } from "./types.js";
import { Agent, request as undiciRequest } from "undici";

const DEFAULT_MODEL_POOL_SIZE = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WarmupStatus = "cold" | "warming" | "warm" | "failed";

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

export type PoolStats = Record<string, ProviderPoolStats>;

interface WarmupState {
  status: WarmupStatus;
  lastAttempt: number | null;
  lastSuccess: number | null;
}

/** InFlightCounter shape — matches hedging.ts InFlightCounter */
interface InFlightCounterLike {
  get(provider: string): number;
}

// ---------------------------------------------------------------------------
// Module-level warmup state
// ---------------------------------------------------------------------------

const warmupStates = new Map<string, WarmupState>();

function getOrCreateState(providerName: string): WarmupState {
  let state = warmupStates.get(providerName);
  if (!state) {
    state = { status: "cold", lastAttempt: null, lastSuccess: null };
    warmupStates.set(providerName, state);
  }
  return state;
}

/** Remove stale entries for providers no longer in config. */
export function pruneWarmupStates(activeProviders: string[]): void {
  const active = new Set(activeProviders);
  for (const key of warmupStates.keys()) {
    if (!active.has(key)) {
      warmupStates.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-model agent helpers
// ---------------------------------------------------------------------------

/** Get or lazily create a per-model undici Agent for the given provider. */
export function getOrCreateAgent(provider: ProviderConfig, modelId: string): Agent {
  if (!provider._agents) provider._agents = new Map();
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

/** Close all per-model agents for a provider (used during config reload). */
export async function closeAllAgents(provider: ProviderConfig): Promise<void> {
  if (!provider._agents) return;
  const promises: Promise<void>[] = [];
  for (const agent of provider._agents.values()) {
    promises.push(agent.close().catch(() => {}));
  }
  provider._agents.clear();
  await Promise.all(promises);
}

// ---------------------------------------------------------------------------
// Warmup — establish TLS connections via lightweight HEAD request
// ---------------------------------------------------------------------------

const WARMUP_TIMEOUT_MS = 5_000;

/**
 * Warm a single provider's connection pool by issuing a HEAD / request.
 *
 * Any HTTP response (even 401/404) means the TLS handshake completed and
 * the connection is now in the keep-alive pool. Only network-level errors
 * (DNS failure, connection refused, timeout) count as failure.
 */
export async function warmupProvider(provider: ProviderConfig): Promise<boolean> {
  const state = getOrCreateState(provider.name);
  state.status = "warming";
  state.lastAttempt = Date.now();

  // Ensure at least one agent exists for warmup
  if (!provider._agents || provider._agents.size === 0) {
    getOrCreateAgent(provider, "__warmup__");
  }

  const url = provider._cachedOrigin ?? provider.baseUrl;
  const host = provider._cachedHost ?? new URL(provider.baseUrl).host;

  let allOk = true;
  for (const [modelId, agent] of provider._agents!) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);
      const response = await undiciRequest(url, {
        method: "HEAD",
        dispatcher: agent,
        headers: { host },
        signal: controller.signal,
      });
      clearTimeout(timer);
      await response.body.dump();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // GOAWAY code 0 = graceful drain — server is healthy, just closing this connection.
      // The connection reached the server; don't mark the pool as "failed".
      const isGracefulGoaway = /GOAWAY.*code\s*0/i.test(message);
      if (isGracefulGoaway) {
        console.log(`[pool] Warmup got GOAWAY(0) for "${provider.name}"/${modelId} — graceful drain, connection OK`);
      } else {
        allOk = false;
        console.warn(`[pool] Warmup failed for "${provider.name}"/${modelId}: ${message}`);
      }
    }
  }

  if (allOk) {
    state.status = "warm";
    state.lastSuccess = Date.now();
  } else {
    state.status = "failed";
  }
  return allOk;
}

/**
 * Warm all providers in parallel. Returns a map of provider name → success.
 * Never throws — individual failures are logged and captured in the result.
 */
export async function warmupAll(providers: Map<string, ProviderConfig>): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const entries = [...providers.entries()].filter(([, p]) => p.prewarm !== false);

  if (entries.length === 0) return results;

  const settled = await Promise.allSettled(
    entries.map(async ([name, provider]) => {
      const ok = await warmupProvider(provider);
      return [name, ok] as const;
    }),
  );

  for (const result of settled) {
    if (result.status === "fulfilled") {
      results.set(result.value[0], result.value[1]);
    }
  }

  const succeeded = [...results.values()].filter(Boolean).length;
  const failed = results.size - succeeded;
  const failedNames = [...results.entries()].filter(([, ok]) => !ok).map(([name]) => name);
  if (failed > 0) {
    console.log(`[pool] Warmup complete: ${succeeded}/${results.size} succeeded (${failed} failed: ${failedNames.join(", ")})`);
  } else {
    console.log(`[pool] Warmup complete: ${succeeded}/${results.size} providers warmed`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Background refresh loop — keep pool warm during idle periods
// ---------------------------------------------------------------------------

/**
 * Start a periodic refresh loop that keeps provider connection pools warm.
 *
 * The providers callback returns the current provider map, so the loop
 * automatically picks up config changes from hot-reload.
 *
 * @param providersFn - Callback that returns current provider map
 * @param intervalMs - Refresh interval in ms (default 20s, safely below 30s keepAliveTimeout)
 */
export function startRefreshLoop(
  providersFn: () => Map<string, ProviderConfig>,
  intervalMs: number = 20_000,
): { stop: () => void } {
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) return;

    const providers = providersFn();
    for (const [, provider] of providers) {
      if (stopped) break;

      // Skip providers with open circuit breakers — they're known to be down
      const cbState = provider._circuitBreaker?.getState();
      if (cbState === "open") continue;

      await warmupProvider(provider);
    }
  }, intervalMs);

  // Don't prevent process exit
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Pool stats — approximate pool state for monitoring
// ---------------------------------------------------------------------------

/**
 * Get estimated pool stats for all providers.
 *
 * NOTE: undici does not expose actual idle connection counts or queue depth.
 * These values are approximations based on pool size and in-flight count.
 */
export function getPoolStats(
  providers: Map<string, ProviderConfig>,
  inFlightCounter: InFlightCounterLike,
): PoolStats {
  const stats: PoolStats = {};

  for (const [name, provider] of providers) {
    const poolSize = provider.poolSize ?? 10;
    const inFlight = inFlightCounter.get(name);
    const state = getOrCreateState(name);

    // Build per-model breakdown from lazily-created agents
    const models: Record<string, { poolSize: number }> = {};
    if (provider._agents) {
      for (const [modelId] of provider._agents) {
        models[modelId] = {
          poolSize: provider.modelPools?.[modelId] ?? DEFAULT_MODEL_POOL_SIZE,
        };
      }
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
