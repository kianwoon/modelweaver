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
 * Build a RequestContext from an incoming model name and raw body.
 * Priority 1: exact model name match in modelRouting.
 * Priority 2: substring match via tierPatterns.
 * Uses an LRU cache to skip repeated resolution for the same model.
 * Returns null if no route matches.
 */
export function resolveRequest(
  model: string,
  requestId: string,
  config: AppConfig,
  rawBody: string
): RequestContext | null {
  // Check LRU cache first
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

  let tier: string;
  let providerChain: RoutingEntry[];

  // Priority 1: exact model name match in modelRouting
  const modelChain = config.modelRouting.get(model);
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

  // Cache the resolved tier + providerChain
  if (routingCache.size >= ROUTING_CACHE_MAX_SIZE) {
    // Evict the oldest entry (first key in Map)
    const oldestKey = routingCache.keys().next().value;
    if (oldestKey !== undefined) routingCache.delete(oldestKey);
  }
  routingCache.set(model, { tier, providerChain });

  return {
    requestId,
    model,
    tier,
    providerChain,
    startTime: Date.now(),
    rawBody,
  };
}
