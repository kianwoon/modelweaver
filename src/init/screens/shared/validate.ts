// src/init/screens/shared/validate.ts

import type { WizardState } from './types.js';

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
