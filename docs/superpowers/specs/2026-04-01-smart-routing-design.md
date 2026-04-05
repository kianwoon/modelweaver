# Smart Request-to-Model-Tier Classification

> Issue: #97 | Date: 2026-04-01

## Summary

Add keyword-scoring classifier as a **first gate** before existing routing. If patterns match, route to the classified tier. If no match, pass through to existing distribution/fallback unchanged.

## Motivation

Currently ModelWeaver routes purely by name-based matching (`modelRouting` exact match, `tierPatterns` substring match). A casual "hello" and a "debug this architecture" get routed identically. This wastes expensive models on simple requests and misses opportunities to use better models for complex tasks.

## Design

### Request Flow

```
Request arrives
  │
  ├─ smartRouting enabled?
  │   ├─ YES → classify(lastMessage, patterns)
  │   │        ├─ tier match → resolveRequest() with that tier
  │   │        └─ no match  → resolveRequest() as normal
  │   └─ NO  → resolveRequest() as normal
  │
  └─ Existing: weight distribution → fallback chain → circuit breaker
```

Smart routing is a **gate** — it does not replace existing routing. When it fires, the result feeds into the existing weight/fallback/circuit-breaker pipeline.

### Tier System

Numeric tiers assigned to providers in config:

| Tier | Meaning | Example |
|------|---------|---------|
| 1 | Best (most capable) | Claude Opus |
| 2 | Good | Claude Sonnet |
| 3 | OK / default | Claude Haiku |

### Config Schema

```yaml
smartRouting:
  enabled: true
  escalationThreshold: 3
  patterns:
    tier1:
      - pattern: "architect|design system|from scratch"
        score: 3
      - pattern: "debug|troubleshoot|investigate|root cause"
        score: 2
      - pattern: "analyze.*reason|explain why|step.by.step"
        score: 2
    tier2:
      - pattern: "explain|summarize|compare"
        score: 2
      - pattern: "write.*test|refactor|review"
        score: 2
    # tier3 = default (no patterns needed)

providers:
  anthropic-opus:
    tier: 1
    baseUrl: https://api.anthropic.com
    apiKey: ...
  anthropic-sonnet:
    tier: 2
    baseUrl: https://api.anthropic.com
    apiKey: ...
  anthropic-haiku:
    tier: 3
    baseUrl: https://api.anthropic.com
    apiKey: ...

routing:
  tier1:
    - provider: anthropic-opus
  tier2:
    - provider: anthropic-sonnet
      weight: 70
    - provider: openrouter-sonnet
      weight: 30
  tier3:
    - provider: anthropic-haiku
```

### Classifier Logic

Pure function in `src/classifier.ts`:

1. Pre-compiled regex patterns at config load time — zero runtime compilation cost
2. Check tier1 patterns first (highest priority), then tier2
3. Sum scores within each tier
4. If score >= `escalationThreshold` → return that tier number
5. No match → return `null` (pass through to existing routing)
6. Analyzes only the last user message content

```typescript
export function classifyTier(
  lastMessage: string,
  config: SmartRoutingConfig
): number | null
```

### Metrics

Three counters added to `src/metrics.ts`:

- `smart_routing_tier1_total` — requests escalated to tier 1
- `smart_routing_tier2_total` — requests escalated to tier 2
- `smart_routing_passthrough_total` — requests that matched no patterns

## File Changes

### New Files

| File | Purpose | Size |
|------|---------|------|
| `src/classifier.ts` | Pure classification function | ~50 lines |
| `tests/classifier.test.ts` | Unit tests | ~80 lines |

### Modified Files

| File | Change |
|------|--------|
| `src/types.ts` | Add `tier` field to `ProviderConfig`, add `SmartRoutingConfig` and `ClassificationRule` interfaces |
| `src/config.ts` | Parse `smartRouting` section from YAML, pre-compile regex patterns |
| `src/router.ts` | Accept optional `overrideTier` param in `resolveRequest()`, add tier-number-based provider lookup |
| `src/server.ts` | Call classifier before `resolveRequest()`, pass classified tier through |
| `src/metrics.ts` | Add three classification counters |

## Key Decisions

1. **Always overrides** — when smart routing triggers, it wins over explicit `modelRouting` exact match
2. **Numeric tiers** — 1 (best), 2 (good), 3 (ok/default)
3. **Last message only** — classify the last user message, not full conversation
4. **Counter-only metrics** — no detailed logging per classification
5. **Graceful degradation** — if classified tier has no providers, fall to next lower tier
6. **Non-breaking** — disabled or no-match = identical behavior to current
