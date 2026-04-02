// src/adaptive-timeout.ts — Dynamic timeout adjustment based on observed latency

import type { ProviderConfig } from "./types.js";
import type { LatencyTracker } from "./hedging.js";
import { getHealthScore } from "./health-score.js";

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

/**
 * Minimum health score multiplier floor.
 * Even a very unhealthy provider (score → 0) gets at least 20% of configured TTFB.
 */
const HEALTH_TTFB_MIN_MULTIPLIER = 0.2;

// ---------------------------------------------------------------------------
// Adaptive TTFB timeout
// ---------------------------------------------------------------------------

/**
 * Resolve an adaptive TTFB timeout for a provider.
 *
 * Composes two independent signals via min():
 *   1. Latency-based: uses LatencyTracker's rolling window to compute approximate p95.
 *      Tightens timeout for consistently slow providers.
 *   2. Health-based: scales configured TTFB by max(healthScore, HEALTH_TTFB_MIN_MULTIPLIER).
 *      Fails unhealthy providers faster so the fallback chain can start sooner.
 *
 * Taking the min() of both signals means a provider gets fast-failed if it's
 * either slow OR unhealthy — whichever is more aggressive.
 *
 * Falls back to the static configured value when there aren't enough samples.
 *
 * @param provider - Provider config (reads `ttfbTimeout`)
 * @param tracker - LatencyTracker instance from hedging module
 * @returns TTFB timeout in milliseconds
 */
export function resolveAdaptiveTTFB(provider: ProviderConfig, tracker: LatencyTracker): number {
  const base = provider.ttfbTimeout ?? 8000;

  // Signal 1: latency-based (from existing implementation)
  const stats = tracker.getStats(provider.name);
  let latencyBased = base;
  if (stats.count >= MIN_SAMPLES) {
    // Approximate p95 using mean + 2*stddev (normal distribution).
    // cv = stddev / mean, so stddev = cv * mean.
    // p95 ≈ mean * (1 + 2*cv)
    const p95Approx = Math.round(stats.mean * (1 + 2 * stats.cv));
    latencyBased = Math.max(TTFB_FLOOR_MS, Math.min(base, p95Approx));
  }

  // Signal 2: health-score-based
  // Scale TTFB by health score, floor at 20% of base to avoid too-aggressive timeouts.
  // Provider at 100% health → full base
  // Provider at 30% health → 30% of base (or HEALTH_TTFB_MIN_MULTIPLIER, whichever is higher)
  const healthScore = getHealthScore(provider.name);
  const healthMultiplier = Math.max(healthScore, HEALTH_TTFB_MIN_MULTIPLIER);
  const healthBased = Math.round(base * healthMultiplier);

  // Compose: use the tighter of the two signals
  return Math.min(latencyBased, healthBased);
}
