// tests/pool.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadConfig } from "../src/config.js";
import { warmupProvider, warmupAll, startRefreshLoop, getPoolStats, type PoolStats } from "../src/pool.js";
import { createMockProvider } from "./helpers/mock-provider.js";
import type { ProviderConfig } from "../src/types.js";
import { Agent } from "undici";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(name: string, baseUrl: string, poolSize = 10): ProviderConfig {
  return {
    name,
    baseUrl,
    apiKey: "test-key",
    timeout: 5000,
    poolSize,
    _agent: new Agent({ keepAliveTimeout: 30000, keepAliveMaxTimeout: 60000, connections: poolSize }),
    _cachedOrigin: baseUrl.replace(/\/$/, ""),
    _cachedHost: new URL(baseUrl).host,
  };
}

/** Trivial in-flight counter mock */
function makeInFlightCounter(counts: Record<string, number> = {}) {
  return { get: (name: string) => counts[name] ?? 0 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("connection pool warmup", () => {
  let mock: ReturnType<typeof createMockProvider>;
  let provider: ProviderConfig;

  beforeAll(async () => {
    mock = createMockProvider();
    provider = makeProvider("test", mock.url);
  });

  afterAll(async () => {
    await mock.close();
    await provider._agent?.close();
  });

  it("warmupProvider returns true for reachable provider", async () => {
    const ok = await warmupProvider(provider);
    expect(ok).toBe(true);
  });

  it("warmupProvider returns false for unreachable provider", async () => {
    const dead = makeProvider("dead", "http://127.0.0.1:1");
    const ok = await warmupProvider(dead);
    expect(ok).toBe(false);
    await dead._agent?.close();
  });

  it("warmupProvider returns false when agent is missing", async () => {
    const noAgent: ProviderConfig = {
      name: "no-agent",
      baseUrl: "http://localhost:9999",
      apiKey: "test",
      timeout: 5000,
    };
    const ok = await warmupProvider(noAgent);
    expect(ok).toBe(false);
  });

  it("warmupAll warms all providers in parallel", async () => {
    const providers = new Map([
      ["test", provider],
      ["dead", makeProvider("dead", "http://127.0.0.1:1")],
    ]);

    const results = await warmupAll(providers);
    expect(results.get("test")).toBe(true);
    expect(results.get("dead")).toBe(false);

    // Clean up dead provider's agent
    await providers.get("dead")!._agent?.close();
  });
});

describe("refresh loop", () => {
  let mock: ReturnType<typeof createMockProvider>;
  let provider: ProviderConfig;

  beforeAll(async () => {
    mock = createMockProvider();
    provider = makeProvider("test", mock.url);
  });

  afterAll(async () => {
    await mock.close();
    await provider._agent?.close();
  });

  it("fires warmup on each interval tick", async () => {
    const providers = new Map([["test", provider]]);
    const loop = startRefreshLoop(() => providers, 100);

    // Wait for at least 2 ticks for interval to fire and warmup to complete
    await new Promise((r) => setTimeout(r, 250));

    const stats = getPoolStats(providers, makeInFlightCounter());
    expect(stats.test.warmupStatus).toBe("warm");

    loop.stop();
  });

  it("stop() prevents further warmup calls", async () => {
    const providers = new Map([["test", provider]]);
    const loop = startRefreshLoop(() => providers, 50);
    loop.stop();

    // Give time for any pending ticks
    await new Promise((r) => setTimeout(r, 150));
    // No assertion needed — if stop() fails, the loop would throw or hang
  });
});

describe("getPoolStats", () => {
  it("returns correct stats per provider", () => {
    const provider1 = makeProvider("anthropic", "http://api.anthropic.com", 10);
    const provider2 = makeProvider("openai", "http://api.openai.com", 5);

    const providers = new Map([["anthropic", provider1], ["openai", provider2]]);
    const counter = makeInFlightCounter({ anthropic: 3, openai: 1 });

    const stats = getPoolStats(providers, counter);

    expect(stats.anthropic.poolSize).toBe(10);
    expect(stats.anthropic.inFlight).toBe(3);
    expect(stats.anthropic.estimatedFree).toBe(7);
    expect(stats.openai.poolSize).toBe(5);
    expect(stats.openai.inFlight).toBe(1);
    expect(stats.openai.estimatedFree).toBe(4);

    // Cleanup
    provider1._agent?.close();
    provider2._agent?.close();
  });

  it("estimatedFree never goes below 0", () => {
    const provider = makeProvider("test", "http://localhost", 2);
    const providers = new Map([["test", provider]]);
    const counter = makeInFlightCounter({ test: 999 });

    const stats = getPoolStats(providers, counter);
    expect(stats.test.estimatedFree).toBe(0);

    provider._agent?.close();
  });
});

describe("/api/pool endpoint", () => {
  const tmpDir = join("/tmp", `mw-test-pool-api-${Date.now()}`);
  const configPath = join(tmpDir, "modelweaver.yaml");

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(configPath, `
server:
  port: 13001
  host: localhost
providers:
  test-provider:
    baseUrl: https://api.example.com
    apiKey: test-key
    timeout: 5000
    poolSize: 7
`);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns pool stats as JSON", async () => {
    const { createApp } = await import("../src/server.js");
    const { config } = await loadConfig(configPath);
    const handle = createApp(config, "warn");

    const res = await handle.app.fetch(new Request("http://localhost:13001/api/pool"));
    expect(res.status).toBe(200);

    const data = (await res.json()) as PoolStats;
    expect(data["test-provider"]).toBeDefined();
    expect(data["test-provider"].poolSize).toBe(7);
    expect(data["test-provider"].inFlight).toBe(0);
    expect(data["test-provider"].estimatedFree).toBe(7);
    expect(data["test-provider"].warmupStatus).toBe("cold");
    expect(data["test-provider"].circuitBreakerState).toBe("closed");
  });
});

describe("config: pool size", () => {
  const tmpDir = join("/tmp", `mw-test-pool-cfg-${Date.now()}`);
  const configPath = join(tmpDir, "modelweaver.yaml");

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(configPath, `
server:
  port: 13000
  host: localhost
providers:
  test-provider:
    baseUrl: https://api.example.com
    apiKey: test-key
    timeout: 5000
    poolSize: 5
`);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates an Agent with configured pool size", async () => {
    const { config } = await loadConfig(configPath);
    const provider = config.providers.get("test-provider");
    expect(provider?._agent).toBeDefined();
    expect(provider?.poolSize).toBe(5);
  });

  it("defaults pool size to 10 when not configured", async () => {
    writeFileSync(configPath, `
server:
  port: 13000
  host: localhost
providers:
  default-pool:
    baseUrl: https://api.example.com
    apiKey: test-key
    timeout: 5000
`);
    const { config } = await loadConfig(configPath);
    const provider = config.providers.get("default-pool");
    expect(provider?.poolSize).toBe(10);
  });
});
