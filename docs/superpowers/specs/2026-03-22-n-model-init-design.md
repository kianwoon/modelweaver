# N-Model Init Redesign

**Date**: 2026-03-22
**Status**: Approved

## Problem

The init wizard (`modelweaver init`) is hardcoded to 3 model tiers (sonnet, opus, haiku). Users cannot configure more than 3 models, and `availableModels` is never populated in settings.json.

The proxy already supports N-model routing via `modelRouting` (exact name match in `router.ts:resolveRequest()`). The bottleneck is entirely in the init wizard.

## Decision

**Remove tier concept entirely.** Replace with pure N-model configuration where each model has:
- A user-chosen alias (e.g., `glm-5-turbo`, `MiniMax-M2.7`, `fast`)
- A provider reference (which provider to route to)
- An actual model name (what to send to the provider's API)

No tier env vars. No routing/tierPatterns in YAML. Just `modelRouting`.

## Scope

### Files Changed

1. **`src/init.ts`** — Major redesign of model configuration flow
2. **`src/settings.ts`** — Add `availableModels` to `SettingsWriteOptions` and `mergeSettings()`

### Files NOT Changed

- `src/router.ts` — Already supports N models via `modelRouting`
- `src/config.ts` — `modelRouting` schema already exists
- `src/types.ts` — No changes needed
- `src/proxy.ts` — No changes needed

## Design

### New Wizard Flow

```
1. Select providers (unchanged)
2. Configure API keys for each provider (unchanged)
3. Configure models (NEW — replaces routing step):
   - Loop: Add model → alias + provider + model name → "Add another?"
4. Server config (unchanged)
5. Claude Code settings:
   - Default model: select from configured models
   - availableModels: auto-populated with all aliases
6. Review & confirm (unchanged)
```

### Settings Output

```json
{
  "env": { "ANTHROPIC_BASE_URL": "http://localhost:3456" },
  "model": "glm-5-turbo",
  "availableModels": ["glm-5-turbo", "MiniMax-M2.7", "opusplan"]
}
```

### YAML Output

```yaml
modelRouting:
  glm-5-turbo:
    - provider: openrouter
      model: glm-5-turbo
  MiniMax-M2.7:
    - provider: minimax
      model: M2.7
  opusplan:
    - provider: minimax
      model: M2.7
```

No `routing` or `tierPatterns` sections.

## Implementation Details

### 1. `src/settings.ts`

**`SettingsWriteOptions`** — add `availableModels?: string[]`

**`mergeSettings()`** — when `options.availableModels` is provided, set `result.availableModels`. Merge with any existing user entries to avoid clobbering.

### 2. `src/init.ts`

**New types:**
```typescript
interface ConfiguredModel {
  alias: string;       // user-facing name for /model and availableModels
  provider: string;    // provider ID
  model: string;       // actual model name sent to provider API
}
```

**New function: `configureModels(providers)`**
- Replaces `configureRouting()`
- Loop: prompt for alias → select provider → enter model name (pre-filled from preset)
- Auto-populate at least one model per provider initially
- "Add another?" loop
- Returns `ConfiguredModel[]`

**Updated `buildYamlConfig()`**
- Write only `modelRouting` from `ConfiguredModel[]`
- No `routing` or `tierPatterns` sections
- Keep `server` and `providers` sections unchanged

**Updated `configureClaudeCodeSettings()`**
- Input: `ConfiguredModel[]` instead of routing tiers
- Select default model from all configured models
- Auto-populate `availableModels` from all model aliases
- Remove tier mapping step entirely
- No tier env vars

**Updated `SettingsConfig`**
```typescript
interface SettingsConfig {
  defaultModel: string;
  availableModels: string[];
}
```

**Updated `buildSummaryTable()`**
- Show N models instead of fixed 3 tiers
- Format: `alias → provider → model`

**Updated `writeConfigAndSettings()`**
- Pass `availableModels` to `mergeSettings()`
- Update console output to show `availableModels`

**Updated `runQuickInit()`**
- Auto-configure models from single provider's presets (as aliases)
- No tier routing step

**Removed functions:**
- `configureRouting()` — replaced by `configureModels()`
- `autoRoutingForSingleProvider()` — replaced by auto-model-config in `configureModels()`
- `collectAvailableModels()` — replaced by direct use of `ConfiguredModel[]`

**Updated `calculateTotalSteps()`**
- Remove the `+3` for routing tiers
- Model config step counts as 1 (it's a loop internally)
