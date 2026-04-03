// src/router.ts
import type { RoutingEntry, AppConfig, RequestContext } from "./types.js";
import { getAllHealthScores } from "./health-score.js";

const ROUTING_CACHE_MAX_SIZE = 200;

/**
 * Minimum duration (ms) that global backoff persists after triggering,
 * even if health data ages out. Prevents oscillation where health events
 * expire during retry-after → score returns to 1 → traffic resumes → fails again.
 */
const GLOBAL_BACKOFF_MIN_DURATION_MS = 60_000; // 60 seconds

/** Health score threshold below which a provider gets deprioritized in fallback chains. */
const UNHEALTHY_THRESHOLD = 0.5;

/**
 * Reorder a fallback chain based on real-time health scores.
 *
 * Providers scoring below UNHEALTHY_THRESHOLD are moved to the end of the chain,
 * while preserving relative order among healthy and unhealthy groups.
 * Circuit-opened providers are NOT filtered here (that's done separately
 * in resolveRequest/selectByWeight).
 *
 * This ensures that when a provider like GLM is having a bad day (50%+ failure rate),
 * healthier providers get tried first, while still available as fallback.
 *
 * When no health data exists (< 5 events), returns the original chain unchanged.
 */
function reorderChainByHealth(
  entries: RoutingEntry[],
): RoutingEntry[] {
  const providerNames = entries.map(e => e.provider);
  const scores = getAllHealthScores(providerNames);

  // Check if we have meaningful health data for any provider
  let hasHealthData = false;
  for (const score of scores.values()) {
    if (score < 1) { hasHealthData = true; break; }
  }
  if (!hasHealthData) return entries;

  const healthy: RoutingEntry[] = [];
  const unhealthy: RoutingEntry[] = [];

  for (const entry of entries) {
    const score = scores.get(entry.provider) ?? 1;
    if (score < UNHEALTHY_THRESHOLD) {
      unhealthy.push(entry);
    } else {
      healthy.push(entry);
    }
  }

  // If all are healthy or all unhealthy, preserve original order
  if (healthy.length === 0 || unhealthy.length === 0) return entries;

  // Within each group, sort by health score descending (healthiest first)
  healthy.sort((a, b) => (scores.get(b.provider) ?? 1) - (scores.get(a.provider) ?? 1));
  unhealthy.sort((a, b) => (scores.get(b.provider) ?? 1) - (scores.get(a.provider) ?? 1));

  return [...healthy, ...unhealthy];
}

interface RoutingCacheEntry {
  tier: string;
  providerChain: RoutingEntry[];
}

/**
 * LRU cache for model-to-(tier, providerChain) lookups.
 * Map insertion order serves as LRU ordering (first = oldest).
 */
const routingCache = new Map<string, RoutingCacheEntry>();

/** Tracks when global backoff was last triggered to prevent oscillation. */
let lastGlobalBackoffAt = 0;

export function resetGlobalBackoffState(): void {
  lastGlobalBackoffAt = 0;
}

/**
 * Invalidate the routing cache. Called on config hot-reload.
 */
export function clearRoutingCache(): void {
  routingCache.clear();
}

/**
 * Match a model name to a tier using case-sensitive substring matching.
 * First tier whose patterns contain any match wins (config order = priority).
 */
export function matchTier(
  modelName: string,
  tierPatterns: Map<string, string[]>
): string | null {
  for (const [tier, patterns] of tierPatterns) {
    for (const pattern of patterns) {
      if (modelName.includes(pattern)) {
        return tier;
      }
    }
  }
  return null;
}

/**
 * Get the ordered routing chain for a tier.
 */
export function buildRoutingChain(
  tier: string,
  routing: Map<string, RoutingEntry[]>
): RoutingEntry[] {
  return routing.get(tier) || [];
}

/** Blend factor: how much dynamic health score influences final weight. */
const HEALTH_BLEND_DYNAMIC = 0.3;

/**
 * Select a provider by weight for distribution routing.
 * Returns a reordered array: [selected, ...remaining as fallback].
 * Excludes circuit-opened providers and re-normalizes weights.
 * Falls back to original chain if all providers are circuit-opened.
 *
 * Health-weighted blending: finalWeight = (1-α)*static + α*healthScore
 * where α = 0.3 (30% dynamic, 70% static).
 */
export function selectByWeight(
  entries: RoutingEntry[],
  openCircuitProviders: string[],
  healthScores?: Map<string, number>
): RoutingEntry[] {
  // If no weights present, return original chain unchanged
  if (!entries.some(e => e.weight !== undefined)) {
    return entries;
  }

  // Filter out circuit-opened providers (O(1) Set lookup vs O(n) array includes)
  const openSet = new Set(openCircuitProviders);
  const available = entries.filter(
    e => !openSet.has(e.provider)
  );

  // If all providers are circuit-opened, return original chain
  if (available.length === 0) {
    return entries;
  }

  // Filter out zero/negative weight entries to avoid degenerate weighted selection
  const selectable = available.filter(e => (e.weight ?? 0) > 0);
  if (selectable.length === 0) return entries;

  // Blend static weights with health scores: finalWeight = (1-α)*static + α*health
  const blendedWeights = selectable.map(e => {
    const staticWeight = e.weight ?? 1;
    if (!healthScores) return staticWeight;
    const healthScore = healthScores.get(e.provider) ?? 1; // assume healthy if no data
    return (1 - HEALTH_BLEND_DYNAMIC) * staticWeight + HEALTH_BLEND_DYNAMIC * healthScore;
  });

  // Calculate total blended weight
  const totalWeight = blendedWeights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) return entries;

  // Weighted random selection
  const rand = Math.random() * totalWeight;
  let cumulative = 0;
  let selectedIndex = 0;

  for (let i = 0; i < selectable.length; i++) {
    cumulative += blendedWeights[i];
    if (rand < cumulative) {
      selectedIndex = i;
      break;
    }
  }

  // Build result: [selected, ...remaining as fallback]
  const selected = selectable[selectedIndex];
  const fallback = selectable.filter((_, i) => i !== selectedIndex);

  return [selected, ...fallback];
}

/**
 * Build a RequestContext from an incoming model name and raw body.
 * Priority 1: exact model name match in modelRouting.
 * Priority 2: substring match via tierPatterns.
 * Uses an LRU cache to skip repeated resolution for the same model.
 * Distribution models bypass the cache (need fresh random selection).
 * Returns null if no route matches.
 */
export function resolveRequest(
  model: string,
  requestId: string,
  config: AppConfig,
  rawBody: string
): RequestContext | null {
  // Check if this model uses distribution — skip cache for distribution models
  const modelChain = config.modelRouting.get(model);
  const isDistributed = modelChain?.some(e => e.weight !== undefined) ?? false;

  // Check LRU cache first (skip for distribution models — need fresh random selection)
  if (!isDistributed) {
    const cached = routingCache.get(model);
    if (cached) {
      // Move to most-recently-used position (delete + re-insert)
      routingCache.delete(model);
      routingCache.set(model, cached);
      return {
        requestId,
        model,
        tier: cached.tier,
        providerChain: cached.providerChain,
        startTime: Date.now(),
        rawBody,
      };
    }
  }

  let tier: string;
  let providerChain: RoutingEntry[];

  // Priority 1: exact model name match in modelRouting
  if (modelChain && modelChain.length > 0) {
    tier = "(modelRouting)";
    providerChain = modelChain;
  } else {
    // Priority 2: substring match via tierPatterns (existing behavior)
    const matchedTier = matchTier(model, config.tierPatterns);
    if (!matchedTier) return null;
    tier = matchedTier;
    providerChain = buildRoutingChain(tier, config.routing);
  }

  // Health-aware reordering: sort fallback chain so unhealthy providers
  // get deprioritized to the end. This applies to ALL routing modes
  // (fixed chains + distribution), not just weighted models.
  if (providerChain.length > 1) {
    providerChain = reorderChainByHealth(providerChain);
  }

  // Global backoff: if ALL providers are unhealthy, skip the chain entirely
  // and return 503 immediately. Configurable via server.globalBackoffEnabled
  // and server.unhealthyThreshold.
  const globalBackoffEnabled = config.server.globalBackoffEnabled !== false;
  const unhealthyThreshold = config.server.unhealthyThreshold ?? UNHEALTHY_THRESHOLD;
  let globalBackoff = false;
  const allScores = getAllHealthScores(providerChain.map(e => e.provider));
  let hasHealthData = false;
  for (const score of allScores.values()) {
    if (score < 1) { hasHealthData = true; break; }
  }
  if (hasHealthData && globalBackoffEnabled) {
    const allUnhealthy = providerChain.every(
      e => (allScores.get(e.provider) ?? 1) < unhealthyThreshold
    );
    if (allUnhealthy) {
      globalBackoff = true;
      lastGlobalBackoffAt = Date.now();
    }
  }

  // Prevent oscillation: if global backoff was recently triggered, stay in backoff
  // even if health data aged out (fewer than 5 events → score returns to 1).
  if (!globalBackoff && globalBackoffEnabled && lastGlobalBackoffAt > 0) {
    const elapsed = Date.now() - lastGlobalBackoffAt;
    if (elapsed < GLOBAL_BACKOFF_MIN_DURATION_MS) {
      globalBackoff = true;
    }
  }

  // Apply distribution if weights are present
  let hasDistribution = false;
  if (providerChain.some(e => e.weight !== undefined)) {
    hasDistribution = true;
    // Collect circuit-opened providers
    const openCircuits: string[] = [];
    for (const entry of providerChain) {
      const provider = config.providers.get(entry.provider);
      if (provider?._circuitBreaker?.canProceed()?.allowed === false) {
        openCircuits.push(entry.provider);
      }
    }
    providerChain = selectByWeight(providerChain, openCircuits, getAllHealthScores(
      providerChain.map(e => e.provider)
    ));
  }

  // Cache the resolved tier + providerChain (only for non-distribution)
  if (!hasDistribution) {
    if (routingCache.size >= ROUTING_CACHE_MAX_SIZE) {
      // Evict the oldest entry (first key in Map)
      const oldestKey = routingCache.keys().next().value;
      if (oldestKey !== undefined) routingCache.delete(oldestKey);
    }
    routingCache.set(model, { tier, providerChain });
  }

  return {
    requestId,
    model,
    tier,
    providerChain,
    startTime: Date.now(),
    rawBody,
    hasDistribution,
    fallbackMode: hasDistribution ? "sequential" : undefined,
    _globalBackoff: globalBackoff,
  };
}
