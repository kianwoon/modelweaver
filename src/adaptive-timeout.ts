// src/adaptive-timeout.ts — Dynamic timeout adjustment based on observed latency

import type { ProviderConfig } from "./types.js";
import type { LatencyTracker } from "./hedging.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum TTFB timeout (ms) — safety floor even for very fast providers */
const TTFB_FLOOR_MS = 2000;

/**
 * Minimum sample count before adaptive tuning kicks in.
 * With fewer samples, the statistics aren't meaningful enough to adjust.
 */
const MIN_SAMPLES = 5;

// ---------------------------------------------------------------------------
// Adaptive TTFB timeout
// ---------------------------------------------------------------------------

/**
 * Resolve an adaptive TTFB timeout for a provider based on observed latency.
 *
 * Uses the LatencyTracker's rolling window (30 samples) to compute an
 * approximate p95, then clamps it:
 *   - Floor: TTFB_FLOOR_MS (2s) — prevents overly aggressive timeouts
 *   - Ceiling: the configured static `ttfbTimeout` — user knows best
 *
 * This means adaptive tuning can only TIGHTEN the timeout, never loosen it.
 * If a provider gets persistently slow, the circuit breaker handles it.
 *
 * Falls back to the static configured value when there aren't enough samples.
 *
 * @param provider - Provider config (reads `ttfbTimeout`)
 * @param tracker - LatencyTracker instance from hedging module
 * @returns TTFB timeout in milliseconds
 */
export function resolveAdaptiveTTFB(provider: ProviderConfig, tracker: LatencyTracker): number {
  const base = provider.ttfbTimeout ?? 8000;
  const stats = tracker.getStats(provider.name);

  // Not enough data — use static config
  if (stats.count < MIN_SAMPLES) return base;

  // Approximate p95 using mean + 2*stddev (normal distribution).
  // cv = stddev / mean, so stddev = cv * mean.
  // p95 ≈ mean * (1 + 2*cv)
  const p95Approx = Math.round(stats.mean * (1 + 2 * stats.cv));

  // Clamp: floor safety, ceiling is the configured static value
  return Math.max(TTFB_FLOOR_MS, Math.min(base, p95Approx));
}
