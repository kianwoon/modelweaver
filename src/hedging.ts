/**
 * Adaptive request hedging — sends multiple copies of a request when
 * the provider shows high latency variance, returning the fastest response.
 */

import type { ProviderConfig } from './types.js';

interface LatencySample {
  ttfbMs: number;
  timestamp: number;
}

export class LatencyTracker {
  private samples = new Map<string, LatencySample[]>();
  private readonly maxSize: number;
  private readonly MAX_PROVIDERS = 50;

  constructor(maxSize = 30) {
    this.maxSize = maxSize;
  }

  record(provider: string, ttfbMs: number): void {
    // Cap total tracked providers to prevent unbounded growth
    if (this.samples.size >= this.MAX_PROVIDERS && !this.samples.has(provider)) {
      // Remove the first (oldest) provider key
      const firstKey = this.samples.keys().next().value;
      if (firstKey !== undefined) this.samples.delete(firstKey);
    }

    let window = this.samples.get(provider);
    if (!window) {
      window = [];
      this.samples.set(provider, window);
    }
    window.push({ ttfbMs, timestamp: Date.now() });
    const excess = window.length - this.maxSize;
    if (excess > 0) {
      window.splice(0, excess);
    }
  }

  /** Coefficient of variation (stddev / mean). Returns 0 if insufficient data. */
  getCV(provider: string): number {
    const window = this.samples.get(provider);
    if (!window || window.length < 5) return 0;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < window.length; i++) {
      sum += window[i].ttfbMs;
      sumSq += window[i].ttfbMs * window[i].ttfbMs;
    }
    const mean = sum / window.length;
    if (mean === 0) return 0;
    const variance = sumSq / window.length - mean * mean;
    return Math.sqrt(Math.max(0, variance)) / mean;
  }

  getStats(provider: string): { count: number; mean: number; cv: number } {
    const window = this.samples.get(provider);
    if (!window || window.length === 0) return { count: 0, mean: 0, cv: 0 };
    let sum = 0;
    for (let i = 0; i < window.length; i++) sum += window[i].ttfbMs;
    const mean = sum / window.length;
    // Inline CV without calling getCV (avoids second loop)
    if (window.length < 5) {
      return { count: window.length, mean: Math.round(mean), cv: 0 };
    }
    let sumSq = 0;
    for (let i = 0; i < window.length; i++) sumSq += window[i].ttfbMs * window[i].ttfbMs;
    const variance = sumSq / window.length - mean * mean;
    const cv = mean > 0 ? Math.sqrt(Math.max(0, variance)) / mean : 0;
    return { count: window.length, mean: Math.round(mean), cv: Math.round(cv * 100) / 100 };
  }

  clear(provider: string): void {
    this.samples.delete(provider);
  }

  /** Remove entries for providers no longer in the current config. */
  prune(activeProviders: string[]): void {
    const active = new Set(activeProviders);
    for (const key of this.samples.keys()) {
      if (!active.has(key)) {
        this.samples.delete(key);
      }
    }
  }
}

export class InFlightCounter {
  private counts = new Map<string, number>();

  increment(provider: string): number {
    const count = (this.counts.get(provider) ?? 0) + 1;
    this.counts.set(provider, count);
    return count;
  }

  decrement(provider: string): number {
    const count = Math.max(0, (this.counts.get(provider) ?? 0) - 1);
    this.counts.set(provider, count);
    return count;
  }

  get(provider: string): number {
    return this.counts.get(provider) ?? 0;
  }
}

export const latencyTracker = new LatencyTracker();
export const inFlightCounter = new InFlightCounter();

/**
 * Compute adaptive hedging count based on latency variance and available concurrency.
 *
 * CV (coefficient of variation) drives the count:
 *   CV < 0.5  → 1 (no hedge, provider is consistent)
 *   CV 0.5-0.99 → 2 copies
 *   CV 1.0-1.49  → 3 copies
 *   CV 1.5+       → 4 copies (capped)
 *
 * Clamped by available concurrency slots: maxConcurrent - inFlight.
 * Calibration note: production data shows glm/minimax have CV 1.5-4.0 (extreme tail variance),
 * so hedging is warranted. CV threshold of 0.5 prevents over-hedging on stable runs.
 */
export function computeHedgingCount(provider: ProviderConfig): number {
  const cv = latencyTracker.getCV(provider.name);
  const inFlight = inFlightCounter.get(provider.name);
  const maxConcurrent = provider.concurrentLimit ?? 1;
  const available = Math.max(1, maxConcurrent - inFlight);

  const cvThreshold = 0.5;
  const maxHedge = 4;

  if (cv < cvThreshold) return 1;

  // Linear scale: cv=0.5 → 2 copies, cv=1.0 → 3, cv=1.5+ → 4
  const adaptive = Math.min(maxHedge, Math.floor((cv - cvThreshold) * 2 + 2));
  return Math.max(1, Math.min(adaptive, available));
}

// --- Hedge win/loss tracking ---

const hedgeWins = new Map<string, number>();
const hedgeLosses = new Map<string, number>();

export function recordHedgeWin(provider: string): void {
  hedgeWins.set(provider, (hedgeWins.get(provider) ?? 0) + 1);
}

export function recordHedgeLosses(provider: string, count: number): void {
  hedgeLosses.set(provider, (hedgeLosses.get(provider) ?? 0) + count);
}

export function getHedgeStats(provider: string): { hedgeWins: number; hedgeLosses: number } {
  return {
    hedgeWins: hedgeWins.get(provider) ?? 0,
    hedgeLosses: hedgeLosses.get(provider) ?? 0,
  };
}

/** Clear all hedge win/loss stats. Called on config hot-reload. */
export function clearHedgeStats(): void {
  hedgeWins.clear();
  hedgeLosses.clear();
}
