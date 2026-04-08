// src/adaptive-timeout.ts — Dynamic timeout adjustment based on observed latency

import type { ProviderConfig } from "./types.js";
import type { LatencyTracker } from "./hedging.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum sample count before adaptive tuning kicks in.
 * With fewer samples, the statistics aren't meaningful enough to adjust.
 */
const MIN_SAMPLES = 5;

// ---------------------------------------------------------------------------
// Adaptive TTFB timeout
// ---------------------------------------------------------------------------

/**
 * Resolve an adaptive TTFB timeout for a provider.
 *
 * Uses latency-based adaptation only: when a provider is consistently fast,
 * the timeout is tightened to match observed p95 (capped at configured value).
 * When insufficient data is available, falls back to the static configured value.
 *
 * Previously, a health-based signal shrank the timeout on unhealthy providers,
 * creating a death spiral: unhealthy → shorter timeout → more failures → worse health.
 * Health-based TTFB was removed because it prevented providers from recovering.
 *
 * @param provider - Provider config (reads `ttfbTimeout`)
 * @param tracker - LatencyTracker instance from hedging module
 * @returns TTFB timeout in milliseconds
 */
export function resolveAdaptiveTTFB(provider: ProviderConfig, tracker: LatencyTracker): number {
  const base = provider.ttfbTimeout ?? 8000;

  // Latency-based signal: tighten timeout when observed p95 is below configured base.
  // This helps fast providers fail bad connections sooner without penalizing slow ones.
  const stats = tracker.getStats(provider.name);
  if (stats.count >= MIN_SAMPLES) {
    // Approximate p95 using mean + 2*stddev (normal distribution).
    // cv = stddev / mean, so stddev = cv * mean.
    // p95 ≈ mean * (1 + 2*cv)
    const p95Approx = Math.round(stats.mean * (1 + 2 * stats.cv));
    // Config is the floor — p95 can only raise the timeout, never lower it.
    // This respects the user's explicit ttfbTimeout while still adapting upward
    // when observed latency exceeds the configured value.
    return Math.max(base, p95Approx);
  }

  // Not enough samples — use configured value as-is
  return base;
}

// ---------------------------------------------------------------------------
// TimeoutBoostManager — burst-based 50% timeout boost
// ---------------------------------------------------------------------------

/**
 * Timeout error types tracked for burst detection.
 */
export type TimeoutErrorType = "ttfb" | "stall" | "timeout";

/** Number of errors within the window required to trigger a boost. */
const BURST_THRESHOLD = 5;

/** Sliding window duration (ms) for counting errors. */
const WINDOW_MS = 600_000; // 10 minutes

/** Cooldown duration (ms) after the last error before the boost resets. */
const COOLDOWN_MS = 600_000; // 10 minutes

/** Multiplier applied to the original timeout when boosting. */
const BOOST_MULTIPLIER = 1.5;

/**
 * Get the current value of a timeout field on a provider config.
 * Uses a switch statement for type safety — avoids dynamic indexing
 * on the ProviderConfig interface.
 */
function getTimeoutValue(provider: ProviderConfig, type: TimeoutErrorType): number {
  switch (type) {
    case "ttfb":
      return provider.ttfbTimeout ?? 8000;
    case "stall":
      return provider.stallTimeout ?? 15000;
    case "timeout":
      return provider.timeout;
  }
}

/**
 * Set a timeout field on a provider config.
 * Uses a switch statement for type safety — avoids dynamic indexing
 * on the ProviderConfig interface.
 */
function setTimeoutValue(provider: ProviderConfig, type: TimeoutErrorType, value: number): void {
  switch (type) {
    case "ttfb":
      provider.ttfbTimeout = value;
      break;
    case "stall":
      provider.stallTimeout = value;
      break;
    case "timeout":
      provider.timeout = value;
      break;
  }
}

/** Per-provider, per-type boost state. */
interface BoostState {
  /** Original (unboosted) timeout value. */
  original: number;
  /** Timestamps of errors within the sliding window. */
  errors: number[];
  /** Whether the boost is currently active. */
  boosted: boolean;
}

/**
 * Manages temporary 50% timeout boosts when providers experience error bursts.
 *
 * When 5+ timeout errors of the same type occur within a 10-minute window,
 * the corresponding timeout is boosted by 50%. The boost persists until the
 * provider has had no errors of that type for a full cooldown period (10 min),
 * at which point the original timeout is restored.
 *
 * Each provider and timeout type is tracked independently.
 */
export class TimeoutBoostManager {
  private state: Map<string, BoostState> = new Map();
  private now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
  }

  /** Build a composite key for the internal state map. */
  private key(providerName: string, type: TimeoutErrorType): string {
    return `${providerName}::${type}`;
  }

  /** Get or create boost state for a provider+type pair. */
  private getOrCreate(providerName: string, type: TimeoutErrorType): BoostState {
    const k = this.key(providerName, type);
    let state = this.state.get(k);
    if (!state) {
      state = { original: 0, errors: [], boosted: false };
      this.state.set(k, state);
    }
    return state;
  }

  /** Remove timestamps older than WINDOW_MS from the start of the array. */
  private pruneWindow(state: BoostState): void {
    const cutoff = this.now() - WINDOW_MS;
    while (state.errors.length > 0 && state.errors[0] < cutoff) {
      state.errors.shift();
    }
  }

  /**
   * Record a timeout error and potentially apply a boost.
   *
   * Prunes expired errors, pushes the new timestamp, and checks whether
   * the burst threshold has been reached. If so, applies a 50% boost
   * (idempotent — repeated calls won't compound the boost).
   */
  recordTimeoutError(provider: ProviderConfig, type: TimeoutErrorType): void {
    const state = this.getOrCreate(provider.name, type);

    // Prune expired errors before adding the new one
    this.pruneWindow(state);

    // Record the current error
    state.errors.push(this.now());

    // Store original value on first encounter (before any boost)
    if (state.original === 0) {
      state.original = getTimeoutValue(provider, type);
    }

    // Check threshold — only boost once (idempotent)
    if (!state.boosted && state.errors.length >= BURST_THRESHOLD) {
      this.applyBoost(provider, type, state);
    }
  }

  /**
   * Apply a 50% boost to the provider's timeout field.
   * Stores the original value so it can be restored later.
   */
  private applyBoost(provider: ProviderConfig, type: TimeoutErrorType, state: BoostState): void {
    const boosted = Math.round(state.original * BOOST_MULTIPLIER);
    setTimeoutValue(provider, type, boosted);
    state.boosted = true;
  }

  /**
   * Check whether the boost should be reset for all types on a provider.
   *
   * For each boosted timeout type, if the most recent error is older than
   * COOLDOWN_MS, the original value is restored. If a recent error exists
   * (within the cooldown window), the boost is kept active.
   */
  checkReset(provider: ProviderConfig): void {
    const types: TimeoutErrorType[] = ["ttfb", "stall", "timeout"];
    for (const type of types) {
      const k = this.key(provider.name, type);
      const state = this.state.get(k);
      if (!state || !state.boosted) continue;

      this.pruneWindow(state);

      // If there are still recent errors, keep the boost
      if (state.errors.length > 0) continue;

      // No recent errors — safe to reset
      this.resetBoost(provider, type, k, state);
    }
  }

  /**
   * Restore the original timeout value and clear boost state.
   */
  private resetBoost(
    provider: ProviderConfig,
    type: TimeoutErrorType,
    key: string,
    state: BoostState,
  ): void {
    setTimeoutValue(provider, type, state.original);
    this.state.delete(key);
  }

  /**
   * Return boost diagnostic info for a provider (used for monitoring/debugging).
   */
  getBoostInfo(providerName: string): Record<TimeoutErrorType, { boosted: boolean; errorCount: number; original?: number }> {
    const types: TimeoutErrorType[] = ["ttfb", "stall", "timeout"];
    const result = {} as Record<TimeoutErrorType, { boosted: boolean; errorCount: number; original?: number }>;
    for (const type of types) {
      const state = this.state.get(this.key(providerName, type));
      result[type] = state
        ? { boosted: state.boosted, errorCount: state.errors.length, original: state.original || undefined }
        : { boosted: false, errorCount: 0 };
    }
    return result;
  }
}
