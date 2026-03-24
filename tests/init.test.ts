import { describe, it, expect, vi, afterEach } from 'vitest';
import { getPresets, getPreset } from '../src/presets.js';
import { testApiKey } from '../src/init.js';
import { loadConfig } from '../src/config.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// 1. Preset tests
// ---------------------------------------------------------------------------

describe('presets', () => {
  it('getPresets returns 6 presets', () => {
    expect(getPresets()).toHaveLength(6);
  });

  it('each preset has required fields and model tiers', () => {
    for (const p of getPresets()) {
      expect(p.id).toBeDefined();
      expect(p.name).toBeDefined();
      expect(p.baseUrl).toBeDefined();
      expect(p.envKey).toBeDefined();
      expect(['anthropic', 'bearer']).toContain(p.authType);
      expect(p.testPath).toBeDefined();
      expect(p.testPath).toMatch(/^\//);
      expect(p.models.sonnet).toBeDefined();
      expect(p.models.opus).toBeDefined();
      expect(p.models.haiku).toBeDefined();
    }
  });

  it('getPreset("anthropic") returns the Anthropic preset', () => {
    const preset = getPreset('anthropic');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Anthropic');
    expect(preset!.authType).toBe('anthropic');
  });

  it('getPreset("nonexistent") returns undefined', () => {
    expect(getPreset('nonexistent')).toBeUndefined();
  });

  it('preset IDs match config key format (lowercase, no spaces)', () => {
    for (const p of getPresets()) {
      expect(p.id).toBe(p.id.toLowerCase());
      expect(p.id).not.toContain(' ');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. testApiKey tests
// ---------------------------------------------------------------------------

describe('testApiKey', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const anthropic = getPreset('anthropic')!;
  const openrouter = getPreset('openrouter')!;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns { ok: true } when fetch returns 400', async () => {
    fetchMock = vi.fn().mockResolvedValue({ status: 400 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await testApiKey('https://api.example.com', 'key', anthropic);
    expect(result).toEqual({ ok: true });
  });

  it('returns { ok: true } when fetch returns 429', async () => {
    fetchMock = vi.fn().mockResolvedValue({ status: 429 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await testApiKey('https://api.example.com', 'key', anthropic);
    expect(result).toEqual({ ok: true });
  });

  it('returns { ok: false, error } when fetch returns 401', async () => {
    fetchMock = vi.fn().mockResolvedValue({ status: 401 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await testApiKey('https://api.example.com', 'key', anthropic);
    expect(result).toEqual({ ok: false, error: 'Invalid API key' });
  });

  it('returns { ok: false, error } when fetch throws', async () => {
    fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await testApiKey('https://api.example.com', 'key', anthropic);
    expect(result).toEqual({ ok: false, error: 'Network error \u2014 endpoint unreachable' });
  });

  it('uses x-api-key header for anthropic authType', async () => {
    fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await testApiKey('https://api.example.com', 'sk-test', anthropic);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers['x-api-key']).toBe('sk-test');
    expect(options.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('uses Authorization Bearer header for bearer authType', async () => {
    fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await testApiKey('https://api.example.com', 'sk-test', openrouter);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers['Authorization']).toBe('Bearer sk-test');
    expect(options.headers['x-api-key']).toBeUndefined();
  });

  it('passes AbortSignal to fetch', async () => {
    fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await testApiKey('https://api.example.com', 'key', anthropic);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses preset.testPath in the request URL', async () => {
    fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await testApiKey('https://api.example.com', 'key', openrouter);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. YAML config generation test (indirect)
// ---------------------------------------------------------------------------

describe('wizard-generated YAML passes loadConfig validation', () => {
  const tmpDir = join(process.cwd(), 'tests', '.tmp-init');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleConfig = `
server:
  port: 13000
  host: localhost
providers:
  test-provider:
    baseUrl: https://api.example.com
    apiKey: test-key-123
    timeout: 30000
routing:
  sonnet:
    - provider: test-provider
      model: test-sonnet-model
  opus:
    - provider: test-provider
      model: test-opus-model
  haiku:
    - provider: test-provider
      model: test-haiku-model
tierPatterns:
  sonnet:
    - sonnet
  opus:
    - opus
  haiku:
    - haiku
`;

  it('loads wizard-shaped config without errors', async () => {
    const configPath = join(tmpDir, 'modelweaver.yaml');
    writeFileSync(configPath, sampleConfig);

    const { config } = await loadConfig(configPath);

    expect(config.server.port).toBe(13000);
    expect(config.server.host).toBe('localhost');
    expect(config.providers.has('test-provider')).toBe(true);
    expect(config.routing.has('sonnet')).toBe(true);
    expect(config.routing.has('opus')).toBe(true);
    expect(config.routing.has('haiku')).toBe(true);
    expect(config.tierPatterns.has('sonnet')).toBe(true);
    expect(config.tierPatterns.has('opus')).toBe(true);
    expect(config.tierPatterns.has('haiku')).toBe(true);
  });

  it('resolves provider data correctly', async () => {
    const configPath = join(tmpDir, 'modelweaver.yaml');
    writeFileSync(configPath, sampleConfig);

    const { config } = await loadConfig(configPath);
    const provider = config.providers.get('test-provider')!;

    expect(provider.baseUrl).toBe('https://api.example.com');
    expect(provider.apiKey).toBe('test-key-123');
    expect(provider.timeout).toBe(30000);
  });

  it('resolves routing entries correctly', async () => {
    const configPath = join(tmpDir, 'modelweaver.yaml');
    writeFileSync(configPath, sampleConfig);

    const { config } = await loadConfig(configPath);
    const sonnetRouting = config.routing.get('sonnet')!;

    expect(sonnetRouting).toHaveLength(1);
    expect(sonnetRouting[0].provider).toBe('test-provider');
    expect(sonnetRouting[0].model).toBe('test-sonnet-model');
  });
});
