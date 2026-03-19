// src/init.ts — Interactive setup wizard for ModelWeaver
import prompts from 'prompts';
import { getPresets, getPreset, type ProviderPreset } from './presets.js';
import { stringify as stringifyYaml } from 'yaml';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  if (!result.ok) {
    fail(`${preset.name}: ${result.error}`);
    const { retry } = await prompts(
      { type: 'confirm', name: 'retry', message: 'Retry?', initial: true },
      CANCEL,
    );
    if (retry) return configureProvider(id);
    console.log(`  ${RED}Warning:${RESET} ${preset.name} will be skipped — incomplete configuration.`);
    return null;
  }

  check(`${preset.name} API key accepted`);
  return { id, name: preset.name, baseUrl: baseUrl as string, envKey: preset.envKey, apiKey: apiKey as string, authType: preset.authType, models: preset.models };
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

function buildYamlConfig(
  providers: ConfiguredProvider[],
  routing: Record<string, RoutingTier[]>,
  server: { port: number; host: string },
): string {
  const configObj = {
    server,
    providers: {} as Record<string, Record<string, unknown>>,
    routing,
    tierPatterns: {
      sonnet: ['sonnet'],
      opus: ['opus'],
      haiku: ['haiku'],
    },
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
  const envPath = join(process.cwd(), '.env');
  let existing = '';

  if (existsSync(envPath)) {
    existing = readFileSync(envPath, 'utf-8');
  }

  const lines: string[] = existing ? [''] : [];

  for (const entry of entries) {
    const regex = new RegExp(`^${entry.envKey}=`, 'm');
    if (!regex.test(existing)) {
      lines.push(`${entry.envKey}=${entry.apiKey}`);
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
  const configPath = join(process.cwd(), 'modelweaver.yaml');
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

  console.log(`
\x1B[1m\x1B[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551  ModelWeaver is configured!                   \u2551
\u2551                                                \u2551
\u2551  To use with Claude Code:                      \u2551
\u2551                                                \u2551
\u2551  Terminal 1:                                   \u2551
\u2551    modelweaver                                 \u2551
\u2551                                                \u2551
\u2551  Terminal 2:                                   \u2551
\u2551    export ANTHROPIC_BASE_URL=\\                 \u2551
\u2551      http://localhost:${String(server.port).padEnd(20)}\u2551
\u2551    claude                                      \u2551
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\x1B[0m
`);
}
