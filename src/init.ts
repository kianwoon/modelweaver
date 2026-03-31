// src/init.ts — Section-based wizard main menu for ModelWeaver

import { peekConfig } from './config.js';
import { getPresets, getPreset, type ProviderPreset } from './presets.js';
import { createEmptyState, type WizardState, type ScreenId, type ScreenAction, type ConfigTarget } from './init/screens/shared/types.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { clearScreen, boxWithHeader, promptSelect, GoBackError } from './init/screens/shared/ui.js';
import { renderProviders } from './init/screens/providers.js';
import { renderModels } from './init/screens/models.js';
import { renderDistribution } from './init/screens/distribution.js';
import { renderFallback } from './init/screens/fallback.js';
import { renderServer } from './init/screens/server.js';
import { validateState } from './init/screens/shared/validate.js';
import { writeStateToFiles } from './init/screens/shared/write.js';
import { BOLD, CYAN, GREEN, RED, RESET } from './init/screens/shared/ui.js';

// ---------------------------------------------------------------------------
// API key test (preserved from old init.ts)
// ---------------------------------------------------------------------------

export async function testApiKey(
  baseUrl: string,
  apiKey: string,
  preset: ProviderPreset,
): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  const headers: Record<string, string> =
    preset.authType === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'interleaved-thinking-2025-05-14', 'content-type': 'application/json' }
      : { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };

  try {
    // Try multiple models — some keys have restricted model access
    const modelsToTry = [
      preset.models.sonnet,
      preset.models.haiku,
      preset.models.opus,
    ].filter((m): m is string => !!m);

    let lastStatus = 0;
    for (const model of modelsToTry) {
      const res = await fetch(`${baseUrl}${preset.testPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: controller.signal,
      });
      lastStatus = res.status;

      if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid API key' };
      if (res.status === 200 || res.status === 400 || res.status === 429) return { ok: true };

      // Check for "insufficient balance" — key is valid, account just has no credits
      try {
        const body = await res.json() as { error?: { message?: string } };
        if (body.error?.message?.includes('insufficient balance')) {
          return { ok: true };
        }
      } catch { /* ignore parse errors */ }

      // Model not found or other error — try next model
      continue;
    }

    // All models failed
    return { ok: false, error: `Unexpected status ${lastStatus}` };
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') return { ok: false, error: 'Request timed out' };
    return { ok: false, error: 'Network error \u2014 endpoint unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Peek existing config and convert to WizardState
// ---------------------------------------------------------------------------

function buildStateFromConfig(): WizardState {
  const state = createEmptyState();
  const existing = peekConfig();

  if (!existing) return state;

  // Convert providers
  for (const [id, provider] of existing.providers) {
    const preset = getPreset(id);
    state.providers.set(id, {
      id,
      baseUrl: provider.baseUrl,
      envKey: provider.envKey,
      apiKey: process.env[provider.envKey] ?? '',
      timeout: provider.timeout,
      ttfbTimeout: provider.ttfbTimeout ?? 8000,
      authType: provider.authType,
      concurrentLimit: provider.concurrentLimit ?? 3,
      stallTimeout: provider.stallTimeout ?? 15000,
      poolSize: provider.poolSize ?? 10,
      circuitBreaker: {
        threshold: provider.circuitBreaker?.threshold ?? 5,
        windowSeconds: provider.circuitBreaker?.windowSeconds ?? 120,
        cooldown: provider.circuitBreaker?.cooldown ?? 60,
      },
    });
  }

  // Convert modelRouting: entries with weight -> distribution, without -> fallback
  for (const [alias, entries] of existing.modelRouting) {
    const hasWeight = entries.some(e => e.weight !== undefined);
    if (hasWeight) {
      // Distribution mode
      state.distribution.set(alias, entries.map(e => ({
        provider: e.provider,
        model: e.model,
        weight: e.weight ?? 1,
      })));
      if (!state.models.includes(alias)) {
        state.models.push(alias);
      }
    } else {
      // Fallback mode
      state.fallback.set(alias, entries.map(e => ({
        provider: e.provider,
        model: e.model,
      })));
      if (!state.models.includes(alias)) {
        state.models.push(alias);
      }
    }
  }

  // Convert server config
  if (existing.server) {
    state.server = { ...existing.server };
  }

  return state;
}

// ---------------------------------------------------------------------------
// Main menu rendering
// ---------------------------------------------------------------------------

function renderMain(state: WizardState): string[] {
  const lines: string[] = [];

  // Build status strings
  const providerCount = state.providers.size;
  const providerStatus = providerCount === 0
    ? `${RED}[none]${RESET}`
    : `${GREEN}[${providerCount} configured]${RESET}`;

  const modelCount = state.models.length;
  const modelStatus = modelCount === 0
    ? `${RED}[none]${RESET}`
    : `${GREEN}[${modelCount} configured]${RESET}`;

  const distCount = state.distribution.size;
  const distStatus = distCount === 0
    ? `${CYAN}[none]${RESET}`
    : `${GREEN}[${distCount} rules]${RESET}`;

  const fallbackCount = state.fallback.size;
  const fallbackStatus = fallbackCount === 0
    ? `${CYAN}[none]${RESET}`
    : `${GREEN}[${fallbackCount} chain${fallbackCount > 1 ? 's' : ''}]${RESET}`;

  lines.push(`  1. Providers          ${providerStatus}`);
  lines.push(`  2. Models             ${modelStatus}`);
  lines.push(`  3. Distribution       ${distStatus}`);
  lines.push(`  4. Fallback chains    ${fallbackStatus}`);
  lines.push(`  5. Server settings`);
  lines.push('');
  lines.push(`  ${BOLD}s${RESET}. Save and exit`);
  lines.push(`  ${BOLD}q${RESET}. Quit without saving`);

  const title = '  ModelWeaver Configuration';
  const subtitle = `    ${state.server.host}:${state.server.port}`;
  boxWithHeader(title, lines, 54);

  // Show subtitle under title
  console.log(`${CYAN}    └─ ${state.server.host}:${state.server.port}${RESET}`);

  return [
    providerStatus,
    modelStatus,
    distStatus,
    fallbackStatus,
  ];
}

// ---------------------------------------------------------------------------
// Dispatch: route action to screen
// ---------------------------------------------------------------------------

async function dispatch(state: WizardState, section: ScreenId): Promise<ScreenAction> {
  switch (section) {
    case 'providers':
      return await renderProviders(state);
    case 'models':
      return await renderModels(state);
    case 'distribution':
      return await renderDistribution(state);
    case 'fallback':
      return await renderFallback(state);
    case 'server':
      return await renderServer(state);
    default:
      return { type: 'back' };
  }
}

// ---------------------------------------------------------------------------
// Handle validation result
// ---------------------------------------------------------------------------

async function handleValidation(state: WizardState): Promise<boolean> {
  const result = validateState(state);

  // Show errors (blocking)
  if (result.errors.length > 0) {
    console.log(`\n  ${RED}Cannot save:${RESET}`);
    for (const err of result.errors) {
      console.log(`    - ${err.message}`);
    }
    console.log();
    return false;
  }

  // Show warnings (non-blocking)
  if (result.warnings.length > 0) {
    console.log(`\n  ${CYAN}Warnings:${RESET}`);
    for (const warn of result.warnings) {
      console.log(`    - ${warn.message}`);
    }
    console.log();
  }

  return true;
}

// ---------------------------------------------------------------------------
// Show success message
// ---------------------------------------------------------------------------

function showSuccess(): void {
  console.log(`
${BOLD}${CYAN}\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\u2500
\u2551  Configuration saved!                    \u2551
\u2551                                                \u2551
\u2551  Run 'npx modelweaver start' to start the daemon.  \u2551
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D${RESET}
`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runInit(opts: { global?: boolean; path?: string } = {}): Promise<void> {
  // TTY check
  if (!process.stdin.isTTY) {
    console.error('Error: modelweaver init requires an interactive terminal.');
    process.exit(1);
  }

  // Detect config file locations
  const cwd = process.cwd();
  const globalPath = join(process.env.HOME || process.env.USERPROFILE || '', '.modelweaver', 'config.yaml');
  const localPath = join(cwd, 'modelweaver.yaml');
  const hasLocal = existsSync(localPath);
  const hasGlobal = existsSync(globalPath);

  // Determine config target
  let configTarget: ConfigTarget = 'global';
  let targetPath: string | undefined;

  if (opts.path) {
    // Explicit path overrides — if it's not the global path, treat as project
    targetPath = opts.path;
    configTarget = (opts.path === globalPath || opts.path === join(cwd, '.modelweaver', 'config.yaml'))
      ? 'global' : 'project';
  } else if (opts.global) {
    configTarget = 'global';
  } else if (hasLocal && hasGlobal) {
    // Both exist — ask user
    const choice = await promptSelect('Config file detected:', [
      { title: 'Edit global config', value: 'global' },
      { title: 'Edit project routing', value: 'project' },
    ]);
    configTarget = choice === 'project' ? 'project' : 'global';
    targetPath = configTarget === 'project' ? localPath : undefined;
  } else if (hasLocal) {
    // Only project-level exists
    configTarget = 'project';
    targetPath = localPath;
    console.log(`  Detected project config: ${localPath}`);
  } else {
    // Neither exists — default to global
    configTarget = 'global';
  }

  // Build state from existing config (or empty if no config)
  let state = buildStateFromConfig();
  state.configTarget = configTarget;

  // Welcome banner
  clearScreen();
  console.log(`
${BOLD}${CYAN}\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510\u2500
\u2502       Welcome to ModelWeaver!        \u2501 Main Menu \u2502
\u2502                                      \u2502
\u2501  Configure providers, models, and routing\u2501
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${RESET}
`);

  // Main loop
  while (true) {
    try {
    clearScreen();
    renderMain(state);

    const menuItems = [];
    if (configTarget !== 'project') {
      menuItems.push(
        { title: '1. Providers', value: '1' },
        { title: '2. Models', value: '2' },
        { title: '3. Distribution', value: '3' },
        { title: '4. Fallback chains', value: '4' },
        { title: '5. Server settings', value: '5' },
      );
    } else {
      // Project mode — routing only
      menuItems.push(
        { title: '1. Models', value: '1' },
        { title: '2. Distribution', value: '2' },
        { title: '3. Fallback chains', value: '3' },
      );
    }
    menuItems.push({ title: 's. Save and exit', value: 's' });
    menuItems.push({ title: 'q. Quit without saving', value: 'q' });

    const choice = await promptSelect('Choose section:', menuItems);

    const sectionMap: Record<string, ScreenId | 'save' | 'quit'> =
      configTarget === 'project'
        ? { '1': 'models', '2': 'distribution', '3': 'fallback', 's': 'save', 'q': 'quit' }
        : { '1': 'providers', '2': 'models', '3': 'distribution', '4': 'fallback', '5': 'server', 's': 'save', 'q': 'quit' };

    const actionKey = sectionMap[choice];

    if (actionKey === 'save') {
      const canSave = await handleValidation(state);
      if (!canSave) {
        await promptSelect('Press Enter to continue...', [
          { title: 'Continue', value: 'ok' },
        ]);
        continue;
      }
      writeStateToFiles(state, targetPath);
      showSuccess();
      return;
    }
    if (actionKey === 'quit') return;

    let action: ScreenAction;
    if (actionKey) {
      action = await dispatch(state, actionKey);
    } else {
      action = { type: 'back' };
    }

    // Handle screen action
    switch (action.type) {
      case 'back':
        // Screen returned state - if the screen mutates state in place,
        // we just continue the loop. The screens mutate state directly.
        break;
      case 'navigate':
        // Navigate to another section
        const navAction = await dispatch(state, action.section);
        if (navAction.type === 'back') break;
        // For other actions, fall through
        if (navAction.type === 'quit') return;
        break;
      case 'error':
        // Show error, return to main menu
        console.log(`\n  ${RED}Error: ${action.message}${RESET}`);
        await promptSelect('Press Enter to continue...', [
          { title: 'Continue', value: 'ok' },
        ]);
        break;
      case 'save':
        // Validate first
        const canSave2 = await handleValidation(state);
        if (!canSave2) {
          await promptSelect('Press Enter to continue...', [
            { title: 'Continue', value: 'ok' },
          ]);
          continue;
        }
        writeStateToFiles(state, targetPath);
        showSuccess();
        return;
      case 'quit':
        return;
    }
    } catch (e) {
      if (e instanceof GoBackError) {
        // ESC pressed in sub-screen — return to main menu silently
        continue;
      }
      throw e; // re-throw other errors
    }
  }
}
