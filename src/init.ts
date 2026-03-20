// src/init.ts — Interactive setup wizard for ModelWeaver
import prompts from 'prompts';
import { getPresets, getPreset, type ProviderPreset } from './presets.js';
import { stringify as stringifyYaml } from 'yaml';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSettings, backupSettings, mergeSettings, writeSettings, getSettingsPath } from './settings.js';

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

interface RoutingTier {
  provider: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CANCEL = { onCancel: () => { console.log('\n  Setup cancelled. No files were changed.'); process.exit(0); } };

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
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
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
    // Provider select + API key (may be skipped) + confirm + claude settings
    return 4;
  }
  // Normal mode:
  // 1 (select providers) + N (configure each) + routing tiers + server + confirm + claude settings
  let steps = 1 + selectedProviderCount + 1 + 1 + 1 + 1; // select + configure each + server + confirm + claude settings + settings prompt
  if (selectedProviderCount > 1) {
    steps += 3; // 3 routing tiers (only for multi-provider)
  }
  return steps;
}

// ---------------------------------------------------------------------------
// [Improvement 5] autoRoutingForSingleProvider — skip routing for single
// ---------------------------------------------------------------------------

function autoRoutingForSingleProvider(provider: ConfiguredProvider): Record<string, RoutingTier[]> {
  const tiers = ['sonnet', 'opus', 'haiku'] as const;
  const routing: Record<string, RoutingTier[]> = {};
  for (const tier of tiers) {
    routing[tier] = [{ provider: provider.id, model: provider.models[tier] }];
  }
  return routing;
}

// ---------------------------------------------------------------------------
// [Improvement 7] buildSummaryTable — formatted summary
// ---------------------------------------------------------------------------

function buildSummaryTable(
  providers: ConfiguredProvider[],
  routing: Record<string, RoutingTier[]>,
  server: { port: number; host: string },
): string {
  const lines: string[] = [];
  const W = 56;

  lines.push(`${CYAN}\u250c${'\u2500'.repeat(W)}\u2510${RESET}`);
  lines.push(`${CYAN}\u2502${RESET}${BOLD}  ModelWeaver Configuration Summary${''.padEnd(W - 33)}${CYAN}\u2502${RESET}`);
  lines.push(`${CYAN}\u251c${'\u2500'.repeat(W)}\u2524${RESET}`);
  lines.push(`${CYAN}\u2502${RESET}  ${BOLD}Server:${RESET} ${server.host}:${server.port}${''.padEnd(W - 8 - `${server.host}:${server.port}`.length)}${CYAN}\u2502${RESET}`);
  lines.push(`${CYAN}\u251c${'\u2500'.repeat(W)}\u2524${RESET}`);

  const tiers = ['sonnet', 'opus', 'haiku'] as const;
  for (const tier of tiers) {
    const entries = routing[tier];
    if (!entries || entries.length === 0) continue;
    const primary = providers.find(p => p.id === entries[0].provider);
    const pName = primary ? primary.name : entries[0].provider;
    const label = `${BOLD}${tier.charAt(0).toUpperCase() + tier.slice(1)}:${RESET}`;
    const primaryInfo = `${pName} \u2192 ${entries[0].model}`;
    lines.push(`${CYAN}\u2502${RESET}  ${label} ${primaryInfo}${''.padEnd(W - 10 - primaryInfo.length)}${CYAN}\u2502${RESET}`);

    for (let i = 1; i < entries.length; i++) {
      const fb = providers.find(p => p.id === entries[i].provider);
      const fbName = fb ? fb.name : entries[i].provider;
      const fbInfo = `  fallback: ${fbName} \u2192 ${entries[i].model}`;
      lines.push(`${CYAN}\u2502${RESET}${fbInfo}${''.padEnd(W - fbInfo.length - 2)}${CYAN}\u2502${RESET}`);
    }
  }

  lines.push(`${CYAN}\u2514${'\u2500'.repeat(W)}\u2518${RESET}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------

// [Modified] selectProviders — supports singleSelect for --quick mode
async function selectProviders(options?: { singleSelect?: boolean }): Promise<string[]> {
  const allPresets = getPresets();

  if (options?.singleSelect) {
    const { providerId } = await prompts(
      {
        type: 'select',
        name: 'providerId',
        message: 'Select a provider:',
        choices: allPresets.map((p) => ({ title: p.name, value: p.id, description: p.baseUrl })),
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

// [Modified] configureProvider — auto-detect env keys + step counter
async function configureProvider(
  id: string,
  stepInfo?: { current: number; total: number },
): Promise<ConfiguredProvider | null> {
  const preset = getPreset(id);
  if (!preset) {
    console.error(`  Error: Unknown provider "${id}". Skipping.`);
    return null;
  }

  // [Improvement 1] Auto-detect existing env key
  const detected = detectEnvApiKey(preset);
  if (detected.found) {
    process.stdout.write(`  Testing API key for ${preset.name} (from ${detected.source})...`);
    const result = await testApiKey(preset.baseUrl, detected.key, preset);
    process.stdout.write('\r' + ' '.repeat(60) + '\r');

    if (result.ok) {
      check(`${preset.name}: using existing ${preset.envKey} (${detected.source})`);
      return {
        id, name: preset.name, baseUrl: preset.baseUrl,
        envKey: preset.envKey, apiKey: detected.key,
        authType: preset.authType, models: preset.models,
      };
    }

    // Key found but invalid — fall through to prompt
    console.log(`  ${RED}\u26A0${RESET} Existing ${preset.envKey} (${detected.source}) is invalid, please provide a new key.`);
  }

  const stepLabel = stepInfo ? `[Step ${stepInfo.current} of ${stepInfo.total}] ` : '';

  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { baseUrl } = await prompts(
      { type: 'text', name: 'baseUrl', message: `${stepLabel}[${preset.name}] Base URL:`, initial: preset.baseUrl },
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
      return { id, name: preset.name, baseUrl: baseUrl as string, envKey: preset.envKey, apiKey: apiKey as string, authType: preset.authType, models: preset.models };
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

// [Modified] configureRouting — skip for single provider + fallback defaults + step counter
async function configureRouting(
  providers: ConfiguredProvider[],
  options?: { stepOffset?: number; totalSteps?: number },
): Promise<Record<string, RoutingTier[]>> {
  // [Improvement 2] Skip routing for single provider
  if (providers.length === 1) {
    check(`All tiers \u2192 ${providers[0].name} (preset defaults)`);
    return autoRoutingForSingleProvider(providers[0]);
  }

  const tiers = ['sonnet', 'opus', 'haiku'] as const;
  const routing: Record<string, RoutingTier[]> = {};
  const stepOffset = options?.stepOffset ?? 0;
  const totalSteps = options?.totalSteps ?? 99;

  for (let t = 0; t < tiers.length; t++) {
    const tier = tiers[t];
    const stepCurrent = stepOffset + t + 1;
    const stepLabel = `[Step ${stepCurrent} of ${totalSteps}] `;
    const choices = providers.map((p) => ({ title: p.name, value: p.id }));

    const { primaryId } = await prompts(
      { type: 'select', name: 'primaryId', message: `${stepLabel}[${tier}] Primary provider:`, choices },
      CANCEL,
    );

    const primary = providers.find((p) => p.id === (primaryId as string))!;
    const { modelName } = await prompts(
      { type: 'text', name: 'modelName', message: `${stepLabel}[${tier}] Model name:`, initial: primary.models[tier] },
      CANCEL,
    );

    const entries: RoutingTier[] = [{ provider: primary.id, model: modelName as string }];

    const { addFallbacks } = await prompts(
      { type: 'confirm', name: 'addFallbacks', message: `Add fallback providers for ${tier}?`, initial: false },
      CANCEL,
    );

    if (addFallbacks) {
      const fallbackChoices = providers
        .filter((p) => p.id !== primary.id)
        .map((p) => ({ title: p.name, value: p.id }));

      const { fallbackIds } = await prompts(
        { type: 'multiselect', name: 'fallbackIds', message: `[${tier}] Fallback providers:`, choices: fallbackChoices, min: 1 },
        CANCEL,
      );

      // [Improvement 5] Conditional fallback defaults
      if ((fallbackIds as string[]).length > 1) {
        const { useDefaults } = await prompts(
          { type: 'confirm', name: 'useDefaults', message: 'Use preset model defaults for all fallbacks?', initial: true },
          CANCEL,
        );

        if (useDefaults) {
          for (const fid of fallbackIds as string[]) {
            const fp = providers.find((p) => p.id === fid)!;
            entries.push({ provider: fid, model: fp.models[tier] });
          }
        } else {
          for (const fid of fallbackIds as string[]) {
            const fp = providers.find((p) => p.id === fid)!;
            const { fallbackModel } = await prompts(
              { type: 'text', name: 'fallbackModel', message: `[${tier}] Model name for ${fp.name}:`, initial: fp.models[tier] },
              CANCEL,
            );
            entries.push({ provider: fid, model: fallbackModel as string });
          }
        }
      } else {
        // Single fallback — just use preset default
        const fid = (fallbackIds as string[])[0];
        const fp = providers.find((p) => p.id === fid)!;
        entries.push({ provider: fid, model: fp.models[tier] });
      }
    }

    routing[tier] = entries;
  }

  return routing;
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
  return { port: port as number, host: host as string };
}

function collectAvailableModels(
  routing: Record<string, RoutingTier[]>,
): { id: string; source: string }[] {
  const models: { id: string; source: string }[] = [];

  // Collect unique primary models from each tier
  for (const [tier, entries] of Object.entries(routing)) {
    if (entries.length > 0 && !models.some((m) => m.id === entries[0].model)) {
      models.push({ id: entries[0].model, source: `${tier} tier` });
    }
  }

  return models;
}

interface SettingsConfig {
  defaultModel: string;
  tierModels: { sonnet?: string; opus?: string; haiku?: string };
}

async function configureClaudeCodeSettings(
  routing: Record<string, RoutingTier[]>,
  providers: ConfiguredProvider[],
  server: { port: number; host: string },
  stepInfo?: { current: number; total: number },
): Promise<SettingsConfig | null> {
  const availableModels = collectAvailableModels(routing);
  if (availableModels.length === 0) return null;

  console.log();
  const stepLabel = stepInfo ? `[Step ${stepInfo.current} of ${stepInfo.total}] ` : '';

  // Step A: Ask to configure
  const { configure } = await prompts(
    {
      type: 'confirm',
      name: 'configure',
      message: `${stepLabel}Configure Claude Code to use ModelWeaver automatically?`,
      initial: true,
    },
    CANCEL,
  );

  if (!configure) return null;

  // Step B: Select default model
  const { defaultModel } = await prompts(
    {
      type: 'select',
      name: 'defaultModel',
      message: 'Select default model for Claude Code:',
      choices: availableModels.map((m) => ({
        title: m.id,
        description: m.source,
        value: m.id,
      })),
    },
    CANCEL,
  );

  // Step C: Ask about tier alias mapping
  console.log();
  const { mapAliases } = await prompts(
    {
      type: 'confirm',
      name: 'mapAliases',
      message: 'Map tier aliases? (e.g., when Claude Code uses /sonnet, send a specific model)',
      initial: false,
    },
    CANCEL,
  );

  const tierModels: { sonnet?: string; opus?: string; haiku?: string } = {};

  if (mapAliases) {
    const tiers = ['sonnet', 'opus', 'haiku'] as const;
    for (const tier of tiers) {
      const { tierModel } = await prompts(
        {
          type: 'select',
          name: 'tierModel',
          message: `[${tier}] When Claude Code uses ${tier}, send model:`,
          choices: availableModels.map((m) => ({
            title: m.id,
            description: m.source,
            value: m.id,
          })),
        },
        CANCEL,
      );
      tierModels[tier] = tierModel as string;
    }
  }

  return { defaultModel: defaultModel as string, tierModels };
}

function buildYamlConfig(
  providers: ConfiguredProvider[],
  routing: Record<string, RoutingTier[]>,
  server: { port: number; host: string },
): string {
  // Build modelRouting from routing entries — this is the primary routing mechanism.
  // modelRouting is checked first (Priority 1), so routing + tierPatterns are only
  // needed as fallback for models NOT covered by modelRouting.
  const modelRouting: Record<string, { provider: string; model: string }[]> = {};
  for (const [tier, entries] of Object.entries(routing)) {
    if (entries.length > 0) {
      const primaryModel = entries[0].model;
      if (!modelRouting[primaryModel]) {
        modelRouting[primaryModel] = entries.map(e => ({ provider: e.provider, model: e.model }));
      }
    }
  }

  // Collect all model names covered by modelRouting — these don't need tier fallback
  const modelRoutingKeys = new Set(Object.keys(modelRouting));

  // Only include tier routing for tiers whose primary model is NOT in modelRouting
  // (i.e. models that might be requested by name substrings like "sonnet", "opus", "haiku")
  const filteredRouting: Record<string, RoutingTier[]> = {};
  const needsTierPatterns = { sonnet: false, opus: false, haiku: false } as Record<string, boolean>;

  for (const [tier, entries] of Object.entries(routing)) {
    if (entries.length > 0 && !modelRoutingKeys.has(entries[0].model)) {
      filteredRouting[tier] = entries;
      needsTierPatterns[tier] = true;
    }
  }

  const configObj: {
    server: { port: number; host: string };
    providers: Record<string, Record<string, unknown>>;
    modelRouting: Record<string, { provider: string; model: string }[]>;
    routing?: Record<string, RoutingTier[]>;
    tierPatterns?: Record<string, string[]>;
  } = {
    server,
    providers: {},
    modelRouting,
  };

  // Only add routing + tierPatterns if there are tiers not covered by modelRouting
  if (Object.keys(filteredRouting).length > 0) {
    configObj.routing = filteredRouting;
    configObj.tierPatterns = {};
    for (const tier of ['sonnet', 'opus', 'haiku'] as const) {
      if (needsTierPatterns[tier]) {
        configObj.tierPatterns[tier] = [tier];
      }
    }
  }

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

  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return;

  writeFileSync(envPath, existing + lines.join('\n') + '\n', { mode: 0o600 });
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

  let configured: ConfiguredProvider[] = [];
  let routing: Record<string, RoutingTier[]>;
  let server: { port: number; host: string };
  let yaml: string;
  let settingsConfig: SettingsConfig | null = null;

  const totalSteps = calculateTotalSteps(1, true);

  while (true) {
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

    // Step 2: Configure provider (auto-detects env key)
    configured = [];
    for (const id of selectedIds) {
      const provider = await configureProvider(id, { current: 2, total: totalSteps });
      if (provider) configured.push(provider);
    }

    if (configured.length === 0) {
      console.log(`\n  ${RED}No providers configured. Exiting.${RESET}\n`);
      process.exit(1);
    }

    // Auto-assign routing (no prompts)
    routing = autoRoutingForSingleProvider(configured[0]);

    // Server defaults (no prompts)
    server = { port: 3456, host: 'localhost' };

    // Step 3: Summary + Confirm
    yaml = buildYamlConfig(configured, routing, server);
    console.log(`\n${BOLD}  Generated configuration:${RESET}\n`);
    console.log(buildSummaryTable(configured, routing, server));
    console.log();
    console.log(yaml.split('\n').map((l) => `  ${l}`).join('\n'));

    const { confirm } = await prompts(
      { type: 'confirm', name: 'confirm', message: `[Step 3 of ${totalSteps}] Write this configuration?`, initial: true },
      CANCEL,
    );

    if (confirm) break;

    console.log('\n  Restarting quick setup...\n');
  }

  // Write files
  await writeConfigAndSettings(configured, routing, server, yaml, settingsConfig, totalSteps);
}

// ---------------------------------------------------------------------------
// Shared file-writing + settings logic
// ---------------------------------------------------------------------------

async function writeConfigAndSettings(
  configured: ConfiguredProvider[],
  routing: Record<string, RoutingTier[]>,
  server: { port: number; host: string },
  yaml: string,
  settingsConfig: SettingsConfig | null,
  totalSteps: number,
): Promise<SettingsConfig | null> {
  const modelweaverDir = join(process.env.HOME || process.env.USERPROFILE || '', '.modelweaver');
  mkdirSync(modelweaverDir, { recursive: true });
  const configPath = join(modelweaverDir, 'config.yaml');
  if (existsSync(configPath)) {
    console.log(`\n  \u26A0  Warning: ${configPath} already exists and will be overwritten.\n`);
    const { overwrite } = await prompts({
      type: 'confirm',
      name: 'overwrite',
      message: 'Overwrite existing config?',
      initial: false,
    }, { onCancel: () => { console.log('\n  Setup cancelled. No files were changed.'); process.exit(0); } });
    if (!overwrite) {
      console.log('\n  Setup cancelled. No files were changed.');
      process.exit(0);
    }
  }
  writeFileSync(configPath, yaml);
  writeEnvFile(configured);

  // Signal daemon to reload config if it's running
  try {
    const { readPidFile, isProcessAlive } = await import('./daemon.js');
    const pid = await readPidFile();
    if (pid && isProcessAlive(pid)) {
      process.kill(pid, 'SIGUSR1');
      check('ModelWeaver daemon reloaded with new config');
    }
  } catch {
    // Daemon not running or daemon.js not available — silently ignore
  }

  // Configure Claude Code settings.json
  const result = await configureClaudeCodeSettings(routing, configured, server, { current: totalSteps, total: totalSteps });

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
      tierModels: result.tierModels,
    });
    writeSettings(merged);

    check(`Claude Code settings updated at ${getSettingsPath()}`);
    console.log(`    Proxy endpoint: ${baseUrl}`);
    console.log(`    Default model:  ${result.defaultModel}`);
    if (Object.keys(result.tierModels).length > 0) {
      for (const [tier, model] of Object.entries(result.tierModels)) {
        console.log(`    ${tier.padEnd(8)} \u2192 ${model}`);
      }
    }
    console.log();
    console.log(`  ${GREEN}Restart Claude Code to apply changes.${RESET}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main wizard (normal mode)
// ---------------------------------------------------------------------------

export async function runInit(options?: { quick?: boolean }): Promise<void> {
  if (options?.quick) {
    return runQuickInit();
  }

  // Step 0 — TTY check
  if (!process.stdin.isTTY) {
    console.error('Error: modelweaver init requires an interactive terminal.');
    process.exit(1);
  }

  // Collect wizard output via loop (avoids unbounded recursion on restart)
  let configured: ConfiguredProvider[] = [];
  let routing: Record<string, RoutingTier[]>;
  let server: { port: number; host: string };
  let yaml: string;
  let settingsConfig: SettingsConfig | null = null;

  while (true) {
    // Step 1 — Welcome (use clearScreen instead of full clear)
    clearScreen();
    console.log(`
${BOLD}${CYAN}\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\u2500
\u2551       Welcome to ModelWeaver!        \u2551
\u2551                                      \u2551
\u2551  This wizard will help you configure \u2551
\u2551  your multi-provider model proxy.    \u2551
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D${RESET}
`);

    // Step 2 — Choose providers
    const selectedIds = await selectProviders();

    // Calculate total steps for counter
    const totalSteps = calculateTotalSteps(selectedIds.length, false);

    // Step 3 — Configure each provider
    configured = [];
    for (let i = 0; i < selectedIds.length; i++) {
      const provider = await configureProvider(selectedIds[i], { current: 2 + i, total: totalSteps });
      if (provider) configured.push(provider);
    }

    if (configured.length === 0) {
      console.log(`\n  ${RED}No providers configured. Exiting.${RESET}\n`);
      process.exit(1);
    }

    // Step 4 — Configure routing (auto-skipped for single provider)
    console.log();
    const routingStepOffset = 2 + selectedIds.length;
    routing = await configureRouting(configured, { stepOffset: routingStepOffset, totalSteps });

    // Step N-2 — Server config
    console.log();
    const serverStep = routingStepOffset + (configured.length > 1 ? 3 : 0) + 1;
    server = await configureServer({ stepInfo: { current: serverStep, total: totalSteps } });

    // Step N-1 — Review & confirm
    yaml = buildYamlConfig(configured, routing, server);
    console.log(`\n${BOLD}  Generated configuration:${RESET}\n`);
    console.log(buildSummaryTable(configured, routing, server));
    console.log();
    console.log(yaml.split('\n').map((l) => `  ${l}`).join('\n'));

    const confirmStep = totalSteps - 1;
    const { confirm } = await prompts(
      { type: 'confirm', name: 'confirm', message: `[Step ${confirmStep} of ${totalSteps}] Write this configuration?`, initial: true },
      CANCEL,
    );

    if (confirm) break;

    console.log('\n  Restarting wizard...\n');
  }

  // Step 7 — Write files + settings
  const finalTotalSteps = calculateTotalSteps(configured.length, false);
  settingsConfig = await writeConfigAndSettings(configured, routing, server, yaml, settingsConfig, finalTotalSteps);

  // Step 8 — Success banner
  console.log(`
${BOLD}${CYAN}\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551  ModelWeaver is configured!                   \u2551
\u2551                                                \u2551
${settingsConfig
  ? `\u2551  Claude Code settings have been updated.       \u2551
\u2551                                                \u2551
\u2551  Just restart Claude Code to get started.     \u2551`
  : `\u2551  To use with Claude Code:                      \u2551
\u2551                                                \u2551
\u2551  Terminal 1:                                   \u2551
\u2551    modelweaver                                 \u2551
\u2551                                                \u2551
\u2551  Terminal 2:                                   \u2551
\u2551    export ANTHROPIC_BASE_URL=\\                 \u2551
\u2551      http://localhost:${String(server.port).padEnd(20)}\u2551
\u2551    claude                                      \u2551`
}
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D${RESET}
`);
}
