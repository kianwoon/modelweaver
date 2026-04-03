// src/health-score.ts — Real-time provider health scores for dynamic routing

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HealthEvent {
  success: boolean;
  latencyMs: number;
  timestamp: number;
}

interface ProviderHealth {
  events: HealthEvent[];
  windowMs: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const providerHealth = new Map<string, ProviderHealth>();
const MAX_EVENTS = 100;
const DEFAULT_WINDOW_MS = 300_000; // 5 minutes

const MAX_PROVIDERS = 50;

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record a request outcome for health tracking.
 * Called from proxy.ts after each request completes.
 *
 * @param providerName - Provider identifier
 * @param success - Whether the request succeeded (2xx status)
 * @param latencyMs - Full request latency in milliseconds
 */
export function recordHealthEvent(providerName: string, success: boolean, latencyMs: number): void {
  if (providerHealth.size >= MAX_PROVIDERS && !providerHealth.has(providerName)) {
    // Remove the first (oldest) provider to prevent unbounded growth
    const firstKey = providerHealth.keys().next().value;
    if (firstKey !== undefined) providerHealth.delete(firstKey);
  }

  let health = providerHealth.get(providerName);
  if (!health) {
    health = { events: [], windowMs: DEFAULT_WINDOW_MS };
    providerHealth.set(providerName, health);
  }

  health.events.push({ success, latencyMs, timestamp: Date.now() });

  // Prune old events outside the time window
  const cutoff = Date.now() - health.windowMs;
  while (health.events.length > 0 && health.events[0].timestamp < cutoff) {
    health.events.shift();
  }

  // Cap total events to prevent memory growth
  if (health.events.length > MAX_EVENTS) {
    health.events.splice(0, health.events.length - MAX_EVENTS);
  }
}

/** Remove stale entries for providers no longer in config. */
export function pruneHealthScores(activeProviders: string[]): void {
  const active = new Set(activeProviders);
  for (const key of providerHealth.keys()) {
    if (!active.has(key)) {
      providerHealth.delete(key);
    }
  }
}

/** Clear all health data. Used for testing. */
export function clearHealthScores(): void {
  providerHealth.clear();
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

/**
 * Compute a health score for a provider based on recent request history.
 *
 * Score range: 0 (fully degraded) to 1 (perfectly healthy).
 *
 * Combines two signals:
 *   - successRate: ratio of 2xx responses in the rolling window
 *   - latencyScore: inverse of p99 latency, normalized to 0-1 range
 *
 * Formula:
 *   healthScore = SUCCESS_WEIGHT * successRate + LATENCY_WEIGHT * latencyScore
 *   (latencyScore = 1 - min(1, p99_latency / 30000))
 *
 * Uses weighted average instead of multiplication to avoid amplification:
 * a provider slightly degraded on both axes (e.g. 90% success, 50% latency)
 * gets 0.78 (weighted avg) instead of 0.45 (product) — avoiding false negatives.
 *
 * @param providerName - Provider identifier
 * @returns Health score between 0 and 1. Returns 1 (healthy) when insufficient data.
 */
export function getHealthScore(providerName: string): number {
  const health = providerHealth.get(providerName);

  // No data — assume healthy (let static weights drive routing)
  if (!health || health.events.length < 5) return 1;

  const events = health.events;
  const count = events.length;

  // Success rate
  const successCount = events.filter(e => e.success).length;
  const successRate = successCount / count;

  // Latency score: inverse of p99, normalized
  const latencies = events.map(e => e.latencyMs).sort((a, b) => a - b);
  const p99Idx = Math.min(Math.floor(count * 0.99), count - 1);
  const p99 = latencies[p99Idx];
  const LATENCY_CEILING_MS = 30_000; // 30s — anything above this is considered slow
  const latencyScore = Math.max(0, 1 - p99 / LATENCY_CEILING_MS);

  // Weighted average: success rate is the primary signal, latency is secondary.
  // Avoids multiplicative amplification where dual-axis degradation causes false negatives.
  const SUCCESS_WEIGHT = 0.7;
  const LATENCY_WEIGHT = 0.3;
  return SUCCESS_WEIGHT * successRate + LATENCY_WEIGHT * latencyScore;
}

/**
 * Compute health scores for multiple providers.
 * Returns a Map of provider name → health score (0-1).
 */
export function getAllHealthScores(providerNames: string[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const name of providerNames) {
    scores.set(name, getHealthScore(name));
  }
  return scores;
}
