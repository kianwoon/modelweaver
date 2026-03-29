// src/init/screens/providers.ts

import type { WizardState, WizardProvider, ScreenAction } from './shared/types.js';
import {
  boxWithHeader, boxLine, check, fail, clearScreen,
  GREEN, RED, CYAN, BOLD, RESET,
  promptText, promptNumber, promptConfirm, promptSelect, promptPassword,
  GoBackError,
} from './shared/ui.js';
import { testApiKey } from '../../init.js';
import { getPresets, type ProviderPreset } from '../../presets.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Match a provider baseUrl to a known preset, or return undefined. */
function matchPreset(baseUrl: string): ProviderPreset {
  const presets = getPresets();
  const match = presets.find(
    (p) => baseUrl.startsWith(p.baseUrl) || p.baseUrl.startsWith(baseUrl),
  );
  return match ?? {
    id: 'custom',
    name: 'Custom',
    baseUrl,
    envKey: '',
    authType: 'bearer' as const,
    testPath: '/v1/chat/completions',
    models: { sonnet: 'sonnet', opus: 'opus', haiku: 'haiku' },
  };
}

/** Prompt the user to select a provider by index. Returns the provider id. */
async function selectProvider(state: WizardState, label: string): Promise<string> {
  const entries = Array.from(state.providers.entries());
  if (entries.length === 0) {
    throw new GoBackError();
  }

  const choices = entries.map(([id, p], i) => ({
    title: `${i + 1}. ${p.id}  (${p.baseUrl})`,
    value: id,
  }));

  return promptSelect(label, choices);
}

/** Check if a provider is referenced in distribution or fallback routing. */
function findRoutingRefs(state: WizardState, providerId: string): string[] {
  const refs: string[] = [];

  for (const [model, entries] of state.distribution) {
    if (entries.some((e) => e.provider === providerId)) {
      refs.push(`distribution[${model}]`);
    }
  }

  for (const [model, entries] of state.fallback) {
    if (entries.some((e) => e.provider === providerId)) {
      refs.push(`fallback[${model}]`);
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Screen functions
// ---------------------------------------------------------------------------

export async function renderProviders(state: WizardState): Promise<ScreenAction> {
  while (true) {
    clearScreen();

    const entries = Array.from(state.providers.entries());

    if (entries.length === 0) {
      boxWithHeader('Providers', ['  No providers configured yet.']);
    } else {
      const lines = entries.map(([id, p], i) => {
        const hasKey = p.apiKey.length > 0;
        const status = hasKey
          ? `${GREEN}\u2713${RESET} key set`
          : `${RED}\u2717${RESET} no key`;
        return `  ${i + 1}. ${BOLD}${id}${RESET}  ${p.baseUrl}  ${status}`;
      });

      lines.push('');
      lines.push('  Actions:');
      lines.push(`    ${CYAN}a${RESET}. Add provider`);
      lines.push(`    ${CYAN}e${RESET}. Edit provider`);
      lines.push(`    ${CYAN}t${RESET}. Test API key`);
      lines.push(`    ${CYAN}d${RESET}. Delete provider`);
      lines.push(`    ${CYAN}b${RESET}. Back`);

      boxWithHeader('Providers', lines);
    }

    if (entries.length === 0) {
      const choice = await promptSelect('What would you like to do?', [
        { title: 'Add provider', value: 'a' },
        { title: 'Back', value: 'b' },
      ]);
      if (choice === 'b') return { type: 'back' };
      await addProvider(state);
    } else {
      const choice = await promptSelect('What would you like to do?', [
        { title: 'Add provider', value: 'a' },
        { title: 'Edit provider', value: 'e' },
        { title: 'Test API key', value: 't' },
        { title: 'Delete provider', value: 'd' },
        { title: 'Back', value: 'b' },
      ]);
      switch (choice) {
        case 'a': await addProvider(state); break;
        case 'e': await editProvider(state); break;
        case 't': await testProviderKey(state); break;
        case 'd': await deleteProvider(state); break;
        case 'b': return { type: 'back' };
      }
    }
  }
}

export async function addProvider(state: WizardState): Promise<ScreenAction> {
  clearScreen();
  boxWithHeader('Add Provider', []);

  const name = await promptText('Provider name (e.g. glm, anthropic)', '');
  if (!name) throw new GoBackError();

  // Validate uniqueness
  if (state.providers.has(name)) {
    fail(`Provider "${name}" already exists.`);
    return { type: 'error', message: `Provider "${name}" already exists` };
  }

  const baseUrl = await promptText('Base URL', '');
  if (!baseUrl) throw new GoBackError();
  if (!/^https?:\/\//i.test(baseUrl)) {
    fail('Base URL must start with http:// or https://');
    return { type: 'error', message: 'Base URL must start with http:// or https://' };
  }

  const apiKey = (await promptPassword('API key')).trim();
  if (!apiKey) throw new GoBackError();

  const timeout = await promptNumber('Request timeout (ms)', 60000);
  if (timeout <= 0) {
    fail('Timeout must be greater than 0');
    return { type: 'error', message: 'Timeout must be greater than 0' };
  }

  const ttfbTimeout = await promptNumber('TTFB timeout (ms)', 30000);
  if (ttfbTimeout >= timeout) {
    fail(`Warning: TTFB timeout (${ttfbTimeout}ms) should be less than total timeout (${timeout}ms). Proceeding anyway.`);
    // Non-blocking warning — continue with the values
  }
  const threshold = await promptNumber('Circuit breaker threshold', 3);
  const cooldown = await promptNumber('Circuit breaker cooldown (s)', 60);

  // Determine auth type from baseUrl matching
  const preset = matchPreset(baseUrl);

  const provider: WizardProvider = {
    id: name,
    baseUrl,
    envKey: `${name.toUpperCase()}_API_KEY`,
    apiKey,
    timeout,
    ttfbTimeout,
    authType: preset.authType,
    circuitBreaker: {
      threshold,
      cooldown,
    },
  };

  state.providers.set(name, provider);
  check(`Provider "${name}" added.`);

  // Loop back to the providers list
  return renderProviders(state);
}

export async function editProvider(state: WizardState): Promise<ScreenAction> {
  const providerId = await selectProvider(state, 'Select provider to edit');
  const provider = state.providers.get(providerId);
  if (!provider) throw new GoBackError();

  while (true) {
    clearScreen();

    const lines = [
      boxLine('Provider:', provider.id),
      boxLine('Base URL:', provider.baseUrl),
      boxLine('API key:', provider.apiKey ? '****' + provider.apiKey.slice(-4) : '(none)'),
      boxLine('Timeout:', `${provider.timeout}ms`),
      boxLine('TTFB timeout:', `${provider.ttfbTimeout}ms`),
      boxLine('CB threshold:', `${provider.circuitBreaker.threshold}`),
      boxLine('CB cooldown:', `${provider.circuitBreaker.cooldown}s`),
      boxLine('Auth type:', provider.authType),
      '',
      '  Select field to edit:',
    ];

    boxWithHeader(`Edit: ${provider.id}`, lines);

    const field = await promptSelect('Field to edit', [
      { title: 'Base URL', value: 'baseUrl' },
      { title: 'API key', value: 'apiKey' },
      { title: 'Timeout', value: 'timeout' },
      { title: 'TTFB timeout', value: 'ttfbTimeout' },
      { title: 'CB threshold', value: 'threshold' },
      { title: 'CB cooldown', value: 'cooldown' },
      { title: 'Back', value: 'back' },
    ]);

    if (field === 'back') break;

    switch (field) {
      case 'baseUrl': {
        const val = await promptText('New base URL', provider.baseUrl);
        if (!val) throw new GoBackError();
        provider.baseUrl = val;
        // Re-derive auth type from new URL
        const preset = matchPreset(val);
        provider.authType = preset.authType;
        check('Base URL updated.');
        break;
      }
      case 'apiKey': {
        const val = await promptPassword('New API key');
        if (!val) throw new GoBackError();
        provider.apiKey = val;
        check('API key updated.');
        break;
      }
      case 'timeout': {
        const val = await promptNumber('Request timeout (ms)', provider.timeout);
        provider.timeout = val;
        check('Timeout updated.');
        break;
      }
      case 'ttfbTimeout': {
        const val = await promptNumber('TTFB timeout (ms)', provider.ttfbTimeout);
        provider.ttfbTimeout = val;
        check('TTFB timeout updated.');
        break;
      }
      case 'threshold': {
        const val = await promptNumber('Circuit breaker threshold', provider.circuitBreaker.threshold);
        provider.circuitBreaker.threshold = val;
        check('Threshold updated.');
        break;
      }
      case 'cooldown': {
        const val = await promptNumber('Circuit breaker cooldown (s)', provider.circuitBreaker.cooldown);
        provider.circuitBreaker.cooldown = val;
        check('Cooldown updated.');
        break;
      }
    }
  }

  // Loop back to the providers list
  return renderProviders(state);
}

export async function deleteProvider(state: WizardState): Promise<ScreenAction> {
  const providerId = await selectProvider(state, 'Select provider to delete');
  const provider = state.providers.get(providerId);
  if (!provider) throw new GoBackError();

  // Check for routing references
  const refs = findRoutingRefs(state, providerId);

  if (refs.length > 0) {
    clearScreen();
    boxWithHeader('Warning', [
      `  Provider ${BOLD}${providerId}${RESET} is referenced in:`,
      ...refs.map((r) => `    ${RED}\u2022${RESET} ${r}`),
      '',
      '  Deleting this provider will also remove those routing rules.',
    ]);

    const proceed = await promptConfirm('Remove provider and its routing rules?');
    if (!proceed) throw new GoBackError();

    // Clean up routing references
    for (const [model, entries] of state.distribution) {
      const filtered = entries.filter((e) => e.provider !== providerId);
      if (filtered.length === 0) {
        state.distribution.delete(model);
      } else {
        state.distribution.set(model, filtered);
      }
    }

    for (const [model, entries] of state.fallback) {
      const filtered = entries.filter((e) => e.provider !== providerId);
      if (filtered.length === 0) {
        state.fallback.delete(model);
      } else {
        state.fallback.set(model, filtered);
      }
    }
  } else {
    const confirmed = await promptConfirm(`Delete provider "${providerId}"?`);
    if (!confirmed) throw new GoBackError();
  }

  state.providers.delete(providerId);
  check(`Provider "${providerId}" deleted.`);

  // Loop back to the providers list
  return renderProviders(state);
}

export async function testProviderKey(state: WizardState): Promise<ScreenAction> {
  const providerId = await selectProvider(state, 'Select provider to test');
  const provider = state.providers.get(providerId);
  if (!provider) throw new GoBackError();

  if (!provider.apiKey) {
    fail(`Provider "${providerId}" has no API key set.`);
    return renderProviders(state);
  }

  clearScreen();
  boxWithHeader('Testing API Key', [
    `  Provider: ${BOLD}${provider.id}${RESET}`,
    `  Endpoint: ${provider.baseUrl}`,
    '',
    '  Sending test request...',
  ]);

  const preset = matchPreset(provider.baseUrl);
  const result = await testApiKey(provider.baseUrl, provider.apiKey, preset);

  if (result.ok) {
    check(`API key for "${providerId}" is valid.`);
  } else {
    fail(`API key for "${providerId}" failed: ${result.error}`);
  }

  // Pause so the user can see the result
  await promptConfirm('Press Enter to continue...', true);

  // Loop back to the providers list
  return renderProviders(state);
}
