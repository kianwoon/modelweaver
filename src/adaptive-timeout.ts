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
    return Math.max(TTFB_FLOOR_MS, Math.min(base, p95Approx));
  }

  // Not enough samples — use configured value as-is
  return base;
}
