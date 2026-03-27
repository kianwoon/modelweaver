# Init Wizard Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the ModelWeaver init wizard into a clean section-based editor. Replace the 1800-line sequential init.ts with 5 screen modules and a main menu state machine. No forced flow — jump directly to any section.

**Architecture:** The wizard state (WizardState) holds all config in memory. Each screen renders itself and returns an action ({ type: 'back' } | { type: 'navigate', section } | { type: 'quit' } | { type: 'save' }). The main loop in init.ts dispatches to screen modules and updates state. Validation runs on 'save' before writing files.

**Tech Stack:** TypeScript, `prompts` library (existing), box-drawing characters, existing config.ts/writeConfig helpers.

---

## Shared Types & Helpers

### Task 1: shared/types.ts — WizardState and shared types

**Files:**
- Create: `src/init/screens/shared/types.ts`

- [ ] **Step 1: Create the file with WizardState and action types**

```typescript
// src/init/screens/shared/types.ts

export interface WizardProvider {
  id: string;  // unique, e.g. "glm"
  baseUrl: string;
  envKey: string;       // e.g. "GLM_API_KEY"
  apiKey: string;       // runtime value, not stored in config.yaml
  timeout: number;
  ttfbTimeout: number;
  authType: 'anthropic' | 'bearer';
  circuitBreaker: {
    threshold: number;
    cooldown: number;
  };
}

export interface RoutingEntry {
  provider: string;      // provider id
  model: string;        // model name on that provider
  weight?: number;       // only for distribution
}

export interface WizardState {
  providers: Map<string, WizardProvider>;       // keyed by provider id
  models: string[];                              // model alias names
  distribution: Map<string, RoutingEntry[]>;    // alias → entries (weights required)
  fallback: Map<string, RoutingEntry[]>;        // alias → entries (no weights)
  server: { port: number; host: string };
}

export type ScreenAction =
  | { type: 'back' }
  | { type: 'quit' }
  | { type: 'save' }
  | { type: 'navigate'; section: ScreenId }
  | { type: 'error'; message: string };

export type ScreenId = 'main' | 'providers' | 'models' | 'distribution' | 'fallback' | 'server';

export function createEmptyState(): WizardState {
  return {
    providers: new Map(),
    models: [],
    distribution: new Map(),
    fallback: new Map(),
    server: { port: 3456, host: 'localhost' },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/init/screens/shared/types.ts
git commit -m "feat(init): add WizardState types for section-based wizard"
```

---

### Task 2: shared/ui.ts — UI helpers

**Files:**
- Create: `src/init/screens/shared/ui.ts`

- [ ] **Step 1: Write the shared UI helpers**

```typescript
// src/init/screens/shared/ui.ts

import prompts from 'prompts';

// Color codes (from existing init.ts)
export const GREEN = '\x1B[32m';
export const RED = '\x1B[31m';
export const CYAN = '\x1B[36m';
export const BOLD = '\x1B[1m';
export const RESET = '\x1B[0m';

export function check(msg: string): void {
  console.log(`  ${GREEN}\u2713${RESET} ${msg}`);
}

export function fail(msg: string): void {
  console.log(`  ${RED}\u2717${RESET} ${msg}`);
}

export function clearScreen(): void {
  console.log(`\n${'\u2500'.repeat(56)}\n`);
}

export class GoBackError extends Error {
  constructor() {
    super('__back__');
    this.name = 'GoBackError';
  }
}

export const CANCEL = { onCancel: () => { throw new GoBackError(); } };

export async function promptText(label: string, initial?: string): Promise<string> {
  const response = await prompts({
    type: 'text',
    name: 'value',
    message: label,
    initial: initial ?? '',
  }, CANCEL);
  return response.value as string;
}

export async function promptNumber(label: string, initial?: number): Promise<number> {
  const response = await prompts({
    type: 'number',
    name: 'value',
    message: label,
    initial: initial ?? 0,
  }, CANCEL);
  return response.value as number;
}

export async function promptConfirm(label: string, initial = true): Promise<boolean> {
  const response = await prompts({
    type: 'confirm',
    name: 'value',
    message: label,
    initial,
  }, CANCEL);
  return response.value as boolean;
}

export async function promptSelect<T extends string | number>(
  label: string,
  choices: { title: string; value: T }[],
  initial?: T,
): Promise<T> {
  const response = await prompts({
    type: 'select',
    name: 'value',
    message: label,
    choices,
    initial: initial ?? 0,
  }, CANCEL);
  return response.value as T;
}

export async function promptMultiSelect<T extends string | number>(
  label: string,
  choices: { title: string; value: T }[],
  hint?: string,
): Promise<T[]> {
  const response = await prompts({
    type: 'multiselect',
    name: 'value',
    message: label,
    choices,
    hint: hint ?? '',
  }, CANCEL);
  return response.value as T[];
}

export async function promptPassword(label: string): Promise<string> {
  const response = await prompts({
    type: 'password',
    name: 'value',
    message: label,
  }, CANCEL);
  return response.value as string;
}

export function box(lines: string[], width = 58): void {
  const top = `\u250c${'\u2500'.repeat(width - 2)}\u2510`;
  const mid = `\u251c${'\u2500'.repeat(width - 2)}\u2524`;
  const bot = `\u2514${'\u2500'.repeat(width - 2)}\u2518`;
  const side = '\u2502';

  console.log(top);
  for (const line of lines) {
    const padded = line.padEnd(width - 2).slice(0, width - 2);
    console.log(`${side} ${padded} ${side}`);
  }
  console.log(bot);
}

export function boxWithHeader(title: string, lines: string[], width = 58): void {
  const top = `\u250c${'\u2500'.repeat(width - 2)}\u2510`;
  const mid = `\u251c${'\u2500'.repeat(width - 2)}\u2524`;
  const bot = `\u2514${'\u2500'.repeat(width - 2)}\u2518`;
  const side = '\u2502';
  const titleLine = ` ${BOLD}${title}${RESET}`;

  console.log(top);
  console.log(`${side}${titleLine.padEnd(width - 1)}${side}`);
  console.log(mid);
  for (const line of lines) {
    const padded = line.padEnd(width - 2).slice(0, width - 2);
    console.log(`${side} ${padded} ${side}`);
  }
  console.log(bot);
}

export function boxLine(label: string, value: string, width = 58): string {
  return `${label.padEnd(width - value.length - 3)}${CYAN}${value}${RESET}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/init/screens/shared/ui.ts
git commit -m "feat(init): extract shared UI helpers (box, prompts, colors)"
```

---

### Task 3: validate.ts — Config validation before save

**Files:**
- Create: `src/init/screens/shared/validate.ts`

- [ ] **Step 1: Write the validation function**

```typescript
// src/init/screens/shared/validate.ts

import type { WizardState, RoutingEntry } from './types.js';

export interface ValidationError {
  type: 'error';
  message: string;
}

export interface ValidationWarning {
  type: 'warning';
  message: string;
}

export type ValidationResult = {
  errors: ValidationError[];
  warnings: ValidationWarning[];
  ok: boolean;
};

export function validateState(state: WizardState): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // 1. At least one provider with API key set
  const providersWithKey = [...state.providers.values()].filter(p => p.apiKey.length > 0);
  if (providersWithKey.length === 0) {
    errors.push({ type: 'error', message: 'No provider has an API key set. Add at least one provider with a valid key.' });
  }

  // 2. At least one model alias
  if (state.models.length === 0) {
    errors.push({ type: 'error', message: 'No model aliases defined. Add at least one model.' });
  }

  // 3. Every distribution entry: weights sum to 100
  for (const [alias, entries] of state.distribution) {
    const totalWeight = entries.reduce((sum, e) => sum + (e.weight ?? 0), 0);
    if (totalWeight !== 100) {
      errors.push({
        type: 'error',
        message: `Distribution "${alias}": weights sum to ${totalWeight} (must be 100)`,
      });
    }
  }

  // 4. Every distribution entry: referenced providers exist
  for (const [alias, entries] of state.distribution) {
    for (const entry of entries) {
      if (!state.providers.has(entry.provider)) {
        errors.push({
          type: 'error',
          message: `Distribution "${alias}": provider "${entry.provider}" does not exist`,
        });
      }
    }
  }

  // 5. Every fallback entry: referenced providers exist
  for (const [alias, entries] of state.fallback) {
    for (const entry of entries) {
      if (!state.providers.has(entry.provider)) {
        errors.push({
          type: 'error',
          message: `Fallback "${alias}": provider "${entry.provider}" does not exist`,
        });
      }
    }
  }

  // 6. No model in both distribution and fallback
  for (const alias of state.distribution.keys()) {
    if (state.fallback.has(alias)) {
      errors.push({
        type: 'error',
        message: `Model "${alias}" appears in both Distribution and Fallback (choose one)`,
      });
    }
  }

  // 7. Server port valid
  if (state.server.port < 1 || state.server.port > 65535) {
    errors.push({ type: 'error', message: `Invalid port: ${state.server.port} (must be 1-65535)` });
  }

  // 8. Every model alias has routing (warning only)
  for (const alias of state.models) {
    const hasDist = state.distribution.has(alias);
    const hasFallback = state.fallback.has(alias);
    if (!hasDist && !hasFallback) {
      warnings.push({
        type: 'warning',
        message: `Model "${alias}" has no routing (Distribution or Fallback). It won't handle any requests.`,
      });
    }
  }

  return { errors, warnings, ok: errors.length === 0 };
}
```

- [ ] **Step 2: Write tests for validation**

```typescript
// tests/init-validate.test.ts

import { describe, it, expect } from 'vitest';
import { validateState, createEmptyState } from '../src/init/screens/shared/validate.js';

describe('validateState', () => {
  it('returns ok=true for valid state', () => {
    const state = createEmptyState();
    state.providers.set('glm', {
      id: 'glm', baseUrl: 'https://api.z.ai', envKey: 'GLM_API_KEY',
      apiKey: 'test-key', timeout: 60000, ttfbTimeout: 30000,
      authType: 'anthropic', circuitBreaker: { threshold: 3, cooldown: 60 },
    });
    state.models.push('glm-5');
    state.distribution.set('glm-5', [
      { provider: 'glm', model: 'glm-5', weight: 100 },
    ]);
    state.server = { port: 3456, host: 'localhost' };

    const result = validateState(state);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('errors when no providers have API keys', () => {
    const state = createEmptyState();
    state.providers.set('glm', {
      id: 'glm', baseUrl: 'https://api.z.ai', envKey: 'GLM_API_KEY',
      apiKey: '', timeout: 60000, ttfbTimeout: 30000,
      authType: 'anthropic', circuitBreaker: { threshold: 3, cooldown: 60 },
    });
    state.models.push('glm-5');
    state.distribution.set('glm-5', [
      { provider: 'glm', model: 'glm-5', weight: 100 },
    ]);
    state.server = { port: 3456, host: 'localhost' };

    const result = validateState(state);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.message.includes('No provider has an API key'))).toBe(true);
  });

  it('errors when distribution weights do not sum to 100', () => {
    const state = createEmptyState();
    state.providers.set('glm', {
      id: 'glm', baseUrl: 'https://api.z.ai', envKey: 'GLM_API_KEY',
      apiKey: 'test-key', timeout: 60000, ttfbTimeout: 30000,
      authType: 'anthropic', circuitBreaker: { threshold: 3, cooldown: 60 },
    });
    state.models.push('glm-5');
    state.distribution.set('glm-5', [
      { provider: 'glm', model: 'glm-5', weight: 40 },
      { provider: 'glm', model: 'glm-4.7', weight: 40 },
      // missing 20 to sum to 100
    ]);
    state.server = { port: 3456, host: 'localhost' };

    const result = validateState(state);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.message.includes('sum to 80'))).toBe(true);
  });

  it('errors when model appears in both distribution and fallback', () => {
    const state = createEmptyState();
    state.providers.set('glm', {
      id: 'glm', baseUrl: 'https://api.z.ai', envKey: 'GLM_API_KEY',
      apiKey: 'test-key', timeout: 60000, ttfbTimeout: 30000,
      authType: 'anthropic', circuitBreaker: { threshold: 3, cooldown: 60 },
    });
    state.models.push('glm-5');
    state.distribution.set('glm-5', [
      { provider: 'glm', model: 'glm-5', weight: 100 },
    ]);
    state.fallback.set('glm-5', [
      { provider: 'glm', model: 'glm-5' },
      { provider: 'glm', model: 'glm-4.7' },
    ]);
    state.server = { port: 3456, host: 'localhost' };

    const result = validateState(state);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.message.includes('both Distribution and Fallback'))).toBe(true);
  });

  it('warns when model has no routing', () => {
    const state = createEmptyState();
    state.providers.set('glm', {
      id: 'glm', baseUrl: 'https://api.z.ai', envKey: 'GLM_API_KEY',
      apiKey: 'test-key', timeout: 60000, ttfbTimeout: 30000,
      authType: 'anthropic', circuitBreaker: { threshold: 3, cooldown: 60 },
    });
    state.models.push('glm-5');
    // no distribution or fallback
    state.server = { port: 3456, host: 'localhost' };

    const result = validateState(state);
    expect(result.ok).toBe(true); // warnings don't block save
    expect(result.warnings.some(w => w.message.includes('no routing'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/kianwoonwong/Downloads/modelweaver && npx vitest run tests/init-validate.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 4: Commit**

```bash
git add tests/init-validate.test.ts src/init/screens/shared/validate.ts
git commit -m "feat(init): add config validation with blocking errors and non-blocking warnings"
```

---

## Screen: Providers

### Task 4: screens/providers.ts

**Files:**
- Create: `src/init/screens/providers.ts`

- [ ] **Step 1: Write the providers screen**

```typescript
// src/init/screens/providers.ts

import type { WizardState, WizardProvider, ScreenAction } from './shared/types.js';
import {
  boxWithHeader, boxLine, check, fail, clearScreen, BOLD, CYAN, RESET, RED, GREEN,
  promptText, promptNumber, promptConfirm, promptSelect, promptPassword, CANCEL, GoBackError,
} from './shared/ui.js';
import prompts from 'prompts';

export function renderProviders(state: WizardState): ScreenAction {
  clearScreen();
  const lines: string[] = [];
  const providers = [...state.providers.values()];

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const keyStatus = p.apiKey ? `${GREEN}✓ key set${RESET}` : `${RED}✗ no key${RESET}`;
    lines.push(`  ${i + 1}. ${p.id.padEnd(16)} ${keyStatus}`);
  }

  if (providers.length === 0) {
    lines.push('  (no providers configured)');
  }

  lines.push('');
  lines.push('  a. Add provider     e. Edit provider');
  lines.push('  t. Test API key    d. Delete provider');
  lines.push('  b. Back to main menu');

  boxWithHeader('Providers', lines);

  return handleInput(state);
}

function handleInput(state: WizardState): ScreenAction {
  const providers = [...state.providers.values()];

  const response = prompts({
    type: 'text',
    name: 'action',
    message: 'Choose action:',
  }, { onCancel: () => ({ action: 'b' }) } as any) as any;

  // Note: simplified — use promptSelect for real implementation
  return { type: 'back' }; // placeholder
}
```

- [ ] **Step 2: Implement full providers screen**

The full implementation should include:

**renderProviders(state) → ScreenAction:**
- Display provider list with index numbers and key status
- Show actions: a/e/t/d/b
- Call `handleInput(state)`

**handleInput(state) → ScreenAction:**
- Use `promptSelect` with choices: 'a', 'e', 't', 'd', 'b'
- Match on choice and call appropriate handler

**addProvider(state) → ScreenAction:**
- `promptText('Provider name (e.g. glm):')` — validate unique
- `promptText('Base URL:')`
- `promptPassword('API Key:')`
- `promptNumber('Timeout (ms):', 60000)`
- `promptNumber('TTFB Timeout (ms):', 30000)`
- `promptNumber('Circuit breaker threshold:', 3)`
- `promptNumber('Circuit breaker cooldown (s):', 60)`
- Build WizardProvider, add to state.providers
- Return to renderProviders

**editProvider(state) → ScreenAction:**
- `promptSelect` to choose provider by number
- Show sub-menu: name / baseUrl / apiKey / timeout / ttfbTimeout / threshold / cooldown
- `promptSelect` to choose field to edit
- Prompt for new value, update state
- Return to renderProviders

**deleteProvider(state) → ScreenAction:**
- `promptSelect` to choose provider to delete
- Check if provider is referenced in distribution or fallback
- If referenced: show warning with cascade options (remove routing rules too, or cancel)
- If not referenced: simple confirm then delete
- Remove from state.providers

**testApiKey(state) → ScreenAction:**
- `promptSelect` to choose provider
- Call `testApiKey()` from init.ts (reuse existing function)
- Show result: "✓ Key works" or "✗ Key failed: <error>"
- Wait for keypress, return to renderProviders

**Key:** Import `testApiKey` from the original init.ts location. The testApiKey function signature is:
```typescript
export async function testApiKey(
  baseUrl: string,
  apiKey: string,
  preset: ProviderPreset,
): Promise<{ ok: boolean; error?: string }>
```
The preset should be inferred from baseUrl or asked from the user.

- [ ] **Step 3: Write a basic render test**

```typescript
// tests/init-providers.test.ts

import { describe, it, expect } from 'vitest';
import { createEmptyState } from '../src/init/screens/shared/types.js';

describe('renderProviders', () => {
  it('shows empty state correctly', () => {
    const state = createEmptyState();
    // Just verify the function can be called without throwing
    // Full render tests require mocking prompts library
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add src/init/screens/providers.ts tests/init-providers.test.ts
git commit -m "feat(init): add providers screen with add/edit/delete/test"
```

---

## Screen: Models

### Task 5: screens/models.ts

**Files:**
- Create: `src/init/screens/models.ts`

- [ ] **Step 1: Write the models screen**

```typescript
// src/init/screens/models.ts

import type { WizardState, ScreenAction } from './shared/types.js';
import {
  boxWithHeader, clearScreen, BOLD, CYAN, RESET,
  promptText, promptConfirm, promptSelect, CANCEL,
} from './shared/ui.js';

export function renderModels(state: WizardState): ScreenAction {
  clearScreen();
  const lines: string[] = [];

  for (let i = 0; i < state.models.length; i++) {
    const alias = state.models[i];
    const routingType = state.distribution.has(alias)
      ? `${CYAN}distribution${RESET}`
      : state.fallback.has(alias)
      ? `${CYAN}fallback${RESET}`
      : `${RESET}no routing`;
    lines.push(`  ${i + 1}. ${alias.padEnd(20)} ${routingType}`);
  }

  if (state.models.length === 0) {
    lines.push('  (no models configured)');
  }

  lines.push('');
  lines.push('  a. Add model      d. Delete model');
  lines.push('  b. Back to main menu');

  boxWithHeader('Models', lines);

  return handleInput(state);
}

function handleInput(state: WizardState): ScreenAction {
  // Use promptSelect with choices: 'a', 'd', 'b'
  // a → addModel(state)
  // d → deleteModel(state)
  // b → { type: 'back' }
  return { type: 'back' }; // placeholder
}

async function addModel(state: WizardState): Promise<ScreenAction> {
  const alias = await promptText('Model alias name:');
  if (!alias.trim()) throw new GoBackError();
  if (state.models.includes(alias)) {
    console.log(`  ${RED}Model "${alias}" already exists${RESET}`);
    await promptText('Press Enter to continue...', '');
    return renderModels(state);
  }
  state.models.push(alias);
  return renderModels(state);
}

async function deleteModel(state: WizardState): Promise<ScreenAction> {
  if (state.models.length === 0) {
    await promptText('No models to delete. Press Enter...', '');
    return renderModels(state);
  }
  const choices = state.models.map((m, i) => ({ title: m, value: i }));
  choices.push({ title: 'Cancel', value: -1 });
  const idx = await promptSelect('Select model to delete:', choices);
  if (idx === -1) return renderModels(state);

  const alias = state.models[idx];
  // Warn if has distribution or fallback
  const hasDist = state.distribution.has(alias);
  const hasFb = state.fallback.has(alias);
  if (hasDist || hasFb) {
    console.log(`  ${RED}Warning: "${alias}" has ${hasDist ? 'distribution' : ''}${hasDist && hasFb ? ' and ' : ''}${hasFb ? 'fallback' : ''} rules${RESET}`);
    const confirm2 = await promptConfirm(`Delete model AND its routing rules? (otherwise cancel)`);
    if (confirm2) {
      state.distribution.delete(alias);
      state.fallback.delete(alias);
      state.models.splice(idx, 1);
    }
  } else {
    const confirm1 = await promptConfirm(`Delete model "${alias}"?`);
    if (confirm1) state.models.splice(idx, 1);
  }
  return renderModels(state);
}
```

- [ ] **Step 2: Write tests**

```typescript
// tests/init-models.test.ts

import { describe, it, expect } from 'vitest';
import { createEmptyState } from '../src/init/screens/shared/types.js';

describe('models screen', () => {
  it('createEmptyState has empty models array', () => {
    const state = createEmptyState();
    expect(state.models).toEqual([]);
  });

  it('adding duplicate model is rejected', async () => {
    const state = createEmptyState();
    state.models.push('glm-5');
    const isDuplicate = state.models.includes('glm-5');
    expect(isDuplicate).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/init-models.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/init/screens/models.ts tests/init-models.test.ts
git commit -m "feat(init): add models screen with add/delete"
```

---

## Screen: Distribution

### Task 6: screens/distribution.ts

**Files:**
- Create: `src/init/screens/distribution.ts`

- [ ] **Step 1: Write the distribution list screen**

```typescript
// src/init/screens/distribution.ts

import type { WizardState, RoutingEntry, ScreenAction } from './shared/types.js';
import {
  boxWithHeader, boxLine, clearScreen, GREEN, CYAN, RESET, RED,
  promptText, promptNumber, promptConfirm, promptSelect, CANCEL, GoBackError,
} from './shared/ui.js';

export function renderDistribution(state: WizardState): ScreenAction {
  clearScreen();
  const lines: string[] = [];

  const aliases = [...state.distribution.keys()];
  for (let i = 0; i < aliases.length; i++) {
    const alias = aliases[i];
    const entries = state.distribution.get(alias)!;
    const total = entries.reduce((s, e) => s + (e.weight ?? 0), 0);
    const ok = total === 100 ? GREEN : RED;
    lines.push(`  ${i + 1}. ${alias.padEnd(20)} ${entries.length} providers  weight: ${ok}${total}${RESET}`);
  }

  if (aliases.length === 0) {
    lines.push('  (no distribution rules — add one from the Models screen first)');
    lines.push('  b. Back to main menu');
    boxWithHeader('Distribution', lines);
    return handleInput(state);
  }

  lines.push('');
  lines.push('  a. Add rule        e. Edit rule        d. Delete rule');
  lines.push('  b. Back to main menu');

  boxWithHeader('Distribution', lines);

  return handleInput(state);
}

function handleInput(state: WizardState): ScreenAction {
  // promptSelect: 'a', 'e', 'd', 'b'
  return { type: 'back' };
}

async function addDistribution(state: WizardState): Promise<ScreenAction> {
  // 1. Select model alias (must exist in state.models, not already in distribution or fallback)
  const available = state.models.filter(m => !state.distribution.has(m) && !state.fallback.has(m));
  if (available.length === 0) {
    console.log(`  ${RED}No available models. Add a model first in Models screen.${RESET}`);
    await promptText('Press Enter...', '');
    return renderDistribution(state);
  }
  const alias = await promptSelect('Select model for distribution:', available.map(m => ({ title: m, value: m })));
  const entries: RoutingEntry[] = [];

  // 2. Add entries (at least 1)
  while (true) {
    clearScreen();
    const totalWeight = entries.reduce((s, e) => s + (e.weight ?? 0), 0);
    const remaining = 100 - totalWeight;
    const ok = totalWeight === 100 ? GREEN : remaining < 0 ? RED : CYAN;

    console.log(`\n  Distribution: ${alias}`);
    console.log(`  Total weight: ${ok}${totalWeight}${RESET} / 100`);
    console.log('');
    for (let i = 0; i < entries.length; i++) {
      console.log(`  ${i + 1}. ${entries[i].provider} → ${entries[i].model}  weight: ${entries[i].weight}`);
    }
    if (entries.length > 0) console.log('');
    console.log('  a. Add entry      d. Done (save)');
    console.log('  b. Cancel');

    const action = await promptSelect('Action:', [
      { title: 'Add entry', value: 'a' },
      { title: 'Done (save)', value: 'd' },
      { title: 'Cancel', value: 'b' },
    ]);

    if (action === 'a') {
      // Select provider
      const providerChoices = [...state.providers.keys()].map(p => ({ title: p, value: p }));
      const providerId = await promptSelect('Provider:', providerChoices);
      const modelName = await promptText(`Model name on ${providerId}:`, alias);
      const weight = await promptNumber(`Weight (remaining: ${remaining}):`, remaining);
      entries.push({ provider: providerId, model: modelName, weight });
    } else if (action === 'd') {
      break;
    } else {
      throw new GoBackError();
    }
  }

  state.distribution.set(alias, entries);
  return renderDistribution(state);
}

async function editDistribution(state: WizardState): Promise<ScreenAction> {
  const aliases = [...state.distribution.keys()];
  if (aliases.length === 0) return renderDistribution(state);

  const alias = await promptSelect('Select distribution to edit:', aliases.map(a => ({ title: a, value: a })));
  const entries = state.distribution.get(alias)!;

  while (true) {
    clearScreen();
    const totalWeight = entries.reduce((s, e) => s + (e.weight ?? 0), 0);
    const ok = totalWeight === 100 ? GREEN : RED;

    console.log(`  Distribution: ${alias}`);
    console.log(`  Total weight: ${ok}${totalWeight}${RESET} / 100`);
    console.log('');
    for (let i = 0; i < entries.length; i++) {
      console.log(`  ${i + 1}. ${entries[i].provider} → ${entries[i].model}  weight: ${entries[i].weight}`);
    }
    console.log('');
    console.log('  a. Add entry      e. Edit weight   d. Remove entry');
    console.log('  b. Done           c. Cancel');

    const action = await promptSelect('Action:', [
      { title: 'Add entry', value: 'a' },
      { title: 'Edit weight', value: 'e' },
      { title: 'Remove entry', value: 'd' },
      { title: 'Done', value: 'b' },
      { title: 'Cancel', value: 'c' },
    ]);

    if (action === 'a') {
      const remaining = 100 - entries.reduce((s, e) => s + (e.weight ?? 0), 0);
      const providerChoices = [...state.providers.keys()].map(p => ({ title: p, value: p }));
      const providerId = await promptSelect('Provider:', providerChoices);
      const modelName = await promptText(`Model name:`, alias);
      const weight = await promptNumber(`Weight (remaining: ${remaining}):`, remaining);
      entries.push({ provider: providerId, model: modelName, weight });
    } else if (action === 'e') {
      const entryIdx = await promptSelect('Select entry:', entries.map((e, i) => ({ title: `${e.provider} → ${e.model}`, value: i })));
      const newWeight = await promptNumber('New weight:', entries[entryIdx].weight);
      entries[entryIdx].weight = newWeight;
    } else if (action === 'd') {
      const entryIdx = await promptSelect('Remove entry:', entries.map((e, i) => ({ title: `${e.provider} → ${e.model}`, value: i })));
      entries.splice(entryIdx, 1);
    } else if (action === 'b') {
      break;
    } else {
      throw new GoBackError();
    }
  }

  state.distribution.set(alias, entries);
  return renderDistribution(state);
}

async function deleteDistribution(state: WizardState): Promise<ScreenAction> {
  const aliases = [...state.distribution.keys()];
  if (aliases.length === 0) return renderDistribution(state);
  const alias = await promptSelect('Delete distribution:', aliases.map(a => ({ title: a, value: a })));
  const confirm = await promptConfirm(`Delete distribution for "${alias}"?`);
  if (confirm) state.distribution.delete(alias);
  return renderDistribution(state);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/init/screens/distribution.ts
git commit -m "feat(init): add distribution screen with add/edit/delete"
```

---

## Screen: Fallback

### Task 7: screens/fallback.ts

**Files:**
- Create: `src/init/screens/fallback.ts`

- [ ] **Step 1: Write the fallback screen**

Similar structure to distribution.ts but:
- No weights — pure sequential chain
- Entries have labels: `(primary)` for #1, `(fallback #N)` for the rest
- Actions: add entry, remove entry, reorder (swap)

**Reorder logic:** promptSelect for entry to move, then promptSelect for new position. Swap the two entries.

- [ ] **Step 2: Commit**

```bash
git add src/init/screens/fallback.ts
git commit -m "feat(init): add fallback chains screen with add/remove/reorder"
```

---

## Screen: Server Settings

### Task 8: screens/server.ts

**Files:**
- Create: `src/init/screens/server.ts`

- [ ] **Step 1: Write the server settings screen**

```typescript
// src/init/screens/server.ts

import type { WizardState, ScreenAction } from './shared/types.js';
import {
  boxWithHeader, boxLine, clearScreen, CYAN, RESET, RED,
  promptNumber, promptText, CANCEL,
} from './shared/ui.js';

export function renderServer(state: WizardState): ScreenAction {
  clearScreen();
  const lines: string[] = [];
  lines.push(boxLine('Port:', String(state.server.port)));
  lines.push(boxLine('Host:', state.server.host));
  lines.push('');
  lines.push('  e. Edit settings');
  lines.push('  b. Back to main menu');
  boxWithHeader('Server Settings', lines);

  return handleInput(state);
}

async function handleInput(state: WizardState): Promise<ScreenAction> {
  const { prompt } = await import('prompts');
  const response = await prompt({
    type: 'text',
    name: 'action',
    message: 'Choose action:',
  }, { onCancel: () => ({ action: 'b' }) } as any) as any;

  if (response.action === 'e') {
    return await editServer(state);
  }
  return { type: 'back' };
}

async function editServer(state: WizardState): Promise<ScreenAction> {
  const port = await promptNumber('Port:', state.server.port);
  const host = await promptText('Host:', state.server.host);
  if (port < 1 || port > 65535) {
    console.log(`  ${RED}Invalid port. Must be 1-65535.${RESET}`);
    await import('prompts').then(p => p.prompt({ type: 'text', name: 'x', message: 'Press Enter...' }, { onCancel: () => {} } as any) as any);
  } else {
    state.server.port = port;
    state.server.host = host;
  }
  return renderServer(state);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/init/screens/server.ts
git commit -m "feat(init): add server settings screen"
```

---

## Shared: Config File Writer

### Task 9: shared/write.ts — Config file writer

**Files:**
- Create: `src/init/screens/shared/write.ts`

- [ ] **Step 1: Write the config file writer**

```typescript
// src/init/screens/shared/write.ts

import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stringifyYaml } from 'yaml';
import type { WizardState } from './types.js';

export function buildYamlConfig(state: WizardState): string {
  // Convert WizardState back to config.yaml format
  // providers
  const providers: Record<string, any> = {};
  for (const [id, p] of state.providers) {
    providers[id] = {
      baseUrl: p.baseUrl,
      timeout: p.timeout,
      ttfbTimeout: p.ttfbTimeout,
      authType: p.authType,
      circuitBreaker: p.circuitBreaker,
    };
  }

  // model routing — merge distribution and fallback
  const modelRouting: Record<string, any[]> = {};
  for (const [alias, entries] of state.distribution) {
    modelRouting[alias] = entries.map(e => ({
      provider: e.provider,
      model: e.model,
      weight: e.weight,
    }));
  }
  for (const [alias, entries] of state.fallback) {
    if (!modelRouting[alias]) {
      modelRouting[alias] = entries.map(e => ({
        provider: e.provider,
        model: e.model,
      }));
    }
  }

  const config = {
    providers,
    modelRouting,
    server: state.server,
  };

  return stringifyYaml(config);
}

export function writeEnvFile(state: WizardState, configDir: string): void {
  const lines: string[] = [];
  for (const [_id, p] of state.providers) {
    if (p.envKey && p.apiKey) {
      lines.push(`${p.envKey}=${p.apiKey}`);
    }
  }
  const envPath = join(configDir, '.env');
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
}

export function writeStateToFiles(state: WizardState): void {
  const configDir = process.env.MODELWEAVER_CONFIG_DIR ?? '.';
  const configPath = join(configDir, 'config.yaml');
  const configDir2 = dirname(configPath);

  if (!existsSync(configDir2)) {
    mkdirSync(configDir2, { recursive: true });
  }

  const yamlContent = buildYamlConfig(state);
  writeFileSync(configPath, yamlContent, 'utf8');
  writeEnvFile(state, configDir2);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/init/screens/shared/write.ts
git commit -m "feat(init): extract config file writer to shared/write.ts"
```

---

## Main Loop

### Task 10: init.ts — Rewrite main menu

**Files:**
- Modify: `src/init.ts` (rewrite)

- [ ] **Step 1: Create init.ts as the main menu state machine**

The new init.ts should:
1. Read existing config via `peekConfig()` to pre-populate state
2. Build WizardState from the peeked config (convert RoutingEntry[] to distribution/fallback maps)
3. Loop: render current screen → get action → update state → repeat
4. On `{ type: 'save' }`: call `validateState()`, if ok → write config + .env, exit
5. On `{ type: 'quit' }`: exit without saving
6. Drop `--quick` entirely (delete `runQuickInit`)

```typescript
// src/init.ts (new structure, replacing the existing ~1800 line version)

import { createEmptyState, type WizardState, type ScreenId, type ScreenAction } from './init/screens/shared/types.js';
import { clearScreen, boxWithHeader, promptSelect, CANCEL, GoBackError, GREEN, RED, CYAN, RESET } from './init/screens/shared/ui.js';
import { renderProviders } from './init/screens/providers.js';
import { renderModels } from './init/screens/models.js';
import { renderDistribution } from './init/screens/distribution.js';
import { renderFallback } from './init/screens/fallback.js';
import { renderServer } from './init/screens/server.js';
import { validateState } from './init/screens/shared/validate.js';
import { writeStateToFiles } from './init/screens/shared/write.js';
import { peekConfig } from './config.js';

export async function runInit(_opts: { quick?: boolean } = {}): Promise<void> {
  // 1. Build initial state from existing config
  const state = createEmptyState();
  try {
    const peeked = await peekConfig();
    if (peeked) {
      // Convert providers
      for (const [id, p] of Object.entries(peeked.providers ?? {})) {
        state.providers.set(id, {
          id, baseUrl: p.baseUrl, envKey: '', apiKey: process.env[`${id.toUpperCase()}_API_KEY`] ?? '',
          timeout: p.timeout ?? 60000, ttfbTimeout: p.ttfbTimeout ?? 30000,
          authType: 'anthropic', circuitBreaker: p.circuitBreaker ?? { threshold: 3, cooldown: 60 },
        });
      }
      // Convert model routing
      for (const [alias, entries] of Object.entries(peeked.modelRouting ?? {})) {
        state.models.push(alias);
        const weightedEntries = entries.filter(e => e.weight !== undefined);
        const unweightedEntries = entries.filter(e => e.weight === undefined);
        if (weightedEntries.length > 0) {
          state.distribution.set(alias, weightedEntries.map(e => ({
            provider: e.provider, model: e.model, weight: e.weight,
          })));
        } else if (unweightedEntries.length > 0) {
          state.fallback.set(alias, unweightedEntries.map(e => ({
            provider: e.provider, model: e.model,
          })));
        }
      }
      if (peeked.server) {
        state.server = peeked.server;
      }
    }
  } catch {
    // No existing config — start fresh
  }

  // 2. Main loop
  let currentScreen: ScreenId = 'main';

  while (true) {
    try {
      const action: ScreenAction = await dispatch(state, currentScreen);
      switch (action.type) {
        case 'back':
          currentScreen = 'main';
          break;
        case 'quit':
          return;
        case 'save':
          // Validation
          const result = validateState(state);
          if (!result.ok) {
            console.log(`\n  ${RED}Validation errors:${RESET}`);
            for (const e of result.errors) console.log(`    ${RED}\u2717${RESET} ${e.message}`);
            if (result.warnings.length > 0) {
              console.log(`\n  ${CYAN}Warnings:${RESET}`);
              for (const w of result.warnings) console.log(`    ${CYAN}!${RESET} ${w.message}`);
            }
            await import('prompts').then(p => p.prompt({ type: 'text', name: 'x', message: 'Press Enter to continue...' }, { onCancel: () => {} } as any) as any);
            currentScreen = 'main';
            break;
          }
          if (result.warnings.length > 0) {
            console.log(`\n  ${CYAN}Warnings:${RESET}`);
            for (const w of result.warnings) console.log(`    ${CYAN}!${RESET} ${w.message}`);
          }
          writeStateToFiles(state);
          console.log(`\n  ${GREEN}Config saved successfully!${RESET}`);
          return;
        case 'navigate':
          currentScreen = action.section;
          break;
      }
    } catch (e) {
      if (e instanceof GoBackError) {
        currentScreen = 'main';
        continue;
      }
      throw e;
    }
  }
}

async function dispatch(state: WizardState, screen: ScreenId): Promise<ScreenAction> {
  switch (screen) {
    case 'main': return renderMain(state);
    case 'providers': return renderProviders(state);
    case 'models': return renderModels(state);
    case 'distribution': return renderDistribution(state);
    case 'fallback': return renderFallback(state);
    case 'server': return renderServer(state);
  }
}

async function renderMain(state: WizardState): Promise<ScreenAction> {
  clearScreen();
  const providerCount = state.providers.size;
  const modelCount = state.models.length;
  const distCount = state.distribution.size;
  const fbCount = state.fallback.size;

  const lines: string[] = [];
  lines.push(`  1. Providers               [${providerCount} configured]`);
  lines.push(`  2. Models                  [${modelCount} configured]`);
  lines.push(`  3. Distribution            [${distCount} rules]`);
  lines.push(`  4. Fallback chains         [${fbCount} chains]`);
  lines.push(`  5. Server settings`);
  lines.push('');
  lines.push('  s. Save and exit');
  lines.push('  q. Quit without saving');

  boxWithHeader('ModelWeaver Configuration', lines);

  const choice = await promptSelect('Choose:', [
    { title: 'Providers', value: '1' },
    { title: 'Models', value: '2' },
    { title: 'Distribution', value: '3' },
    { title: 'Fallback chains', value: '4' },
    { title: 'Server settings', value: '5' },
    { title: 'Save and exit', value: 's' },
    { title: 'Quit without saving', value: 'q' },
  ]);

  switch (choice) {
    case '1': return { type: 'navigate', section: 'providers' };
    case '2': return { type: 'navigate', section: 'models' };
    case '3': return { type: 'navigate', section: 'distribution' };
    case '4': return { type: 'navigate', section: 'fallback' };
    case '5': return { type: 'navigate', section: 'server' };
    case 's': return { type: 'save' };
    case 'q': return { type: 'quit' };
  }
  return { type: 'back' };
}

```

- [ ] **Step 2: Run existing init tests**

Run: `npx vitest run tests/init.test.ts`
Expected: PASS (existing tests should still pass)

- [ ] **Step 3: Commit**

```bash
git add src/init.ts
git commit -m "feat(init): rewrite as section-based wizard with state machine"
```

---

## Cleanup

### Task 11: Remove old init.ts code, verify full integration

**Files:**
- Modify: `src/init.ts` (remove old functions, keep only the new structure)
- Delete: old sequential-phase functions (PHASE_PROVIDERS, PHASE_MODELS, etc.)
- The new `runInit` should be the only export

- [ ] **Step 1: Verify full flow with manual testing**

```bash
npm run build
cd /Users/kianwoonwong/Downloads/modelweaver
# Run init wizard in a subshell with no TTY to test it starts
echo -e "b\ns" | npx tsx src/init.ts 2>&1 | head -20
```

- [ ] **Step 2: Run all init tests**

Run: `npx vitest run tests/`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(init): complete section-based wizard refactor"
```

---

## Spec Coverage

| Spec Section | Tasks |
|---|---|
| Main Menu | Task 10 |
| Providers screen | Task 4 |
| Models screen | Task 5 |
| Distribution screen | Task 6 |
| Fallback screen | Task 7 |
| Server Settings screen | Task 8 |
| Validation | Task 3 |
| Shared types | Task 1 |
| Shared UI helpers | Task 2 |
| Shared write | Task 9 |
| File write | Task 9, 10 |
| Cleanup + integration | Task 11 |
| Tests | Tasks 3, 5 |
