// tests/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, findConfigFile, resolveEnvVars, formatZodErrors, ConfigValidationError } from "../src/config.js";
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
    const path = writeTestConfig("server:\n  port: 13000");
    const result = findConfigFile(TEST_DIR);
    expect(result).toBe(path);
  });

  it("returns null when no config found", () => {
    const result = findConfigFile(TEST_DIR, { skipGlobal: true });
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

  it("returns empty string if referenced env var is empty", () => {
    process.env.EMPTY_VAR = "";
    expect(resolveEnvVars("${EMPTY_VAR}")).toBe("");
    delete process.env.EMPTY_VAR;
  });
});

describe("loadConfig", () => {
  it("loads and validates a correct config", async () => {
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

    const { config } = await loadConfig(TEST_DIR);
    expect(config.server.port).toBe(4000);
    expect(config.server.host).toBe("localhost");
    expect(config.providers.get("anthro")?.baseUrl).toBe("https://api.anthropic.com");
    expect(config.providers.get("anthro")?.apiKey).toBe("sk-ant-123");
    expect(config.routing.get("sonnet")).toHaveLength(2);
    expect(config.routing.get("sonnet")?.[0].model).toBe("claude-sonnet-4");

    delete process.env.ANTH_KEY;
    delete process.env.OR_KEY;
  });

  it("throws if provider in routing does not exist in providers", async () => {
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

    await expect(loadConfig(TEST_DIR)).rejects.toThrow(/nonexistent/);
    delete process.env.ANTH_KEY;
  });

  it("throws if apiKey is missing from a provider", async () => {
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

    await expect(loadConfig(TEST_DIR)).rejects.toThrow(/apiKey/);
  });

  it("throws if tier in routing has no tierPatterns entry", async () => {
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

    await expect(loadConfig(TEST_DIR)).rejects.toThrow(/tier.*sonnet.*pattern/i);
    delete process.env.ANTH_KEY;
  });

  it("applies defaults for optional server fields", async () => {
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

    const { config } = await loadConfig(TEST_DIR);
    expect(config.server.host).toBe("localhost");
    delete process.env.KEY;
  });

  it("defaults authType to anthropic when not specified", async () => {
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

    const { config } = await loadConfig(TEST_DIR);
    expect(config.providers.get("p")?.authType).toBe("anthropic");
    delete process.env.KEY;
  });

  it("accepts authType bearer when specified", async () => {
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

    const { config } = await loadConfig(TEST_DIR);
    expect(config.providers.get("p")?.authType).toBe("bearer");
    delete process.env.KEY;
  });

  it("parses apiFormat field on provider", async () => {
    process.env.KEY = "sk-123";
    writeTestConfig(`
server:
  port: 8080
providers:
  openrouter:
    baseUrl: https://openrouter.ai/api
    apiKey: \${KEY}
    apiFormat: openai-chat
    authType: bearer
routing:
  t:
    - provider: openrouter
tierPatterns:
  t: ["t"]
`);
    const { config } = await loadConfig(TEST_DIR);
    expect(config.providers.get("openrouter")?.apiFormat).toBe("openai-chat");
    delete process.env.KEY;
  });

  it("defaults apiFormat to anthropic", async () => {
    process.env.KEY = "sk-123";
    writeTestConfig(`
server:
  port: 8080
providers:
  anthro:
    baseUrl: https://api.anthropic.com
    apiKey: \${KEY}
routing:
  t:
    - provider: anthro
tierPatterns:
  t: ["t"]
`);
    const { config } = await loadConfig(TEST_DIR);
    expect(config.providers.get("anthro")?.apiFormat).toBe("anthropic");
    delete process.env.KEY;
  });

  it("rejects baseUrl with non-http scheme", async () => {
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

    await expect(loadConfig(TEST_DIR)).rejects.toThrow(/baseUrl must use http/);
    delete process.env.KEY;
  });

  it("rejects baseUrl with ftp scheme", async () => {
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

    await expect(loadConfig(TEST_DIR)).rejects.toThrow(/baseUrl must use http/);
    delete process.env.KEY;
  });

  describe("modelRouting", () => {
    it("loads config without modelRouting (backward compatible)", async () => {
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
      const { config } = await loadConfig(TEST_DIR);
      expect(config.modelRouting).toBeDefined();
      expect(config.modelRouting.size).toBe(0);
      delete process.env.KEY;
    });

    it("loads config with modelRouting and valid providers", async () => {
      process.env.KEY1 = "sk-1";
      process.env.KEY2 = "sk-2";
      writeTestConfig(`
server:
  port: 8080
providers:
  glm:
    baseUrl: https://api.z.ai/api/anthropic
    apiKey: \${KEY1}
  minimax:
    baseUrl: https://api.minimax.io/anthropic
    apiKey: \${KEY2}
routing:
  t:
    - provider: glm
tierPatterns:
  t: ["t"]
modelRouting:
  "glm-5-turbo":
    - provider: glm
  "MiniMax-M2.7":
    - provider: minimax
`);
      const { config } = await loadConfig(TEST_DIR);
      expect(config.modelRouting.size).toBe(2);
      expect(config.modelRouting.get("glm-5-turbo")).toEqual([{ provider: "glm" }]);
      expect(config.modelRouting.get("MiniMax-M2.7")).toEqual([{ provider: "minimax" }]);
      delete process.env.KEY1;
      delete process.env.KEY2;
    });

    it("throws if modelRouting references unknown provider", async () => {
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
modelRouting:
  "custom-model":
    - provider: nonexistent
`);
      await expect(loadConfig(TEST_DIR)).rejects.toThrow(/nonexistent/);
      delete process.env.KEY;
    });

    it("loads config with empty modelRouting object", async () => {
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
modelRouting: {}
`);
      const { config } = await loadConfig(TEST_DIR);
      expect(config.modelRouting.size).toBe(0);
      delete process.env.KEY;
    });
  });
});

describe("formatZodErrors", () => {
  it("converts invalid_type errors to structured fields", async () => {
    const { z } = await import("zod");
    const schema = z.object({ weight: z.number() });
    const result = schema.safeParse({ weight: "abc" });
    expect(result.success).toBe(false);
    const errors = formatZodErrors(result.error);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("weight");
    expect(errors[0].message).toContain("Expected");
    expect(errors[0].expected).toBe("number");
  });

  it("converts invalid_value (enum) errors with allowed options", async () => {
    const { z } = await import("zod");
    const schema = z.object({ authType: z.enum(["anthropic", "bearer"]) });
    const result = schema.safeParse({ authType: "basic" });
    expect(result.success).toBe(false);
    const errors = formatZodErrors(result.error);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("authType");
    expect(errors[0].expected).toContain("anthropic");
    expect(errors[0].expected).toContain("bearer");
  });

  it("converts invalid_format (URL) errors", async () => {
    const { z } = await import("zod");
    const schema = z.object({ baseUrl: z.string().url() });
    const result = schema.safeParse({ baseUrl: "not-a-url" });
    expect(result.success).toBe(false);
    const errors = formatZodErrors(result.error);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("baseUrl");
    expect(errors[0].message).toContain("Invalid URL");
    expect(errors[0].expected).toContain("http");
  });

  it("handles multiple errors at different paths", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      port: z.number().int().min(1),
      host: z.string().min(1),
    });
    const result = schema.safeParse({ port: "abc", host: "" });
    expect(result.success).toBe(false);
    const errors = formatZodErrors(result.error);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    const paths = errors.map(e => e.path);
    expect(paths).toContain("port");
    expect(paths).toContain("host");
  });
});

describe("ConfigValidationError", () => {
  it("creates a human-readable message for a single error", () => {
    const err = new ConfigValidationError([
      { path: "modelRouting.glm-5.1.0.weight", message: "Expected number, got string", received: "string", expected: "number" },
    ]);
    expect(err.name).toBe("ConfigValidationError");
    expect(err.isValidationError).toBe(true);
    expect(err.message).toContain("modelRouting.glm-5.1.0.weight");
    expect(err.message).toContain("Expected number, got string");
    expect(err.fieldErrors).toHaveLength(1);
  });

  it("creates a multi-line message for multiple errors", () => {
    const err = new ConfigValidationError([
      { path: "server.port", message: "Expected number, got string", received: "string", expected: "number" },
      { path: "providers.foo.baseUrl", message: "Invalid URL", received: "ftp://evil.com", expected: "valid URL" },
    ]);
    expect(err.message).toContain("2 error(s)");
    expect(err.message).toContain("server.port");
    expect(err.message).toContain("providers.foo.baseUrl");
  });
});

describe("loadConfig validation error formatting (full integration)", () => {
  it("throws ConfigValidationError with structured fields for wrong type", async () => {
    process.env.KEY = "sk-123";
    writeTestConfig(`
server:
  port: "not-a-number"
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
    try {
      await loadConfig(TEST_DIR);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const cve = err as ConfigValidationError;
      expect(cve.fieldErrors.length).toBeGreaterThanOrEqual(1);
      const portError = cve.fieldErrors.find(e => e.path.includes("port"));
      expect(portError).toBeDefined();
      expect(portError!.message).toContain("Expected");
      expect(portError!.expected).toBe("number");
    }
    delete process.env.KEY;
  });
});
