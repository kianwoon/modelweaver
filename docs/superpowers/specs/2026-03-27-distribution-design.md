# Distribution Feature — Design Spec

**Date:** 2026-03-27
**Status:** Approved
**Approach:** Router-Level Weighted Selection (Approach A)

---

## Summary

Allow users to specify traffic distribution percentages across providers for the same model. When distribution is enabled, each request is randomly routed to a provider based on configured weights. If the selected provider fails, remaining providers serve as a fallback chain.

## Motivation

Currently, ModelWeaver routes all traffic for a model through an ordered fallback chain (primary → backup → backup). Users want to distribute traffic across multiple providers — e.g., 50% to GLM, 30% to MiniMax, 20% to OpenRouter — for cost optimization, load balancing, or provider evaluation.

## Config Schema

### New YAML Format

```yaml
modelRouting:
  "glm-5-turbo":
    - provider: glm
      weight: 50
    - provider: minimax
      model: MiniMax-M2.7
      weight: 30
    - provider: openrouter
      weight: 20
```

### Rules

- `weight` field is **optional** on `RoutingEntry`
- When **any** entry in a model's routing has a `weight`, distribution mode activates for that model
- All entries in a distribution model **must** have weights (mixed weighted/unweighted is a validation error)
- Weights **auto-normalize** if they don't sum to 100 (e.g., `3 + 7` = 30%/70%)
- At least 2 weighted entries required
- Weight value must be > 0
- Backward compatible: no weight = existing ordered fallback

### Zod Schema Change

```typescript
// src/config.ts — routingEntrySchema
const routingEntrySchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  weight: z.number().positive().optional(),
});
```

### Validation

- If any entry has `weight`, all entries for that model must have `weight`
- Sum of weights must be > 0
- Minimum 2 entries when distribution is active

## Selection Algorithm

Implemented in `src/router.ts`:

```
function selectByWeight(entries: RoutingEntry[]): RoutingEntry[] {
  1. Filter out circuit-opened providers
  2. If all providers circuit-opened, return original chain (fallback to all)
  3. Re-normalize weights of remaining providers
  4. Generate random number in [0, totalWeight)
  5. Select provider via cumulative weight
  6. Return: [selected, ...remaining as fallback chain]
}
```

The function returns a reordered array — selected provider first, rest as fallback. This feeds directly into the existing `forwardWithFallback()` pipeline.

### Integration Point

In `resolveRequest()` (src/router.ts):

```
if (chain has weights) {
  chain = selectByWeight(chain);
  ctx.fallbackMode = "sequential"; // Override to sequential for distributed models
}
return chain;
```

## Circuit Breaker Integration

When a provider's circuit breaker is open:
- **Exclude** it from the distribution pool
- **Re-normalize** remaining weights dynamically
- If **all** providers are circuit-opened, fall back to original chain (all providers, ordered)

This means if GLM (weight 50) goes down, MiniMax effectively gets 60% and OpenRouter gets 40%.

## Adaptive Hedging

**Disable** adaptive hedging when distribution is active. Distribution already spreads load across providers, so sending redundant copies to the same provider is wasteful.

Guard in `src/proxy.ts`:
```
if (ctx.hasDistribution) skip hedging
```

## Racing

**Disable** staggered racing when distribution is active. Distribution + racing would cause request explosion (multiple providers started simultaneously × racing delays).

Use **sequential fallback only** for distributed models.

## GUI Changes

### Config Panel Updates

- When adding/editing a model routing entry, show a "Weight" input field
- Toggle or visual indicator showing "Distribution Mode" is active for a model
- Show effective percentages (after normalization) next to each entry
- Validation feedback if weights are invalid

### Monitor Panel Updates

- Show per-provider request count for distributed models
- Display actual vs. configured distribution percentages

## Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `weight?: number` to `RoutingEntry`, add `hasDistribution?: boolean` to `RequestContext` |
| `src/config.ts` | Add `weight` to Zod schema, add validation logic, expose `hasDistribution` per model |
| `src/router.ts` | Add `selectByWeight()`, modify `resolveRequest()` |
| `src/proxy.ts` | Skip hedging/racing when distribution active |
| `gui/frontend/` | Weight input UI, distribution mode indicator, per-provider metrics |
| `modelweaver.example.yaml` | Add distribution example |

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Distribution + fallback + racing = request explosion | Medium | Disable racing when distribution active |
| Non-deterministic debugging | Low | Log selected provider per request (already partially done) |
| Weight config errors (sum=0, negative) | Low | Zod validation + auto-normalize |
| All providers circuit-opened | Medium | Fall back to original chain |

## Estimated Effort

- Core logic (types, config, router, proxy guard): ~1 day
- Tests: ~0.5 day
- GUI updates: ~1 day
- Total: ~2.5 days
