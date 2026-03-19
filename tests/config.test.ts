// tests/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, findConfigFile, resolveEnvVars } from "../src/config.js";
import type { AppConfig } from "../src/types.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-config-test");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeTestConfig(content: string, filename = "modelweaver.yaml") {
  const path = join(TEST_DIR, filename);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("findConfigFile", () => {
  it("returns the path of an existing project-local config", () => {
    const path = writeTestConfig("server:\n  port: 3456");
    const result = findConfigFile(TEST_DIR);
    expect(result).toBe(path);
  });

  it("returns null when no config found", () => {
    const result = findConfigFile(TEST_DIR);
    expect(result).toBeNull();
  });
});

describe("resolveEnvVars", () => {
  it("replaces ${VAR} with environment variable value", () => {
    process.env.TEST_API_KEY = "sk-test-123";
    const result = resolveEnvVars("${TEST_API_KEY}");
    expect(result).toBe("sk-test-123");
    delete process.env.TEST_API_KEY;
  });

  it("keeps literal string when no ${} pattern", () => {
    expect(resolveEnvVars("https://api.example.com")).toBe("https://api.example.com");
  });

  it("throws if referenced env var is not set", () => {
    expect(() => resolveEnvVars("${NONEXISTENT_VAR}")).toThrow("Missing environment variable: NONEXISTENT_VAR");
  });

  it("throws if referenced env var is empty string", () => {
    process.env.EMPTY_VAR = "";
    expect(() => resolveEnvVars("${EMPTY_VAR}")).toThrow("Missing environment variable: EMPTY_VAR");
    delete process.env.EMPTY_VAR;
  });
});

describe("loadConfig", () => {
  it("loads and validates a correct config", () => {
    process.env.ANTH_KEY = "sk-ant-123";
    process.env.OR_KEY = "sk-or-456";

    writeTestConfig(`
server:
  port: 4000
  host: localhost

providers:
  anthro:
    baseUrl: https://api.anthropic.com
    apiKey: \${ANTH_KEY}
  or:
    baseUrl: https://openrouter.ai/api
    apiKey: \${OR_KEY}

routing:
  sonnet:
    - provider: anthro
      model: claude-sonnet-4
    - provider: or
      model: anthropic/claude-sonnet-4

tierPatterns:
  sonnet: ["sonnet"]
`);

    const { config } = loadConfig(TEST_DIR);
    expect(config.server.port).toBe(4000);
    expect(config.server.host).toBe("localhost");
    expect(config.providers.get("anthro")?.baseUrl).toBe("https://api.anthropic.com");
    expect(config.providers.get("anthro")?.apiKey).toBe("sk-ant-123");
    expect(config.routing.get("sonnet")).toHaveLength(2);
    expect(config.routing.get("sonnet")?.[0].model).toBe("claude-sonnet-4");

    delete process.env.ANTH_KEY;
    delete process.env.OR_KEY;
  });

  it("throws if provider in routing does not exist in providers", () => {
    process.env.ANTH_KEY = "sk-ant-123";
    writeTestConfig(`
server:
  port: 4000
providers:
  anthro:
    baseUrl: https://api.anthropic.com
    apiKey: \${ANTH_KEY}
routing:
  sonnet:
    - provider: nonexistent
tierPatterns:
  sonnet: ["sonnet"]
`);

    expect(() => loadConfig(TEST_DIR)).toThrow(/nonexistent/);
    delete process.env.ANTH_KEY;
  });

  it("throws if apiKey is missing from a provider", () => {
    writeTestConfig(`
server:
  port: 4000
providers:
  anthro:
    baseUrl: https://api.anthropic.com
routing:
  sonnet:
    - provider: anthro
tierPatterns:
  sonnet: ["sonnet"]
`);

    expect(() => loadConfig(TEST_DIR)).toThrow(/apiKey/);
  });

  it("throws if tier in routing has no tierPatterns entry", () => {
    process.env.ANTH_KEY = "sk-ant-123";
    writeTestConfig(`
server:
  port: 4000
providers:
  anthro:
    baseUrl: https://api.anthropic.com
    apiKey: \${ANTH_KEY}
routing:
  sonnet:
    - provider: anthro
tierPatterns:
  opus: ["opus"]
`);

    expect(() => loadConfig(TEST_DIR)).toThrow(/tier.*sonnet.*pattern/i);
    delete process.env.ANTH_KEY;
  });

  it("applies defaults for optional server fields", () => {
    process.env.KEY = "sk-123";
    writeTestConfig(`
server:
  port: 8080
providers:
  p:
    baseUrl: https://example.com
    apiKey: \${KEY}
routing:
  t:
    - provider: p
tierPatterns:
  t: ["t"]
`);

    const { config } = loadConfig(TEST_DIR);
    expect(config.server.host).toBe("localhost");
    delete process.env.KEY;
  });

  it("defaults authType to anthropic when not specified", () => {
    process.env.KEY = "sk-123";
    writeTestConfig(`
server:
  port: 8080
providers:
  p:
    baseUrl: https://example.com
    apiKey: \${KEY}
routing:
  t:
    - provider: p
tierPatterns:
  t: ["t"]
`);

    const { config } = loadConfig(TEST_DIR);
    expect(config.providers.get("p")?.authType).toBe("anthropic");
    delete process.env.KEY;
  });

  it("accepts authType bearer when specified", () => {
    process.env.KEY = "sk-123";
    writeTestConfig(`
server:
  port: 8080
providers:
  p:
    baseUrl: https://openrouter.ai/api
    apiKey: \${KEY}
    authType: bearer
routing:
  t:
    - provider: p
tierPatterns:
  t: ["t"]
`);

    const { config } = loadConfig(TEST_DIR);
    expect(config.providers.get("p")?.authType).toBe("bearer");
    delete process.env.KEY;
  });

  it("rejects baseUrl with non-http scheme", () => {
    process.env.KEY = "sk-123";
    writeTestConfig(`
server:
  port: 8080
providers:
  p:
    baseUrl: file:///etc/passwd
    apiKey: \${KEY}
routing:
  t:
    - provider: p
tierPatterns:
  t: ["t"]
`);

    expect(() => loadConfig(TEST_DIR)).toThrow(/baseUrl must use http/);
    delete process.env.KEY;
  });

  it("rejects baseUrl with ftp scheme", () => {
    process.env.KEY = "sk-123";
    writeTestConfig(`
server:
  port: 8080
providers:
  p:
    baseUrl: ftp://evil.com
    apiKey: \${KEY}
routing:
  t:
    - provider: p
tierPatterns:
  t: ["t"]
`);

    expect(() => loadConfig(TEST_DIR)).toThrow(/baseUrl must use http/);
    delete process.env.KEY;
  });
});
