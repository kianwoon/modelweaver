// tests/pool.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadConfig } from "../src/config.js";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

describe("connection pool", () => {
  const tmpDir = join("/tmp", `mw-test-pool-${Date.now()}`);
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
