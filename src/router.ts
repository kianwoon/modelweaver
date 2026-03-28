// src/router.ts
import type { RoutingEntry, AppConfig, RequestContext } from "./types.js";

const ROUTING_CACHE_MAX_SIZE = 200;

interface RoutingCacheEntry {
  tier: string;
  providerChain: RoutingEntry[];
}

/**
 * LRU cache for model-to-(tier, providerChain) lookups.
 * Map insertion order serves as LRU ordering (first = oldest).
 */
const routingCache = new Map<string, RoutingCacheEntry>();

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

/**
 * Select a provider by weight for distribution routing.
 * Returns a reordered array: [selected, ...remaining as fallback].
 * Excludes circuit-opened providers and re-normalizes weights.
 * Falls back to original chain if all providers are circuit-opened.
 */
export function selectByWeight(
  entries: RoutingEntry[],
  openCircuitProviders: string[]
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

  // Calculate total weight of available providers
  const totalWeight = available.reduce((sum, e) => sum + (e.weight ?? 0), 0);
  if (totalWeight <= 0) return entries;

  // Weighted random selection
  const rand = Math.random() * totalWeight;
  let cumulative = 0;
  let selectedIndex = 0;

  for (let i = 0; i < available.length; i++) {
    cumulative += available[i].weight ?? 0;
    if (rand < cumulative) {
      selectedIndex = i;
      break;
    }
  }

  // Build result: [selected, ...remaining as fallback]
  const selected = available[selectedIndex];
  const fallback = available.filter((_, i) => i !== selectedIndex);

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
    providerChain = selectByWeight(providerChain, openCircuits);
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
  };
}
