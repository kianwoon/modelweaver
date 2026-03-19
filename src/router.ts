// src/router.ts
import type { RoutingEntry, AppConfig, RequestContext } from "./types.js";

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
 * Returns null if no tier matches.
 */
export function resolveRequest(
  model: string,
  requestId: string,
  config: AppConfig,
  rawBody: string
): RequestContext | null {
  const tier = matchTier(model, config.tierPatterns);
  if (!tier) return null;

  return {
    requestId,
    model,
    tier,
    providerChain: buildRoutingChain(tier, config.routing),
    startTime: Date.now(),
    rawBody,
  };
}
