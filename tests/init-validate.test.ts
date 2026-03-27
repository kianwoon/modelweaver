import { describe, it, expect } from 'vitest';
import { createEmptyState } from '../src/init/screens/shared/types.js';
import { validateState } from '../src/init/screens/shared/validate.js';

describe('validateState', () => {
  it('returns ok=true for valid state', () => {
    const state = createEmptyState();
    state.providers.set('glm', {
      id: 'glm', baseUrl: 'https://api.z.ai', envKey: 'GLM_API_KEY',
      apiKey: 'test-key', timeout: 60000, ttfbTimeout: 30000,
      authType: 'anthropic' as const, circuitBreaker: { threshold: 3, cooldown: 60 },
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
      authType: 'anthropic' as const, circuitBreaker: { threshold: 3, cooldown: 60 },
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
      authType: 'anthropic' as const, circuitBreaker: { threshold: 3, cooldown: 60 },
    });
    state.models.push('glm-5');
    state.distribution.set('glm-5', [
      { provider: 'glm', model: 'glm-5', weight: 40 },
      { provider: 'glm', model: 'glm-4.7', weight: 40 },
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
      authType: 'anthropic' as const, circuitBreaker: { threshold: 3, cooldown: 60 },
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
      authType: 'anthropic' as const, circuitBreaker: { threshold: 3, cooldown: 60 },
    });
    state.models.push('glm-5');
    state.server = { port: 3456, host: 'localhost' };

    const result = validateState(state);
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => w.message.includes('no routing'))).toBe(true);
  });
});
