// src/init.ts — Interactive setup wizard for ModelWeaver
import prompts from 'prompts';
import { getPresets, getPreset, type ProviderPreset } from './presets.js';
import { stringify as stringifyYaml } from 'yaml';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSettings, backupSettings, mergeSettings, writeSettings, getSettingsPath } from './settings.js';
import net from 'node:net';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConfiguredProvider {
  id: string;
  name: string;
  baseUrl: string;
  envKey: string;
  apiKey: string;
  authType: "anthropic" | "bearer";
  models: Record<string, string>;
}

interface DistributionEntry {
  provider: string;
  model: string;
  weight: number;
}

interface ConfiguredModel {
  alias: string;       // user-facing name for /model and availableModels
  provider: string;    // provider ID (primary for fallback mode)
  model: string;       // actual model name sent to provider API (primary for fallback mode)
  fallbacks: { provider: string; model: string }[];
  // Distribution mode: if entries is set, use weighted distribution instead of fallback
  entries?: DistributionEntry[];
}

/** Lightweight representation of a provider found in existing config.yaml.
 *  Used for display and pre-fill; no API key resolution or validation. */
interface ExistingProvider {
  id: string;
  baseUrl: string;
  envKey: string;
  authType: "anthropic" | "bearer";
  timeout: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class GoBackError extends Error { constructor() { super('__back__'); this.name = 'GoBackError'; } }

const CANCEL = { onCancel: () => { throw new GoBackError(); } };

const GREEN = '\x1B[32m';
const RED = '\x1B[31m';
const CYAN = '\x1B[36m';
const BOLD = '\x1B[1m';
const RESET = '\x1B[0m';

function check(msg: string) { console.log(`  ${GREEN}\u2713${RESET} ${msg}`); }
function fail(msg: string) { console.log(`  ${RED}\u2717${RESET} ${msg}`); }

// ---------------------------------------------------------------------------
// [Improvement 6] clearScreen — separator instead of full clear
// ---------------------------------------------------------------------------

function clearScreen(): void {
  console.log(`\n${'\u2500'.repeat(56)}\n`);
}

// ---------------------------------------------------------------------------
// API key test (unchanged)
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
    const res = await fetch(`${baseUrl}${preset.testPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: preset.models.sonnet, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid API key' };
    if (res.status === 200 || res.status === 400 || res.status === 429) return { ok: true };
    // Check for "insufficient balance" — key is valid, account just has no credits
    try {
      const body = await res.json() as { error?: { message?: string } };
      if (body.error?.message?.includes('insufficient balance')) {
        return { ok: true };
      }
    } catch { /* ignore parse errors */ }
    return { ok: false, error: `Unexpected status ${res.status}` };
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') return { ok: false, error: 'Request timed out' };
    return { ok: false, error: 'Network error \u2014 endpoint unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// [Improvement 1] detectEnvApiKey — auto-detect existing keys
// ---------------------------------------------------------------------------

function detectEnvApiKey(preset: ProviderPreset): { found: boolean; key: string; source: string } {
  // dotenv.config() already loads ~/.modelweaver/.env into process.env in index.ts
  // before runInit() is called, so a single check suffices.
  const envVal = process.env[preset.envKey];
  if (envVal && envVal.trim()) {
    return { found: true, key: envVal.trim(), source: 'environment' };
  }
  return { found: false, key: '', source: '' };
}

// ---------------------------------------------------------------------------
// [Improvement 4] calculateTotalSteps — step counter
// ---------------------------------------------------------------------------

function calculateTotalSteps(selectedProviderCount: number, quick: boolean): number {
  if (quick) {
    return 3;
  }
  // Normal mode: N (configure each provider) + model config (1) + server (1) + confirm (1)
  return selectedProviderCount + 1 + 1 + 1;
}

// ---------------------------------------------------------------------------
// [Improvement 7] buildSummaryTable — formatted summary
// ---------------------------------------------------------------------------

function buildSummaryTable(
  providers: ConfiguredProvider[],
  models: ConfiguredModel[],
  server: { port: number; host: string },
): string {
  const lines: string[] = [];
  const W = 56;

  lines.push(`${CYAN}\u250c${'\u2500'.repeat(W)}\u2510${RESET}`);
  lines.push(`${CYAN}\u2502${RESET}${BOLD}  ModelWeaver Configuration Summary${''.padEnd(W - 33)}${CYAN}\u2502${RESET}`);
  lines.push(`${CYAN}\u251c${'\u2500'.repeat(W)}\u2524${RESET}`);
  lines.push(`${CYAN}\u2502${RESET}  ${BOLD}Server:${RESET} ${server.host}:${server.port}${''.padEnd(W - 8 - `${server.host}:${server.port}`.length)}${CYAN}\u2502${RESET}`);
  lines.push(`${CYAN}\u251c${'\u2500'.repeat(W)}\u2524${RESET}`);

  for (const m of models) {
    const provider = providers.find(p => p.id === m.provider);
    const pName = provider ? provider.name : m.provider;
    const info = `${m.alias.padEnd(16)} ${pName} \u2192 ${m.model}`;
    lines.push(`${CYAN}\u2502${RESET}  ${info}${''.padEnd(Math.max(0, W - info.length - 2))}${CYAN}\u2502${RESET}`);
    for (const fb of m.fallbacks) {
      const fbProvider = providers.find(p => p.id === fb.provider);
      const fbPName = fbProvider ? fbProvider.name : fb.provider;
      const fbInfo = `                    fallback: ${fbPName} \u2192 ${fb.model}`;
      lines.push(`${CYAN}\u2502${RESET}  ${fbInfo}${''.padEnd(Math.max(0, W - fbInfo.length - 2))}${CYAN}\u2502${RESET}`);
    }
  }

  lines.push(`${CYAN}\u2514${'\u2500'.repeat(W)}\u2518${RESET}`);
  return lines.join('\n');
}

/** Build a formatted table showing existing configured providers. */
function buildExistingProvidersTable(
  existingProviders: Map<string, ExistingProvider>,
): string {
  const lines: string[] = [];
  const W = 56;
  const providers = [...existingProviders.entries()];

  lines.push(`${CYAN}${'\u250c' + '\u2500'.repeat(W) + '\u2510'}${RESET}`);
  lines.push(`${CYAN}\u2502${RESET}${BOLD}  Currently Configured Providers${''.padEnd(W - 30)}${CYAN}\u2502${RESET}`);
  lines.push(`${CYAN}\u251c${'\u2500'.repeat(W)}\u2524${RESET}`);

  for (const [id, p] of providers) {
    lines.push(`${CYAN}\u2502${RESET}  ${BOLD}${id}${RESET}${''.padEnd(Math.max(0, 20 - id.length))} ${p.baseUrl}${''.padEnd(Math.max(0, W - 22 - p.baseUrl.length))}${CYAN}\u2502${RESET}`);
    const envLabel = p.envKey || '(hardcoded key)';
    const padding = Math.max(0, W - 22 - envLabel.length - p.authType.length);
    lines.push(`${CYAN}\u2502${RESET}    env: ${envLabel}   auth: ${p.authType}${''.padEnd(padding)}${CYAN}\u2502${RESET}`);
  }

  lines.push(`${CYAN}${'\u2514' + '\u2500'.repeat(W) + '\u2518'}${RESET}`);
  return lines.join('\n');
}

/** Merge freshly configured providers with untouched existing providers.
 *  Used for routing selection and summary display. */
function buildAllProviders(
  configured: ConfiguredProvider[],
  existingMap: Map<string, ExistingProvider>,
): ConfiguredProvider[] {
  const touchedIds = new Set(configured.map(p => p.id));
  const result = [...configured];

  for (const [id, ep] of existingMap.entries()) {
    if (!touchedIds.has(id)) {
      const preset = getPreset(id);
      result.push({
        id,
        name: preset?.name ?? id,
        baseUrl: ep.baseUrl,
        envKey: ep.envKey,
        apiKey: "",
        authType: ep.authType,
        models: preset?.models ?? { sonnet: "", opus: "", haiku: "" },
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------

// [Modified] selectProviders — supports singleSelect for --quick mode, excludeIds for add mode
async function selectProviders(options?: { singleSelect?: boolean; excludeIds?: Set<string> }): Promise<string[]> {
  let allPresets = getPresets();
  if (options?.excludeIds) {
    allPresets = allPresets.filter(p => !options.excludeIds!.has(p.id));
  }

  if (allPresets.length === 0) return [];

  if (options?.singleSelect) {
    const { providerId } = await prompts(
      {
        type: 'select',
        name: 'providerId',
        message: 'Select a provider:',
        choices: [
          { title: '\u2B05  Go back', value: '__back__' },
          ...allPresets.map((p) => ({ title: p.name, value: p.id, description: p.baseUrl })),
        ],
      },
      CANCEL,
    );
    return [providerId as string];
  }

  const { providerIds } = await prompts(
    {
      type: 'multiselect',
      name: 'providerIds',
      message: 'Select providers to configure:',
      choices: allPresets.map((p) => ({ title: p.name, value: p.id, description: p.baseUrl })),
      min: 1,
    },
    CANCEL,
  );
  return providerIds as string[];
}

// [Modified] configureProvider — auto-detect env keys + step counter + existing provider pre-fill
async function configureProvider(
  id: string,
  stepInfo?: { current: number; total: number },
  existing?: ExistingProvider,
): Promise<ConfiguredProvider | null> {
  const preset = getPreset(id);
  if (!preset) {
    console.error(`  Error: Unknown provider "${id}". Skipping.`);
    return null;
  }

  const effectiveEnvKey = existing?.envKey ?? preset.envKey;
  const effectiveBaseUrl = existing?.baseUrl ?? preset.baseUrl;
  const effectiveAuthType = existing?.authType ?? preset.authType;

  // [Improvement 1] Auto-detect existing env key — check custom env key first if editing
  let detected = detectEnvApiKey(preset);
  if (existing?.envKey && existing.envKey !== preset.envKey) {
    const customDetected = detectEnvApiKey({ ...preset, envKey: existing.envKey });
    if (customDetected.found) detected = customDetected;
  }

  if (detected.found) {
    process.stdout.write(`  Testing API key for ${preset.name} (from ${detected.source})...`);
    const result = await testApiKey(effectiveBaseUrl, detected.key, preset);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');

    if (result.ok) {
      check(`${preset.name}: existing ${effectiveEnvKey} is valid (${detected.source})`);
      const { useExisting } = await prompts(
        { type: 'confirm', name: 'useExisting', message: `Use this key for ${preset.name}?`, initial: true },
        CANCEL,
      );
      if (useExisting) {
        return {
          id, name: preset.name, baseUrl: effectiveBaseUrl,
          envKey: effectiveEnvKey, apiKey: detected.key,
          authType: effectiveAuthType, models: preset.models,
        };
      }
      // User chose to change — fall through to manual prompt below
      console.log(`  Enter a new key for ${preset.name}:`);
    }

    // Key found but invalid — fall through to prompt
    console.log(`  ${RED}\u26A0${RESET} Existing ${effectiveEnvKey} (${detected.source}) is invalid, please provide a new key.`);
  }

  const stepLabel = stepInfo ? `[Step ${stepInfo.current} of ${stepInfo.total}] ` : '';

  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { baseUrl } = await prompts(
      { type: 'text', name: 'baseUrl', message: `${stepLabel}[${preset.name}] Base URL:`, initial: effectiveBaseUrl },
      CANCEL,
    );

    // Validate the base URL format
    try {
      new URL(baseUrl as string);
    } catch {
      console.log("  Invalid URL format. Please try again.");
      if (attempt < MAX_RETRIES - 1) continue;
      const { retry } = await prompts(
        { type: 'confirm', name: 'retry', message: `Retry with a valid URL? (${attempt + 1}/${MAX_RETRIES - 1} retries used)`, initial: true },
        CANCEL,
      );
      if (!retry) break;
      continue;
    }

    const { apiKey } = await prompts(
      { type: 'password', name: 'apiKey', message: `${stepLabel}[${preset.name}] API key:` },
      CANCEL,
    );

    // Spinner-style test
    process.stdout.write(`  Testing API key for ${preset.name}...`);
    const result = await testApiKey(baseUrl as string, apiKey as string, preset);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');

    if (result.ok) {
      check(`${preset.name} API key accepted`);
      return { id, name: preset.name, baseUrl: baseUrl as string, envKey: effectiveEnvKey, apiKey: apiKey as string, authType: effectiveAuthType, models: preset.models };
    }

    fail(`${preset.name}: ${result.error}`);

    if (attempt < MAX_RETRIES - 1) {
      const { retry } = await prompts(
        { type: 'confirm', name: 'retry', message: `Retry? (${attempt + 1}/${MAX_RETRIES - 1} retries used)`, initial: true },
        CANCEL,
      );
      if (!retry) break;
    }
  }

  console.log(`  ${RED}Warning:${RESET} ${preset.name} will be skipped \u2014 max retries (${MAX_RETRIES}) exceeded.`);
  return null;
}

// ---------------------------------------------------------------------------
// Distribution configuration helper
// ---------------------------------------------------------------------------

/** Build a formatted preview table for distribution entries. */
function buildDistributionPreviewTable(entries: DistributionEntry[]): string {
  const lines: string[] = [];
  const W = 56;

  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);

  lines.push(`${CYAN}\u250c${'\u2500'.repeat(W)}\u2510${RESET}`);
  lines.push(`${CYAN}\u2502${RESET}${BOLD}  Distribution Preview${''.padEnd(W - 22)}${CYAN}\u2502${RESET}`);
  lines.push(`${CYAN}\u251c${'\u2500'.repeat(W)}\u2524${RESET}`);
  lines.push(`${CYAN}\u2502${RESET}  Provider         Model               Weight   %    ${CYAN}\u2502${RESET}`);
  lines.push(`${CYAN}\u2502${RESET}  ${'\u2500'.repeat(51)}${CYAN}\u2502${RESET}`);

  for (const entry of entries) {
    const pct = totalWeight > 0 ? Math.round((entry.weight / totalWeight) * 100) : 0;
    const providerStr = entry.provider.slice(0, 16).padEnd(16);
    const modelStr = entry.model.slice(0, 18).padEnd(18);
    const weightStr = String(entry.weight).padStart(6);
    const pctStr = String(pct).padStart(3);
    lines.push(`${CYAN}\u2502${RESET}  ${providerStr} ${modelStr} ${weightStr}   ${pctStr}%${CYAN}\u2502${RESET}`);
  }

  lines.push(`${CYAN}\u2502${RESET}  ${'\u2500'.repeat(51)}${CYAN}\u2502${RESET}`);
  lines.push(`${CYAN}\u2502${RESET}  ${'Total:'.padEnd(37)}${String(totalWeight).padStart(6)}        ${CYAN}\u2502${RESET}`);
  lines.push(`${CYAN}\u2514${'\u2500'.repeat(W)}\u2518${RESET}`);

  return lines.join('\n');
}

/** Configure distribution entries with weights for a model.
 *  Returns array of {provider, model, weight} entries. */
async function configureDistribution(
  primaryProvider: string,
  primaryModel: string,
  providers: ConfiguredProvider[],
  onCancel: () => never,
): Promise<DistributionEntry[]> {
  const entries: DistributionEntry[] = [];

  // Collect weight for primary provider
  const primaryProviderObj = providers.find(p => p.id === primaryProvider);
  const primaryName = primaryProviderObj?.name ?? primaryProvider;

  const { primaryWeight } = await prompts(
    {
      type: 'number',
      name: 'primaryWeight',
      message: `[${primaryName}] Weight for this provider:`,
      initial: 1,
      min: 1,
    },
    onCancel,
  );

  entries.push({
    provider: primaryProvider,
    model: primaryModel,
    weight: primaryWeight as number,
  });

  // Loop to collect additional providers with weights
  while (true) {
    console.log();
    console.log(buildDistributionPreviewTable(entries));
    console.log();

    const { addAnother } = await prompts(
      {
        type: 'confirm',
        name: 'addAnother',
        message: 'Add another provider to distribution?',
        initial: false,
      },
      onCancel,
    );

    if (!addAnother) break;

    const availableProviders = providers.filter(p => !entries.some(e => e.provider === p.id));
    if (availableProviders.length === 0) {
      console.log(`  ${RED}No other providers available for distribution.${RESET}`);
      break;
    }

    const providerChoices = availableProviders.map((p) => ({ title: p.name, value: p.id }));
    const { providerId } = await prompts(
      {
        type: 'select',
        name: 'providerId',
        message: 'Select provider to add:',
        choices: [
          { title: '\u2B05  Go back', value: '__back__' },
          ...providerChoices,
        ],
      },
      onCancel,
    );

    if (providerId === '__back__') continue;

    const selectedProvider = providers.find((p) => p.id === (providerId as string))!;

    const { modelName } = await prompts(
      {
        type: 'text',
        name: 'modelName',
        message: `[${selectedProvider.name}] Model name:`,
        initial: primaryModel,
      },
      onCancel,
    );

    const { weight } = await prompts(
      {
        type: 'number',
        name: 'weight',
        message: `[${selectedProvider.name}] Weight:`,
        initial: 1,
        min: 1,
      },
      onCancel,
    );

    entries.push({
      provider: selectedProvider.id,
      model: (modelName as string).trim(),
      weight: weight as number,
    });

    check(`Added to distribution: ${selectedProvider.name} (weight: ${weight})`);
  }

  // Validate minimum 2 providers
  if (entries.length < 2) {
    console.log(`  ${RED}Distribution requires at least 2 providers. Converting to fallback mode.${RESET}`);
    return [];
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Fallback configuration helper
// ---------------------------------------------------------------------------

/** Prompt the user to add fallback providers for a model. Returns the fallbacks array. */
async function configureFallbacks(
  alias: string,
  primaryProviderId: string,
  providers: ConfiguredProvider[],
  existingFallbacks: { provider: string; model: string }[] = [],
): Promise<{ provider: string; model: string }[]> {
  const fallbacks = [...existingFallbacks];

  while (true) {
    try {
      const { addFallback } = await prompts(
        {
          type: 'confirm',
          name: 'addFallback',
          message: fallbacks.length === 0
            ? `Add a fallback provider for ${alias}?`
            : `Add another fallback provider for ${alias}?`,
          initial: false,
        },
        CANCEL,
      );

      if (!addFallback) break;

      const availableProviders = providers.filter(p => p.id !== primaryProviderId);
      if (availableProviders.length === 0) {
        console.log(`  ${RED}No other providers available for fallback.${RESET}`);
        break;
      }

      const providerChoices = availableProviders.map((p) => ({ title: p.name, value: p.id }));
      const { providerId } = await prompts(
        {
          type: 'select',
          name: 'providerId',
          message: `Select fallback provider for ${alias}:`,
          choices: [
            { title: '\u2B05  Go back', value: '__back__' },
            ...providerChoices,
          ],
        },
        CANCEL,
      );

      if (providerId === '__back__') continue;

      const selectedProvider = providers.find((p) => p.id === (providerId as string))!;
      const { modelName } = await prompts(
        {
          type: 'text',
          name: 'modelName',
          message: `[${selectedProvider.name}] Fallback model name:`,
          initial: '',
        },
        CANCEL,
      );

      fallbacks.push({
        provider: selectedProvider.id,
        model: (modelName as string).trim(),
      });

      check(`Added fallback: ${selectedProvider.id} \u2192 ${(modelName as string).trim()}`);
    } catch (err) {
      if (err instanceof GoBackError) break;
      throw err;
    }
  }

  return fallbacks;
}

// ---------------------------------------------------------------------------
// N-model configuration
// ---------------------------------------------------------------------------

/** Build a formatted table showing existing modelRouting entries. */
function buildExistingModelsTable(
  modelRouting: Map<string, { provider: string; model: string; weight?: number }[]>,
): string {
  const lines: string[] = [];
  const W = 56;
  const entries = [...modelRouting.entries()];

  lines.push(`${CYAN}${'\u250c' + '\u2500'.repeat(W) + '\u2510'}${RESET}`);
  lines.push(`${CYAN}\u2502${RESET}${BOLD}  Currently Configured Models${''.padEnd(W - 28)}${CYAN}\u2502${RESET}`);
  lines.push(`${CYAN}\u251c${'\u2500'.repeat(W)}\u2524${RESET}`);

  if (entries.length === 0) {
    lines.push(`${CYAN}\u2502${RESET}  (none)${''.padEnd(W - 7)}${CYAN}\u2502${RESET}`);
  } else {
    for (const [alias, chain] of entries) {
      const primary = chain[0];
      const hasWeights = chain.some(e => e.weight !== undefined);

      if (hasWeights) {
        // Distribution mode: show all entries with weights
        const totalWeight = chain.reduce((sum, e) => sum + (e.weight ?? 0), 0);
        const pct = totalWeight > 0 ? Math.round(((primary.weight ?? 0) / totalWeight) * 100) : 0;
        const info = `${alias.padEnd(16)} [dist] ${primary.provider} (${pct}%)`;
        lines.push(`${CYAN}\u2502${RESET}  ${info}${''.padEnd(Math.max(0, W - info.length - 2))}${CYAN}\u2502${RESET}`);
        for (let i = 1; i < chain.length; i++) {
          const entryPct = totalWeight > 0 ? Math.round(((chain[i].weight ?? 0) / totalWeight) * 100) : 0;
          const distInfo = `                      ${chain[i].provider} (${entryPct}%)`;
          lines.push(`${CYAN}\u2502${RESET}  ${distInfo}${''.padEnd(Math.max(0, W - distInfo.length - 2))}${CYAN}\u2502${RESET}`);
        }
      } else {
        // Fallback mode: show primary with fallbacks
        const info = `${alias.padEnd(20)} ${primary.provider} \u2192 ${primary.model}`;
        lines.push(`${CYAN}\u2502${RESET}  ${info}${''.padEnd(Math.max(0, W - info.length - 2))}${CYAN}\u2502${RESET}`);
        for (let i = 1; i < chain.length; i++) {
          const fbInfo = `                    fallback: ${chain[i].provider} \u2192 ${chain[i].model}`;
          lines.push(`${CYAN}\u2502${RESET}  ${fbInfo}${''.padEnd(Math.max(0, W - fbInfo.length - 2))}${CYAN}\u2502${RESET}`);
        }
      }
    }
  }

  lines.push(`${CYAN}${'\u2514' + '\u2500'.repeat(W) + '\u2518'}${RESET}`);
  return lines.join('\n');
}

async function configureModels(
  providers: ConfiguredProvider[],
  existingModels?: Map<string, { provider: string; model: string }[]>,
): Promise<ConfiguredModel[]> {
  const models: ConfiguredModel[] = [];
  const hasExisting = existingModels && existingModels.size > 0;

  // Seed models from existing modelRouting
  if (hasExisting) {
    for (const [alias, chain] of existingModels!.entries()) {
      const primary = chain[0];
      models.push({
        alias,
        provider: primary.provider,
        model: primary.model,
        fallbacks: chain.slice(1),
      });
    }
  }

  console.log();
  console.log('  Configure models \u2014 each model gets an alias that appears in Claude Code\'s /model picker.');
  console.log('  The proxy will route requests matching the alias to the chosen provider.');
  console.log();

  if (hasExisting) {
    // Editing existing config: show current models, then offer add/edit/delete menu
    while (true) {
      console.log(buildExistingModelsTable(existingModels!));
      console.log();

      const { action } = await prompts({
        type: 'select',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { title: 'Add new model', value: 'add', description: 'Add a model alias routed to a provider' },
          ...(models.length > 0 ? [{ title: 'Edit existing model', value: 'edit', description: 'Change alias, provider, or model name' }] : []),
          ...(models.length > 0 ? [{ title: 'Delete model', value: 'delete', description: 'Remove a model alias' }] : []),
          { title: 'Done', value: 'done', description: 'Continue to server configuration' },
        ],
      }, CANCEL);

      if (action === 'done') break;

      if (action === 'add') {
        const providerChoices = providers.map((p) => ({ title: p.name, value: p.id }));
        const { providerId } = await prompts(
          {
            type: 'select',
            name: 'providerId',
            message: 'Select provider:',
            choices: [
              { title: '\u2B05  Go back', value: '__back__' },
              ...providerChoices,
            ],
          },
          CANCEL,
        );

        if (providerId === '__back__') continue;

        const selectedProvider = providers.find((p) => p.id === (providerId as string))!;
        const { alias } = await prompts(
          {
            type: 'text',
            name: 'alias',
            message: `[${selectedProvider.name}] Model alias (name in /model picker):`,
            initial: '',
          },
          CANCEL,
        );

        const { modelName } = await prompts(
          {
            type: 'text',
            name: 'modelName',
            message: `[${selectedProvider.name}] Actual model name (sent to provider API):`,
            initial: alias as string,
          },
          CANCEL,
        );

        const newModel: ConfiguredModel = {
          alias: (alias as string).trim(),
          provider: selectedProvider.id,
          model: (modelName as string).trim(),
          fallbacks: [],
        };

        // Ask about distribution vs fallback
        const { enableDistribution } = await prompts({
          type: 'confirm',
          name: 'enableDistribution',
          message: 'Enable traffic distribution across multiple providers?',
          initial: false,
        }, CANCEL);

        if (enableDistribution) {
          // Distribution mode
          const entries = await configureDistribution(
            selectedProvider.id,
            (modelName as string).trim(),
            providers,
            () => { throw new GoBackError(); },
          );

          if (entries.length >= 2) {
            newModel.entries = entries;
            // For distribution, set primary from first entry
            newModel.provider = entries[0].provider;
            newModel.model = entries[0].model;
            check(`Added model with distribution: ${newModel.alias} (${entries.length} providers)`);
          } else {
            // Not enough providers, fall back to normal fallback flow
            newModel.fallbacks = await configureFallbacks(
              newModel.alias, newModel.provider, providers, newModel.fallbacks,
            );
            check(`Added model: ${newModel.alias}`);
          }
        } else {
          // Fallback mode
          newModel.fallbacks = await configureFallbacks(
            newModel.alias, newModel.provider, providers, newModel.fallbacks,
          );
          check(`Added model: ${newModel.alias}`);
        }

        models.push(newModel);
        // Update the existing map so the table stays current
        if (newModel.entries && newModel.entries.length > 0) {
          existingModels!.set(newModel.alias, newModel.entries);
        } else {
          existingModels!.set(newModel.alias, [
            { provider: newModel.provider, model: newModel.model },
            ...newModel.fallbacks,
          ]);
        }
      }

      if (action === 'edit') {
        const modelChoices = models.map((m) => ({
          title: m.alias,
          value: m.alias,
          description: `${m.provider} \u2192 ${m.model}`,
        }));
        const { editAlias } = await prompts({
          type: 'select',
          name: 'editAlias',
          message: 'Select model to edit:',
          choices: [
            { title: '\u2B05  Go back', value: '__back__' },
            ...modelChoices,
          ],
        }, CANCEL);

        if (editAlias === '__back__') continue;

        const idx = models.findIndex((m) => m.alias === editAlias);
        if (idx === -1) continue;

        const current = models[idx];
        let currentFallbacks = [...current.fallbacks];

        // If alias changed, remove old entry from existing map
        const { alias } = await prompts(
          {
            type: 'text',
            name: 'alias',
            message: `Model alias:`,
            initial: current.alias,
          },
          CANCEL,
        );

        const providerChoices = providers.map((p) => ({ title: p.name, value: p.id }));
        const { providerId } = await prompts(
          {
            type: 'select',
            name: 'providerId',
            message: 'Select provider:',
            choices: [
              { title: '\u2B05  Go back', value: '__back__' },
              ...providerChoices,
            ],
          },
          CANCEL,
        );

        if (providerId === '__back__') continue;

        const selectedProvider = providers.find((p) => p.id === (providerId as string))!;
        const { modelName } = await prompts(
          {
            type: 'text',
            name: 'modelName',
            message: `Actual model name:`,
            initial: current.model,
          },
          CANCEL,
        );

        const newAlias = (alias as string).trim();
        const newModel = (modelName as string).trim();

        // Fallback management loop
        while (true) {
          // Show current fallbacks
          if (currentFallbacks.length === 0) {
            console.log(`  ${CYAN}No fallbacks configured.${RESET}`);
          } else {
            console.log(`  ${CYAN}Current fallbacks:${RESET}`);
            for (let i = 0; i < currentFallbacks.length; i++) {
              const fb = currentFallbacks[i];
              const fbProvider = providers.find(p => p.id === fb.provider);
              const fbPName = fbProvider ? fbProvider.name : fb.provider;
              console.log(`    ${i + 1}. ${fbPName} \u2192 ${fb.model}`);
            }
          }
          console.log();

          const fallbackActions = [
            { title: 'Add fallback', value: 'add_fb' },
            ...(currentFallbacks.length > 0 ? [{ title: 'Remove fallback', value: 'remove_fb' }] : []),
            { title: 'Done editing fallbacks', value: 'done_fb' },
          ];

          const { fallbackAction } = await prompts({
            type: 'select',
            name: 'fallbackAction',
            message: 'Manage fallbacks:',
            choices: fallbackActions,
          }, CANCEL);

          if (fallbackAction === 'done_fb') break;

          if (fallbackAction === 'add_fb') {
            const newFb = await configureFallbacks(
              newAlias, selectedProvider.id, providers, currentFallbacks,
            );
            currentFallbacks = newFb;
          }

          if (fallbackAction === 'remove_fb') {
            const fbChoices = currentFallbacks.map((fb, i) => {
              const fbProvider = providers.find(p => p.id === fb.provider);
              const fbPName = fbProvider ? fbProvider.name : fb.provider;
              return { title: `${fbPName} \u2192 ${fb.model}`, value: i };
            });
            const { removeIdx } = await prompts({
              type: 'select',
              name: 'removeIdx',
              message: 'Select fallback to remove:',
              choices: [
                { title: '\u2B05  Go back', value: '__back__' },
                ...fbChoices,
              ],
            }, CANCEL);

            if (removeIdx !== '__back__') {
              const removed = currentFallbacks.splice(removeIdx as number, 1);
              check(`Removed fallback: ${removed[0].provider} \u2192 ${removed[0].model}`);
            }
          }
        }

        // If alias changed, remove old entry from existing map
        if (newAlias !== current.alias) {
          existingModels!.delete(current.alias);
        }

        models[idx] = {
          alias: newAlias,
          provider: selectedProvider.id,
          model: newModel,
          fallbacks: currentFallbacks,
        };

        // Update existing map with full chain including fallbacks
        existingModels!.set(newAlias, [
          { provider: selectedProvider.id, model: newModel },
          ...currentFallbacks,
        ]);

        check(`Updated model: ${newAlias} (${selectedProvider.id} \u2192 ${newModel})`);
      }

      if (action === 'delete') {
        const modelChoices = models.map((m) => ({
          title: m.alias,
          value: m.alias,
          description: `${m.provider} \u2192 ${m.model}`,
        }));
        const { deleteAlias } = await prompts({
          type: 'select',
          name: 'deleteAlias',
          message: 'Select model to delete:',
          choices: [
            { title: '\u2B05  Go back', value: '__back__' },
            ...modelChoices,
          ],
        }, CANCEL);

        if (deleteAlias === '__back__') continue;

        const idx = models.findIndex((m) => m.alias === deleteAlias);
        if (idx !== -1) {
          models.splice(idx, 1);
          existingModels!.delete(deleteAlias as string);
          check(`Deleted model: ${deleteAlias as string}`);
        }
      }

      clearScreen();
    }
  } else {
    // Fresh setup: auto-suggest one model per provider using preset defaults
    for (const provider of providers) {
      const { addModel } = await prompts(
        {
          type: 'confirm',
          name: 'addModel',
          message: `Add a model for ${provider.name}?`,
          initial: true,
        },
        CANCEL,
      );

      if (addModel) {
        const presetModel = provider.models?.sonnet || provider.models?.opus || provider.models?.haiku || '';
        const { alias } = await prompts(
          {
            type: 'text',
            name: 'alias',
            message: `[${provider.name}] Model alias (name in /model picker):`,
            initial: presetModel || provider.id,
          },
          CANCEL,
        );

        const { modelName } = await prompts(
          {
            type: 'text',
            name: 'modelName',
            message: `[${provider.name}] Actual model name (sent to provider API):`,
            initial: presetModel,
          },
          CANCEL,
        );

        const newModel: ConfiguredModel = {
          alias: (alias as string).trim(),
          provider: provider.id,
          model: (modelName as string).trim(),
          fallbacks: [],
        };

        // Configure fallbacks for this model
        newModel.fallbacks = await configureFallbacks(
          newModel.alias, newModel.provider, providers, newModel.fallbacks,
        );

        models.push(newModel);
      }
    }

    // Allow adding additional models
    while (true) {
      console.log();
      const { addMore } = await prompts(
        {
          type: 'confirm',
          name: 'addMore',
          message: models.length === 0
            ? 'Add a model?'
            : 'Add another model?',
          initial: models.length === 0,
        },
        CANCEL,
      );

      if (!addMore) break;

      const providerChoices = providers.map((p) => ({ title: p.name, value: p.id }));
      const { providerId } = await prompts(
        {
          type: 'select',
          name: 'providerId',
          message: 'Select provider:',
          choices: providerChoices,
        },
        CANCEL,
      );

      const selectedProvider = providers.find((p) => p.id === (providerId as string))!;
      const { alias } = await prompts(
        {
          type: 'text',
          name: 'alias',
          message: `[${selectedProvider.name}] Model alias:`,
          initial: '',
        },
        CANCEL,
      );

      const { modelName } = await prompts(
        {
          type: 'text',
          name: 'modelName',
          message: `[${selectedProvider.name}] Actual model name:`,
          initial: alias as string,
        },
        CANCEL,
      );

      const newModel: ConfiguredModel = {
        alias: (alias as string).trim(),
        provider: selectedProvider.id,
        model: (modelName as string).trim(),
        fallbacks: [],
      };

      // Configure fallbacks for this model
      newModel.fallbacks = await configureFallbacks(
        newModel.alias, newModel.provider, providers, newModel.fallbacks,
      );

      models.push(newModel);
    }
  }

  if (models.length === 0) {
    console.log('  No models configured.');
  } else {
    check(`${models.length} model(s) configured`);
  }

  return models;
}

// ---------------------------------------------------------------------------
// Port collision detection
// ---------------------------------------------------------------------------

function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => { server.close(); resolve(true); });
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port, host);
  });
}

// [Modified] configureServer — supports useDefaults for --quick mode
async function configureServer(
  options?: { useDefaults?: boolean; stepInfo?: { current: number; total: number } },
): Promise<{ port: number; host: string }> {
  if (options?.useDefaults) {
    return { port: 3456, host: 'localhost' };
  }

  const stepLabel = options?.stepInfo ? `[Step ${options.stepInfo.current} of ${options.stepInfo.total}] ` : '';

  const { port } = await prompts(
    { type: 'number', name: 'port', message: `${stepLabel}Server port:`, initial: 3456 },
    CANCEL,
  );
  const { host } = await prompts(
    { type: 'text', name: 'host', message: `${stepLabel}Server host:`, initial: 'localhost' },
    CANCEL,
  );

  // Port collision check
  if (await isPortInUse(port as number, host as string)) {
    console.log(`  ${RED}\u26A0 Warning:${RESET} Port ${port} is already in use on ${host}.`);
    const { proceed } = await prompts(
      { type: 'confirm', name: 'proceed', message: 'Use this port anyway?', initial: false },
      CANCEL,
    );
    if (!proceed) {
      console.log('  Please choose a different port and try again.');
      process.exit(1);
    }
  }

  return { port: port as number, host: host as string };
}

interface SettingsConfig {
  defaultModel: string;
  availableModels: string[];
}

async function configureClaudeCodeSettings(
  models: ConfiguredModel[],
): Promise<SettingsConfig | null> {
  if (models.length === 0) return null;

  try {
    console.log();

    const { configure } = await prompts(
      {
        type: 'confirm',
        name: 'configure',
        message: 'Configure Claude Code to use ModelWeaver automatically?',
        initial: true,
      },
      CANCEL,
    );

    if (!configure) return null;

    const { defaultModel } = await prompts(
      {
        type: 'select',
        name: 'defaultModel',
        message: 'Select default model for Claude Code:',
        choices: models.map((m) => ({
          title: m.alias,
          description: `${m.provider} \u2192 ${m.model}`,
          value: m.alias,
        })),
      },
      CANCEL,
    );

    const availableModels = models.map((m) => m.alias);

    return { defaultModel: defaultModel as string, availableModels };
  } catch (err) {
    if (err instanceof GoBackError) return null;
    throw err;
  }
}

function buildYamlConfig(
  providers: ConfiguredProvider[],
  models: ConfiguredModel[],
  server: { port: number; host: string },
  existingProviders?: Map<string, ExistingProvider>,
  existingModelRouting?: Map<string, { provider: string; model: string }[]>,
): string {
  // Build modelRouting from configured models (primary + fallbacks)
  const modelRouting: Record<string, { provider: string; model: string }[]> = {};
  for (const m of models) {
    modelRouting[m.alias] = [
      { provider: m.provider, model: m.model },
      ...m.fallbacks,
    ];
  }
  // For any models in existing routing that are NOT in the current models list,
  // preserve them as-is (backward compatibility)
  if (existingModelRouting) {
    for (const [alias, chain] of existingModelRouting.entries()) {
      if (!modelRouting[alias]) {
        modelRouting[alias] = chain.map(e => ({ provider: e.provider, model: e.model }));
      }
    }
  }

  const configObj: {
    server: { port: number; host: string };
    providers: Record<string, Record<string, unknown>>;
    modelRouting: Record<string, { provider: string; model: string }[]>;
  } = {
    server,
    providers: {},
    modelRouting,
  };

  for (const p of providers) {
    const providerConfig: Record<string, unknown> = {
      baseUrl: p.baseUrl,
      apiKey: `\${${p.envKey}}`,
      timeout: 30000,
    };
    if (p.authType === "bearer") {
      providerConfig.authType = "bearer";
    }
    configObj.providers[p.id] = providerConfig;
  }

  // Merge in untouched existing providers (preserved verbatim)
  if (existingProviders) {
    const touchedIds = new Set(providers.map(p => p.id));
    for (const [id, ep] of existingProviders.entries()) {
      if (!touchedIds.has(id)) {
        const providerConfig: Record<string, unknown> = {
          baseUrl: ep.baseUrl,
          apiKey: ep.envKey ? `\${${ep.envKey}}` : "",
          timeout: ep.timeout,
        };
        if (ep.authType === "bearer") {
          providerConfig.authType = "bearer";
        }
        configObj.providers[id] = providerConfig;
      }
    }
  }

  return stringifyYaml(configObj);
}

function writeEnvFile(entries: ConfiguredProvider[]): void {
  const envDir = join(process.env.HOME || process.env.USERPROFILE || '', '.modelweaver');
  const envPath = join(envDir, '.env');
  mkdirSync(envDir, { recursive: true });
  let existing = '';

  if (existsSync(envPath)) {
    existing = readFileSync(envPath, 'utf-8');
  }

  if (existing && !existing.endsWith('\n')) existing += '\n';

  const lines: string[] = [];

  for (const entry of entries) {
    // Escape regex metacharacters in env key name
    const escapedKey = entry.envKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedKey}=.*$`, 'm');
    const quotedValue = entry.apiKey.includes('"')
      ? (entry.apiKey.includes("'") ? `'${entry.apiKey.replace(/'/g, "'\\''")}'` : `'${entry.apiKey}'`)
      : `"${entry.apiKey}"`;
    if (regex.test(existing)) {
      existing = existing.replace(regex, `${entry.envKey}=${quotedValue}`);
    } else {
      lines.push(`${entry.envKey}=${quotedValue}`);
    }
  }


  writeFileSync(envPath, existing + lines.join('\n') + (lines.length > 0 ? '\n' : ''), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// [Improvement 3] runQuickInit — --quick / -q express mode
// ---------------------------------------------------------------------------

async function runQuickInit(): Promise<void> {
  // Step 0 — TTY check
  if (!process.stdin.isTTY) {
    console.error('Error: modelweaver init --quick requires an interactive terminal.');
    process.exit(1);
  }

  // Peek at existing config for merge support
  const { peekConfig } = await import('./config.js');
  const existingPeek = peekConfig();
  const existingProviderMap = existingPeek?.providers ?? new Map();
  const existingModelRouting = existingPeek?.modelRouting ?? new Map();

  let configured: ConfiguredProvider[] = [];
  let configuredModels: ConfiguredModel[] = [];
  let server: { port: number; host: string };
  let yaml: string;

  const totalSteps = calculateTotalSteps(1, true);

  let pastFirstStep = false;

  while (true) {
    try {
      // Welcome
      clearScreen();
      console.log(`
${BOLD}${CYAN}\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510\u2500
\u2502       Welcome to ModelWeaver!        \u2501 Quick Setup \u2502
\u2502                                      \u2502
\u2501  ~${String(totalSteps).padEnd(3)} quick steps to get started    \u2501
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${RESET}
`);

      // Step 1: Select single provider
      const selectedIds = await selectProviders({ singleSelect: true });
      pastFirstStep = true;

      if (selectedIds.length === 1 && selectedIds[0] === '__back__') {
        continue; // Go back — restart quick setup loop
      }

      // Step 2: Configure provider (auto-detects env key)
      configured = [];
      for (const id of selectedIds) {
        const provider = await configureProvider(id, { current: 1, total: totalSteps });
        if (provider) configured.push(provider);
      }

      if (configured.length === 0) {
        console.log(`\n  ${RED}No providers configured. Exiting.${RESET}\n`);
        process.exit(1);
      }

      // Auto-configure models from single provider's presets
      const provider = configured[0];
      configuredModels = [];
      for (const [tier, modelName] of Object.entries(provider.models)) {
        if (modelName) {
          configuredModels.push({ alias: modelName, provider: provider.id, model: modelName, fallbacks: [] });
        }
      }

      // Server defaults (no prompts)
      server = { port: 3456, host: 'localhost' };

      // Step 3: Summary + Confirm
      yaml = buildYamlConfig(configured, configuredModels, server, existingProviderMap, existingModelRouting);
      console.log(`\n${BOLD}  Generated configuration:${RESET}\n`);
      console.log(buildSummaryTable(configured, configuredModels, server));
      console.log();
      console.log(yaml.split('\n').map((l) => `  ${l}`).join('\n'));

      const { confirm } = await prompts(
        { type: 'confirm', name: 'confirm', message: `[Step 2 of ${totalSteps}] Write this configuration?`, initial: true },
        CANCEL,
      );

      if (confirm) break;

      console.log('\n  Restarting quick setup...\n');
    } catch (err) {
      if (err instanceof GoBackError) {
        if (!pastFirstStep) {
          console.log('\n  Setup cancelled. No files were changed.');
          process.exit(0);
        }
        continue;
      }
      throw err;
    }
  }

  // Write files
  await writeConfigAndSettings(configured, configuredModels, server, yaml, totalSteps, true, !!existingPeek);
}

// ---------------------------------------------------------------------------
// Shared file-writing + settings logic
// ---------------------------------------------------------------------------

async function writeConfigAndSettings(
  configured: ConfiguredProvider[],
  models: ConfiguredModel[],
  server: { port: number; host: string },
  yaml: string,
  totalSteps: number,
  quick?: boolean,
  hasExisting?: boolean,
): Promise<SettingsConfig | null> {
  const modelweaverDir = join(process.env.HOME || process.env.USERPROFILE || '', '.modelweaver');
  mkdirSync(modelweaverDir, { recursive: true });
  const configPath = join(modelweaverDir, 'config.yaml');
  if (existsSync(configPath) && hasExisting) {
    check(`Updating existing config at ${configPath}`);
  } else {
    check(`Writing new config to ${configPath}`);
  }
  writeFileSync(configPath, yaml);
  writeEnvFile(configured);

  // Signal daemon to reload config if it's running
  try {
    const { readPidFile, isProcessAlive } = await import('./daemon.js');
    const pid = await readPidFile();
    if (pid && isProcessAlive(pid)) {
      if (process.platform !== "win32") {
        try { process.kill(pid, 'SIGUSR1'); } catch { /* process may not exist */ }
      } else {
        console.log("  Windows does not support SIGUSR1 \u2014 run 'modelweaver reload' to pick up new config.");
      }
      check('ModelWeaver daemon reloaded with new config');
    }
  } catch {
    // Daemon not running or daemon.js not available — silently ignore
  }

  // Configure Claude Code settings.json
  const result = await configureClaudeCodeSettings(models);

  if (result) {
    const baseUrl = server.host === 'localhost'
      ? `http://localhost:${server.port}`
      : `http://${server.host}:${server.port}`;

    const didBackup = backupSettings();
    if (didBackup) {
      console.log(`  Backed up existing settings to settings.json.bak`);
    }

    const existing = readSettings();
    const merged = mergeSettings(existing, {
      baseUrl,
      defaultModel: result.defaultModel,
      availableModels: result.availableModels,
    });
    writeSettings(merged);

    check(`Claude Code settings updated at ${getSettingsPath()}`);
    console.log(`    Proxy endpoint:   ${baseUrl}`);
    console.log(`    Default model:    ${result.defaultModel}`);
    console.log(`    Available models: ${result.availableModels.join(', ')}`);
    console.log();
    console.log(`  ${GREEN}Restart Claude Code to apply changes.${RESET}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main wizard (normal mode)
// ---------------------------------------------------------------------------

// Phase constants for the phase-based loop
const PHASE_PROVIDERS = 0;
const PHASE_MODELS = 1;
const PHASE_SERVER = 2;
const PHASE_CONFIRM = 3;

export async function runInit(options?: { quick?: boolean }): Promise<void> {
  if (options?.quick) {
    return runQuickInit();
  }

  // Step 0 — TTY check
  if (!process.stdin.isTTY) {
    console.error('Error: modelweaver init requires an interactive terminal.');
    process.exit(1);
  }

  // Peek at existing config for provider detection + merge
  const { peekConfig } = await import('./config.js');
  const existingPeek = peekConfig();
  const existingProviderMap = existingPeek?.providers ?? new Map();
  const existingModelRouting = existingPeek?.modelRouting ?? new Map();
  const hasExisting = existingProviderMap.size > 0;

  // State that persists across phases (go-back preserves these)
  let configured: ConfiguredProvider[] = [];
  let configuredModels: ConfiguredModel[] = [];
  let allProviders: ConfiguredProvider[] = [];
  let server: { port: number; host: string } = { port: 3456, host: 'localhost' };
  let yaml: string;
  let settingsConfig: SettingsConfig | null = null;
  let useExistingModels = hasExisting;

  let phase = PHASE_PROVIDERS;

  while (true) {
    try {
    // ── PHASE: Provider configuration ──
    if (phase <= PHASE_PROVIDERS) {
      // Step 1 — Welcome
      clearScreen();
      console.log(`
${BOLD}${CYAN}\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\u2500
\u2551       Welcome to ModelWeaver!        \u2551
\u2551                                      \u2551
\u2551  This wizard will help you configure \u2551
\u2551  your multi-provider model proxy.    \u2551
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D${RESET}
`);

      if (hasExisting) {
        // Show existing providers + action menu
        console.log(`\n${buildExistingProvidersTable(existingProviderMap)}\n`);

        const { action } = await prompts({
          type: 'select',
          name: 'action',
          message: 'What would you like to do?',
          choices: [
            { title: 'Add new provider(s)', value: 'add', description: 'Keep existing, add more' },
            { title: 'Edit existing provider', value: 'edit', description: 'Modify settings of a configured provider' },
            { title: 'Reconfigure all from scratch', value: 'reset', description: 'Start over (existing providers will be replaced)' },
          ],
        }, CANCEL);

        if (action === 'add') {
          const excludeIds = new Set(existingProviderMap.keys());
          const selectedIds = await selectProviders({ excludeIds });
          if (selectedIds.length === 0) {
            console.log('  No additional providers selected. All existing providers preserved.');
          }
          const totalSteps = calculateTotalSteps(
            existingProviderMap.size + selectedIds.length, false
          );
          configured = [];
          for (let i = 0; i < selectedIds.length; i++) {
            const provider = await configureProvider(
              selectedIds[i],
              { current: 1 + i, total: totalSteps }
            );
            if (provider) configured.push(provider);
          }
        } else if (action === 'edit') {
          const existingIds = [...existingProviderMap.keys()];
          const { editId } = await prompts({
            type: 'select',
            name: 'editId',
            message: 'Select provider to edit:',
            choices: [
              { title: '\u2B05  Go back', value: '__back__' },
              ...existingIds.map(id => {
                const p = existingProviderMap.get(id)!;
                return { title: id, value: id, description: p.baseUrl };
              }),
            ],
          }, CANCEL);
          if (editId === '__back__') {
            continue; // Go back to the main action menu
          }
          const existing = existingProviderMap.get(editId as string)!;
          const totalSteps = calculateTotalSteps(existingProviderMap.size, false);
          const provider = await configureProvider(
            editId as string,
            { current: 1, total: totalSteps },
            existing,
          );
          configured = provider ? [provider] : [];
        } else {
          // 'reset' — fresh start, clear existing map so nothing gets merged
          existingProviderMap.clear();
          existingModelRouting.clear();
          useExistingModels = false;
          const selectedIds = await selectProviders();
          const totalSteps = calculateTotalSteps(selectedIds.length, false);
          configured = [];
          for (let i = 0; i < selectedIds.length; i++) {
            const provider = await configureProvider(selectedIds[i], { current: 1 + i, total: totalSteps });
            if (provider) configured.push(provider);
          }
        }

        if (configured.length === 0 && (existingProviderMap.size === 0)) {
          console.log(`\n  ${RED}No providers configured. Exiting.${RESET}\n`);
          process.exit(1);
        }
      } else {
        // ── FRESH SETUP (original flow, no changes) ──
        const selectedIds = await selectProviders();
        const totalSteps = calculateTotalSteps(selectedIds.length, false);
        configured = [];
        for (let i = 0; i < selectedIds.length; i++) {
          const provider = await configureProvider(selectedIds[i], { current: 1 + i, total: totalSteps });
          if (provider) configured.push(provider);
        }

        if (configured.length === 0) {
          console.log(`\n  ${RED}No providers configured. Exiting.${RESET}\n`);
          process.exit(1);
        }
      }

      // Build the full provider list: configured (new/edited) + untouched existing
      allProviders = buildAllProviders(configured, existingProviderMap);
      phase = PHASE_MODELS;
    }

    // ── PHASE: Model configuration ──
    if (phase <= PHASE_MODELS) {
      // Configure models (N-model flow)
      configuredModels = await configureModels(allProviders, useExistingModels ? existingModelRouting : undefined);

      // Navigation prompt: continue to server config or go back to providers
      const { nav } = await prompts({
        type: 'select',
        name: 'nav',
        message: 'Next step:',
        choices: [
          { title: 'Continue to server configuration', value: 'next', description: 'Configure port and host' },
          { title: 'Go back to provider configuration', value: 'back', description: 'Reconfigure providers' },
        ],
      }, CANCEL);

      if (nav === 'back') {
        phase = PHASE_PROVIDERS;
        continue;
      }

      phase = PHASE_SERVER;
    }

    // ── PHASE: Server configuration ──
    if (phase <= PHASE_SERVER) {
      // Server config
      console.log();
      const totalSteps = calculateTotalSteps(allProviders.length, false);
      const serverStep = allProviders.length + 2; // providers + models + server
      server = await configureServer({ stepInfo: { current: serverStep, total: totalSteps } });

      // Navigation prompt: continue to review or go back to models
      const { nav } = await prompts({
        type: 'select',
        name: 'nav',
        message: 'Next step:',
        choices: [
          { title: 'Review and write configuration', value: 'next', description: 'Confirm and save' },
          { title: 'Go back to model configuration', value: 'back', description: 'Reconfigure models' },
        ],
      }, CANCEL);

      if (nav === 'back') {
        phase = PHASE_MODELS;
        continue;
      }

      phase = PHASE_CONFIRM;
    }

    // ── PHASE: Review & confirm ──
    if (phase <= PHASE_CONFIRM) {
      // Review & confirm
      yaml = buildYamlConfig(allProviders, configuredModels, server, existingProviderMap, existingModelRouting);
      console.log(`\n${BOLD}  Generated configuration:${RESET}\n`);
      console.log(buildSummaryTable(allProviders, configuredModels, server));
      console.log();
      console.log(yaml.split('\n').map((l) => `  ${l}`).join('\n'));

      const totalSteps = calculateTotalSteps(allProviders.length, false);
      const confirmStep = allProviders.length + 3; // providers + models + server + confirm
      const { confirm } = await prompts(
        { type: 'confirm', name: 'confirm', message: `[Step ${confirmStep} of ${totalSteps}] Write this configuration?`, initial: true },
        CANCEL,
      );

      if (confirm) break;

      // Go back to server configuration instead of restarting the entire wizard
      console.log('\n  Returning to server configuration...\n');
      phase = PHASE_SERVER;
      continue;
    }
    } catch (err) {
      if (err instanceof GoBackError) {
        if (phase === PHASE_PROVIDERS) {
          console.log('\n  Setup cancelled. No files were changed.');
          process.exit(0);
        }
        phase--;
        continue;
      }
      throw err;
    }
  }

  // Write files + settings
  const finalTotalSteps = calculateTotalSteps(configured.length, false);
  settingsConfig = await writeConfigAndSettings(configured, configuredModels, server, yaml, finalTotalSteps, false, hasExisting);

  // Step 8 — Success banner
  console.log(`
${BOLD}${CYAN}\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551  ModelWeaver is configured!                    \u2551
\u2551                                                \u2551
${settingsConfig
  ? `\u2551  Claude Code settings have been updated.       \u2551
\u2551                                                \u2551
\u2551  Just restart Claude Code to get started.      \u2551`
  : `\u2551  To use with Claude Code:                      \u2551
\u2551                                                \u2551
\u2551  Terminal 1:                                   \u2551
\u2551    modelweaver                                 \u2551
\u2551                                                \u2551
\u2551  Terminal 2:                                   \u2551
\u2551    export ANTHROPIC_BASE_URL=\\                 \u2551
\u2551      http://localhost:${String(server.port).padEnd(25)}\u2551
\u2551    claude                                      \u2551`
}
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D${RESET}
`);
}
