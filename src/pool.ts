// src/pool.ts — Connection pool lifecycle: warmup, keep-alive refresh, stats

import type { ProviderConfig } from "./types.js";
import { request as undiciRequest } from "undici";

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

  if (!provider._agent) {
    state.status = "failed";
    console.warn(`[pool] Provider "${provider.name}" has no agent — skipping warmup`);
    return false;
  }

  const url = provider._cachedOrigin ?? provider.baseUrl;
  const host = provider._cachedHost ?? new URL(provider.baseUrl).host;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);

    const response = await undiciRequest(url, {
      method: "HEAD",
      dispatcher: provider._agent,
      headers: { "host": host },
      signal: controller.signal,
    });

    clearTimeout(timer);

    // Consume body to release connection back to the pool
    await response.body.dump();

    state.status = "warm";
    state.lastSuccess = Date.now();
    return true;
  } catch (err) {
    state.status = "failed";
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[pool] Warmup failed for "${provider.name}": ${message}`);
    return false;
  }
}

/**
 * Warm all providers in parallel. Returns a map of provider name → success.
 * Never throws — individual failures are logged and captured in the result.
 */
export async function warmupAll(providers: Map<string, ProviderConfig>): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const entries = [...providers.entries()];

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

    stats[name] = {
      poolSize,
      inFlight,
      estimatedFree: Math.max(0, poolSize - inFlight),
      warmupStatus: state.status,
      lastWarmupAttempt: state.lastAttempt,
      lastWarmupSuccess: state.lastSuccess,
      circuitBreakerState: provider._circuitBreaker?.getState() ?? "closed",
    };
  }

  return stats;
}
