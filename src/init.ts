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
const RESET = '\x1B[0m';

function check(msg: string) { console.log(`  ${GREEN}\u2713${RESET} ${msg}`); }
function fail(msg: string) { console.log(`  ${RED}\u2717${RESET} ${msg}`); }

// ---------------------------------------------------------------------------
// API key test
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
// Wizard steps
// ---------------------------------------------------------------------------

async function selectProviders(): Promise<string[]> {
  const allPresets = getPresets();
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

async function configureProvider(id: string): Promise<ConfiguredProvider | null> {
  const preset = getPreset(id);
  if (!preset) {
    console.error(`  Error: Unknown provider "${id}". Skipping.`);
    return null;
  }

  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { baseUrl } = await prompts(
      { type: 'text', name: 'baseUrl', message: `[${preset.name}] Base URL:`, initial: preset.baseUrl },
      CANCEL,
    );

    const { apiKey } = await prompts(
      { type: 'password', name: 'apiKey', message: `[${preset.name}] API key:` },
      CANCEL,
    );

    // Spinner-style test
    process.stdout.write(`  Testing API key for ${preset.name}...`);
    const result = await testApiKey(baseUrl as string, apiKey as string, preset);
    process.stdout.write('\r' + ' '.repeat(50) + '\r');

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

  console.log(`  ${RED}Warning:${RESET} ${preset.name} will be skipped — max retries (${MAX_RETRIES}) exceeded.`);
  return null;
}

async function configureRouting(providers: ConfiguredProvider[]): Promise<Record<string, RoutingTier[]>> {
  const tiers = ['sonnet', 'opus', 'haiku'] as const;
  const routing: Record<string, RoutingTier[]> = {};

  for (const tier of tiers) {
    const choices = providers.map((p) => ({ title: p.name, value: p.id }));

    const { primaryId } = await prompts(
      { type: 'select', name: 'primaryId', message: `[${tier}] Primary provider:`, choices },
      CANCEL,
    );

    const primary = providers.find((p) => p.id === (primaryId as string))!;
    const { modelName } = await prompts(
      { type: 'text', name: 'modelName', message: `[${tier}] Model name:`, initial: primary.models[tier] },
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

      for (const fid of fallbackIds as string[]) {
        const fp = providers.find((p) => p.id === fid)!;
        const { fallbackModel } = await prompts(
          { type: 'text', name: 'fallbackModel', message: `[${tier}] Model name for ${fp.name}:`, initial: fp.models[tier] },
          CANCEL,
        );
        entries.push({ provider: fid, model: fallbackModel as string });
      }
    }

    routing[tier] = entries;
  }

  return routing;
}

async function configureServer(): Promise<{ port: number; host: string }> {
  const { port } = await prompts(
    { type: 'number', name: 'port', message: 'Server port:', initial: 3456 },
    CANCEL,
  );
  const { host } = await prompts(
    { type: 'text', name: 'host', message: 'Server host:', initial: 'localhost' },
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
): Promise<SettingsConfig | null> {
  const availableModels = collectAvailableModels(routing);
  if (availableModels.length === 0) return null;

  console.log();

  // Step A: Ask to configure
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
  // Build modelRouting from routing entries
  const modelRouting: Record<string, { provider: string; model: string }[]> = {};
  for (const [tier, entries] of Object.entries(routing)) {
    if (entries.length > 0) {
      const primaryModel = entries[0].model;
      if (!modelRouting[primaryModel]) {
        modelRouting[primaryModel] = entries.map(e => ({ provider: e.provider, model: e.model }));
      }
    }
  }

  const configObj = {
    server,
    providers: {} as Record<string, Record<string, unknown>>,
    routing,
    tierPatterns: {
      sonnet: ['sonnet'],
      opus: ['opus'],
      haiku: ['haiku'],
    },
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
    const quotedValue = entry.apiKey.includes('"') ? `'${entry.apiKey}'` : `"${entry.apiKey}"`;
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
// Main wizard
// ---------------------------------------------------------------------------

export async function runInit(): Promise<void> {
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
    // Step 1 — Welcome
    process.stdout.write('\x1B[2J\x1B[H');
    console.log(`
\x1B[1m\x1B[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557\u2550
\u2551       Welcome to ModelWeaver!        \u2551
\u2551                                      \u2551
\u2551  This wizard will help you configure \u2551
\u2551  your multi-provider model proxy.    \u2551
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\x1B[0m
`);

    // Step 2 — Choose providers
    const selectedIds = await selectProviders();

    // Step 3 — Configure each provider
    configured = [];
    for (const id of selectedIds) {
      const provider = await configureProvider(id);
      if (provider) configured.push(provider);
    }

    if (configured.length === 0) {
      console.log(`\n  ${RED}No providers configured. Exiting.${RESET}\n`);
      process.exit(1);
    }

    // Step 4 — Configure routing
    console.log();
    routing = await configureRouting(configured);

    // Step 5 — Server config
    console.log();
    server = await configureServer();

    // Step 6 — Review & confirm
    yaml = buildYamlConfig(configured, routing, server);
    console.log(`\n\x1B[1m  Generated configuration:\x1B[0m\n`);
    console.log(yaml.split('\n').map((l) => `  ${l}`).join('\n'));

    const { confirm } = await prompts(
      { type: 'confirm', name: 'confirm', message: 'Write this configuration?', initial: true },
      CANCEL,
    );

    if (confirm) break;

    console.log('\n  Restarting wizard...\n');
  }

  // Step 7 — Write files
  const modelweaverDir = join(process.env.HOME || process.env.USERPROFILE || '', '.modelweaver');
  mkdirSync(modelweaverDir, { recursive: true });
  const configPath = join(modelweaverDir, 'config.yaml');
  if (existsSync(configPath)) {
    console.log(`\n  ⚠  Warning: ${configPath} already exists and will be overwritten.\n`);
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
    const pid = readPidFile();
    if (pid && isProcessAlive(pid)) {
      process.kill(pid, 'SIGUSR1');
      check('ModelWeaver daemon reloaded with new config');
    }
  } catch {
    // Daemon not running or daemon.js not available — silently ignore
  }

  // Step 8 — Configure Claude Code settings.json
  settingsConfig = await configureClaudeCodeSettings(routing, configured, server);

  if (settingsConfig) {
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
      defaultModel: settingsConfig.defaultModel,
      tierModels: settingsConfig.tierModels,
    });
    writeSettings(merged);

    check(`Claude Code settings updated at ${getSettingsPath()}`);
    console.log(`    Proxy endpoint: ${baseUrl}`);
    console.log(`    Default model:  ${settingsConfig.defaultModel}`);
    if (Object.keys(settingsConfig.tierModels).length > 0) {
      for (const [tier, model] of Object.entries(settingsConfig.tierModels)) {
        console.log(`    ${tier.padEnd(8)} \u2192 ${model}`);
      }
    }
    console.log();
    console.log(`  ${GREEN}Restart Claude Code to apply changes.${RESET}`);
  }

  console.log(`
\x1B[1m\x1B[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
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
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\x1B[0m
`);
}
