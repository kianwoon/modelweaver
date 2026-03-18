# ModelWeaver Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local HTTP proxy that routes Claude Code API requests to different providers based on model tier, with automatic fallback chains.

**Architecture:** Stateless request-inspecting router. Each `POST /v1/messages` hits ModelWeaver, which reads the `model` field, matches it to a tier, picks the first provider in the chain, and pipes the SSE stream back. On retriable errors, tries the next provider.

**Tech Stack:** TypeScript, ESM, Hono, Zod, Vitest, tsx, tsup

---

## File Structure

```
modelweaver/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── tsup.config.ts
├── modelweaver.example.yaml
├── src/
│   ├── index.ts          # CLI entry point
│   ├── config.ts         # YAML loading, env var resolution, Zod validation
│   ├── router.ts         # Model name → tier → provider chain
│   ├── proxy.ts          # Forward request, pipe SSE, handle errors
│   ├── server.ts         # Hono app, request handler
│   ├── logger.ts         # Structured JSON logging
│   └── types.ts          # Shared TypeScript types
└── tests/
    ├── config.test.ts
    ├── router.test.ts
    ├── proxy.test.ts
    ├── server.test.ts
    └── helpers/
        └── mock-provider.ts
```

---

## Chunk 1: Project Scaffolding & Configuration

### Task 1: Initialize Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tsup.config.ts`
- Create: `modelweaver.example.yaml`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "modelweaver",
  "version": "0.1.0",
  "description": "Multi-provider model orchestration proxy for Claude Code",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "modelweaver": "dist/index.js"
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "hono": "^4.7.0",
    "@hono/node-server": "^1.13.0",
    "yaml": "^2.7.0",
    "zod": "^3.24.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "tsup": "^8.3.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
```

- [ ] **Step 4: Create tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
```

- [ ] **Step 5: Create modelweaver.example.yaml**

```yaml
server:
  port: 3456
  host: localhost

providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    apiKey: ${ANTHROPIC_API_KEY}
  openrouter:
    baseUrl: https://openrouter.ai/api
    apiKey: ${OPENROUTER_API_KEY}

routing:
  sonnet:
    - provider: anthropic
      model: claude-sonnet-4-20250514
    - provider: openrouter
      model: anthropic/claude-sonnet-4
  opus:
    - provider: anthropic
      model: claude-opus-4-20250514
    - provider: openrouter
      model: anthropic/claude-opus-4
  haiku:
    - provider: anthropic
      model: claude-haiku-4-5-20251001
    - provider: openrouter
      model: anthropic/claude-haiku-4

tierPatterns:
  sonnet: ["sonnet", "3-5-sonnet", "3.5-sonnet"]
  opus: ["opus", "3-opus", "3.5-opus"]
  haiku: ["haiku", "3-haiku", "3.5-haiku"]
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: All packages installed, no errors

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts tsup.config.ts modelweaver.example.yaml
git commit -m "chore: initialize project structure and dependencies"
```

---

### Task 2: Shared Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create src/types.ts**

```typescript
/** Resolved configuration after env var interpolation and validation */
export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  timeout: number;
}

export interface RoutingEntry {
  provider: string;
  model?: string;
}

export interface TierConfig {
  name: string;
  entries: RoutingEntry[];
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface AppConfig {
  server: ServerConfig;
  providers: Map<string, ProviderConfig>;
  routing: Map<string, RoutingEntry[]>;
  tierPatterns: Map<string, string[]>;
}

/** Request context passed through the pipeline */
export interface RequestContext {
  requestId: string;
  model: string;
  tier: string;
  providerChain: RoutingEntry[];
  startTime: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared TypeScript types"
```

---

### Task 3: Configuration Loading & Validation

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, findConfigFile, resolveEnvVars, validateConfig } from "../src/config.js";
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

    const config = loadConfig(TEST_DIR);
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

    expect(() => loadConfig(TEST_DIR)).toThrow(/routing.*nonexistent/);
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

    expect(() => loadConfig(TEST_DIR)).toThrow(/apiKey.*required/i);
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

    const config = loadConfig(TEST_DIR);
    expect(config.server.host).toBe("localhost");
    delete process.env.KEY;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — module `../src/config.js` not found

- [ ] **Step 3: Implement src/config.ts**

```typescript
// src/config.ts
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AppConfig, ProviderConfig, RoutingEntry, ServerConfig } from "./types.js";

// --- Zod schemas for raw (pre-resolution) config ---

const providerSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1, "apiKey is required"),
  timeout: z.number().default(30000),
});

const routingEntrySchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
});

const rawConfigSchema = z.object({
  server: z
    .object({
      port: z.number().int().min(1).max(65535).default(3456),
      host: z.string().default("localhost"),
    })
    .default({}),
  providers: z.record(z.string(), providerSchema),
  routing: z.record(z.string(), z.array(routingEntrySchema)),
  tierPatterns: z.record(z.string(), z.array(z.string())),
});

// --- Env var resolution ---

export function resolveEnvVars(value: string): string {
  const matches = value.matchAll(/\$\{([^}]+)\}/g);
  for (const match of matches) {
    const varName = match[1];
    const envValue = process.env[varName];
    if (envValue === undefined || envValue === "") {
      throw new Error(`Missing environment variable: ${varName}`);
    }
    value = value.replace(match[0], envValue);
  }
  return value;
}

function resolveAllEnvStrings(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveAllEnvStrings);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = resolveAllEnvStrings(val);
    }
    return result;
  }
  return obj;
}

// --- Config file discovery ---

export function findConfigFile(cwd: string = process.cwd()): string | null {
  const localPath = join(cwd, "modelweaver.yaml");
  if (existsSync(localPath)) return localPath;
  const globalPath = join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".modelweaver",
    "config.yaml"
  );
  if (existsSync(globalPath)) return globalPath;
  return null;
}

// --- Load & validate ---

export function loadConfig(configPath?: string, cwd?: string): AppConfig {
  const path = configPath || findConfigFile(cwd);
  if (!path) {
    throw new Error(
      "No config file found. Create modelweaver.yaml in your project root or ~/.modelweaver/config.yaml"
    );
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);

  // Resolve ${VAR} references in all string values
  const resolved = resolveAllEnvStrings(parsed) as z.infer<typeof rawConfigSchema>;

  const validated = rawConfigSchema.parse(resolved);

  // Cross-validation
  const providerNames = new Set(Object.keys(validated.providers));

  for (const [tier, entries] of Object.entries(validated.routing)) {
    for (const entry of entries) {
      if (!providerNames.has(entry.provider)) {
        throw new Error(
          `Routing tier "${tier}" references unknown provider "${entry.provider}". Available: ${[...providerNames].join(", ")}`
        );
      }
    }

    if (!validated.tierPatterns[tier]) {
      throw new Error(
        `Routing tier "${tier}" has no entry in tierPatterns. Add patterns for this tier.`
      );
    }
  }

  // Build typed config
  const providers = new Map<string, ProviderConfig>();
  for (const [name, p] of Object.entries(validated.providers)) {
    providers.set(name, {
      name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      timeout: p.timeout,
    });
  }

  const routing = new Map<string, RoutingEntry[]>();
  for (const [tier, entries] of Object.entries(validated.routing)) {
    routing.set(tier, entries);
  }

  const tierPatterns = new Map<string, string[]>();
  for (const [tier, patterns] of Object.entries(validated.tierPatterns)) {
    tierPatterns.set(tier, patterns);
  }

  const server: ServerConfig = {
    port: validated.server.port,
    host: validated.server.host,
  };

  return { server, providers, routing, tierPatterns };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/types.ts tests/config.test.ts
git commit -m "feat: config loading with YAML parsing, env var resolution, Zod validation"
```

---

## Chunk 2: Router & Logger

### Task 4: Router — Model-to-Tier Matching

**Files:**
- Create: `src/router.ts`
- Test: `tests/router.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/router.test.ts
import { describe, it, expect } from "vitest";
import { matchTier, buildRoutingChain } from "../src/router.js";
import type { RoutingEntry } from "../src/types.js";

describe("matchTier", () => {
  const patterns = new Map<string, string[]>([
    ["sonnet", ["sonnet", "3-5-sonnet", "3.5-sonnet"]],
    ["opus", ["opus", "3-opus", "3.5-opus"]],
    ["haiku", ["haiku", "3-haiku", "3.5-haiku"]],
  ]);

  it("matches claude-sonnet-4-20250514 to sonnet tier", () => {
    expect(matchTier("claude-sonnet-4-20250514", patterns)).toBe("sonnet");
  });

  it("matches claude-opus-4-20250514 to opus tier", () => {
    expect(matchTier("claude-opus-4-20250514", patterns)).toBe("opus");
  });

  it("matches claude-haiku-4-5-20251001 to haiku tier", () => {
    expect(matchTier("claude-haiku-4-5-20251001", patterns)).toBe("haiku");
  });

  it("matches 3-5-sonnet variant to sonnet tier", () => {
    expect(matchTier("claude-3-5-sonnet-20241022", patterns)).toBe("sonnet");
  });

  it("returns null when no pattern matches", () => {
    expect(matchTier("gpt-4o", patterns)).toBeNull();
  });

  it("is case-sensitive", () => {
    expect(matchTier("Claude-Sonnet-4", patterns)).toBeNull();
  });

  it("first matching tier wins (config order matters)", () => {
    // If "sonnet" appears before "opus" in the map,
    // a model matching both should hit sonnet
    const ambiguous = new Map<string, string[]>([
      ["sonnet", ["sonnet"]],
      ["custom", ["sonnet"]], // would also match but comes later
    ]);
    expect(matchTier("claude-sonnet-4", ambiguous)).toBe("sonnet");
  });
});

describe("buildRoutingChain", () => {
  const routing = new Map<string, RoutingEntry[]>([
    ["sonnet", [
      { provider: "anthro", model: "claude-sonnet-4" },
      { provider: "or", model: "anthropic/claude-sonnet-4" },
    ]],
  ]);

  it("returns the routing entries for a given tier", () => {
    const chain = buildRoutingChain("sonnet", routing);
    expect(chain).toHaveLength(2);
    expect(chain[0].provider).toBe("anthro");
    expect(chain[1].provider).toBe("or");
  });

  it("returns empty array for unknown tier", () => {
    expect(buildRoutingChain("unknown", routing)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/router.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement src/router.ts**

```typescript
// src/router.ts
import type { RoutingEntry, AppConfig, RequestContext } from "./types.js";

/**
 * Match a model name to a tier using case-sensitive substring matching.
 * First tier whose patterns contain any match wins (config order = priority).
 */
export function matchTier(
  modelName: string,
  tierPatterns: Map<string, string[]>
): string | null {
  for (const [tier, patterns] of tierPatterns) {
    for (const pattern of patterns) {
      if (modelName.includes(pattern)) {
        return tier;
      }
    }
  }
  return null;
}

/**
 * Get the ordered routing chain for a tier.
 */
export function buildRoutingChain(
  tier: string,
  routing: Map<string, RoutingEntry[]>
): RoutingEntry[] {
  return routing.get(tier) || [];
}

/**
 * Build a RequestContext from an incoming model name.
 * Returns null if no tier matches.
 */
export function resolveRequest(
  model: string,
  requestId: string,
  config: AppConfig
): RequestContext | null {
  const tier = matchTier(model, config.tierPatterns);
  if (!tier) return null;

  return {
    requestId,
    model,
    tier,
    providerChain: buildRoutingChain(tier, config.routing),
    startTime: Date.now(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/router.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/router.ts tests/router.test.ts
git commit -m "feat: router with tier pattern matching and chain resolution"
```

---

### Task 5: Logger

**Files:**
- Create: `src/logger.ts`
- Test: `tests/logger.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/logger.test.ts
import { describe, it, expect, vi } from "vitest";
import { createLogger, type Logger } from "../src/logger.js";

describe("logger", () => {
  it("logs info messages as JSON to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger("info");
    logger.info("test", { model: "claude-sonnet-4", tier: "sonnet" });

    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse(spy.mock.calls[0][0] as string);
    expect(output.level).toBe("info");
    expect(output.message).toBe("test");
    expect(output.model).toBe("claude-sonnet-4");
    expect(output.tier).toBe("sonnet");
    expect(output.timestamp).toBeDefined();
    spy.mockRestore();
  });

  it("skips debug messages when level is info", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger("info");
    logger.debug("should not appear");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("includes debug messages when level is debug", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger("debug");
    logger.debug("debug msg");
    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse(spy.mock.calls[0][0] as string);
    expect(output.level).toBe("debug");
    spy.mockRestore();
  });

  it("includes requestId in structured data", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger("info");
    logger.info("request", { requestId: "abc-123" });
    const output = JSON.parse(spy.mock.calls[0][0] as string);
    expect(output.requestId).toBe("abc-123");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/logger.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement src/logger.ts**

```typescript
// src/logger.ts
export type LogLevel = "info" | "debug";

export interface Logger {
  info: (message: string, data?: Record<string, unknown>) => void;
  debug: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

export function createLogger(level: LogLevel): Logger {
  const levels = { debug: 0, info: 1, error: 2 } as const;

  function log(lvl: LogLevel, message: string, data?: Record<string, unknown>) {
    if (levels[lvl] < levels[level]) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level: lvl,
      message,
      ...data,
    };
    process.stdout.write(JSON.stringify(entry) + "\n");
  }

  return {
    info: (msg, data?) => log("info", msg, data),
    debug: (msg, data?) => log("debug", msg, data),
    error: (msg, data?) => log("error", msg, data),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/logger.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts tests/logger.test.ts
git commit -m "feat: structured JSON logger with log levels"
```

---

## Chunk 3: Proxy & Streaming

### Task 6: Proxy with SSE Streaming & Fallback

**Files:**
- Create: `src/proxy.ts`
- Create: `tests/helpers/mock-provider.ts`
- Test: `tests/proxy.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/helpers/mock-provider.ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";

/**
 * Creates a mock Anthropic-compatible provider server for testing.
 * Returns { url, close, setBehavior }.
 */
export function createMockProvider() {
  const app = new Hono();

  let behavior: "success" | "error-429" | "error-500" | "error-401" | "timeout" = "success";

  app.post("/v1/messages", async (c) => {
    if (behavior === "timeout") {
      // Never respond — caller must set short timeout
      await new Promise(() => {}); // hangs forever
    }

    if (behavior === "error-429") {
      return c.json(
        { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
        429
      );
    }

    if (behavior === "error-500") {
      return c.json(
        { type: "error", error: { type: "api_error", message: "Internal error" } },
        500
      );
    }

    if (behavior === "error-401") {
      return c.json(
        { type: "error", error: { type: "authentication_error", message: "Invalid API key" } },
        401
      );
    }

    // Success: stream SSE response
    const body = await c.req.json();
    return new Response(
      [
        "event: message_start\n",
        `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: body.model || "test-model", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
        "event: content_block_start\n",
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        "event: content_block_delta\n",
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from mock provider" } })}\n\n`,
        "event: content_block_stop\n",
        `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        "event: message_delta\n",
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } })}\n\n`,
        "event: message_stop\n",
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join(""),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "anthropic-version": "2023-06-01",
        },
      }
    );
  });

  const server = serve({ fetch: app.fetch, port: 0 });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    setBehavior: (b: typeof behavior) => { behavior = b; },
  };
}
```

```typescript
// tests/proxy.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockProvider } from "./helpers/mock-provider.js";
import { forwardRequest, isRetriable, buildOutboundUrl, buildOutboundHeaders } from "../src/proxy.js";
import type { RoutingEntry, ProviderConfig, RequestContext } from "../src/types.js";

describe("isRetriable", () => {
  it("429 is retriable", () => expect(isRetriable(429)).toBe(true));
  it("500 is retriable", () => expect(isRetriable(500)).toBe(true));
  it("502 is retriable", () => expect(isRetriable(502)).toBe(true));
  it("503 is retriable", () => expect(isRetriable(503)).toBe(true));
  it("400 is not retriable", () => expect(isRetriable(400)).toBe(false));
  it("401 is not retriable", () => expect(isRetriable(401)).toBe(false));
  it("403 is not retriable", () => expect(isRetriable(403)).toBe(false));
});

describe("buildOutboundUrl", () => {
  it("appends incoming path to provider baseUrl", () => {
    expect(buildOutboundUrl("https://api.example.com", "/v1/messages?foo=bar"))
      .toBe("https://api.example.com/v1/messages?foo=bar");
  });
});

describe("buildOutboundHeaders", () => {
  const provider: ProviderConfig = {
    name: "test",
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    timeout: 30000,
  };

  it("rewrites x-api-key to provider key", () => {
    const headers = buildOutboundHeaders(
      new Headers({ "x-api-key": "original-key", "anthropic-version": "2023-06-01" }),
      provider,
      "req-123"
    );
    expect(headers.get("x-api-key")).toBe("sk-test");
  });

  it("adds x-request-id", () => {
    const headers = buildOutboundHeaders(new Headers(), provider, "req-123");
    expect(headers.get("x-request-id")).toBe("req-123");
  });

  it("rewrites host header to provider hostname", () => {
    const headers = buildOutboundHeaders(
      new Headers({ host: "localhost:3456" }),
      provider,
      "req-123"
    );
    expect(headers.get("host")).toBe("api.example.com");
  });

  it("forwards anthropic-version as-is", () => {
    const headers = buildOutboundHeaders(
      new Headers({ "anthropic-version": "2023-06-01" }),
      provider,
      "req-123"
    );
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });
});

describe("forwardRequest (integration)", () => {
  let mock: ReturnType<typeof createMockProvider>;

  beforeEach(async () => {
    mock = createMockProvider();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("streams successful response from provider", async () => {
    const provider: ProviderConfig = {
      name: "mock",
      baseUrl: mock.url,
      apiKey: "sk-test",
      timeout: 5000,
    };
    const entry: RoutingEntry = { provider: "mock" };
    const ctx: RequestContext = {
      requestId: "test-123",
      model: "claude-sonnet-4",
      tier: "sonnet",
      providerChain: [entry],
      startTime: Date.now(),
    };

    const body = JSON.stringify({ model: "claude-sonnet-4", max_tokens: 100, messages: [] });
    const result = await forwardRequest(provider, entry, ctx, new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body,
    }));

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/event-stream");

    // Verify SSE events
    const text = await result.text();
    expect(text).toContain("message_start");
    expect(text).toContain("Hello from mock provider");
    expect(text).toContain("message_stop");
  });

  it("returns error response for non-retriable status", async () => {
    mock.setBehavior("error-401");
    const provider: ProviderConfig = {
      name: "mock",
      baseUrl: mock.url,
      apiKey: "sk-test",
      timeout: 5000,
    };
    const entry: RoutingEntry = { provider: "mock" };
    const ctx: RequestContext = {
      requestId: "test-401",
      model: "claude-sonnet-4",
      tier: "sonnet",
      providerChain: [entry],
      startTime: Date.now(),
    };

    const body = JSON.stringify({ model: "claude-sonnet-4", max_tokens: 100, messages: [] });
    const result = await forwardRequest(provider, entry, ctx, new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));

    expect(result.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/proxy.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement src/proxy.ts**

```typescript
// src/proxy.ts
import type { ProviderConfig, RoutingEntry, RequestContext } from "./types.js";

/** Headers forwarded as-is to upstream */
const FORWARD_HEADERS = new Set([
  "anthropic-version",
  "anthropic-beta",
  "content-type",
  "accept",
]);

export function isRetriable(status: number): boolean {
  return status === 429 || status >= 500;
}

export function buildOutboundUrl(baseUrl: string, incomingPath: string): string {
  return `${baseUrl}${incomingPath}`;
}

export function buildOutboundHeaders(
  incomingHeaders: Headers,
  provider: ProviderConfig,
  requestId: string
): Headers {
  const headers = new Headers();

  // Forward select headers as-is
  for (const name of FORWARD_HEADERS) {
    const value = incomingHeaders.get(name);
    if (value) headers.set(name, value);
  }

  // Rewrite headers
  headers.set("x-api-key", provider.apiKey);
  headers.set("x-request-id", requestId);

  // Set host to provider hostname
  try {
    const url = new URL(provider.baseUrl);
    headers.set("host", url.host);
  } catch {
    // If baseUrl is not a valid URL, skip host rewrite
  }

  return headers;
}

/**
 * Forward a request to a single provider.
 * Returns the Response object — caller decides fallback logic.
 */
export async function forwardRequest(
  provider: ProviderConfig,
  entry: RoutingEntry,
  ctx: RequestContext,
  incomingRequest: Request
): Promise<Response> {
  const outgoingPath = incomingRequest.url.replace(/^https?:\/\/[^/]+/, "");
  const url = buildOutboundUrl(provider.baseUrl, outgoingPath);

  // Prepare body (with optional model override)
  let body: string | null = null;
  const contentType = incomingRequest.headers.get("content-type") || "";

  if (contentType.includes("application/json") && entry.model) {
    const parsed = await incomingRequest.json();
    parsed.model = entry.model;
    body = JSON.stringify(parsed);
  } else if (incomingRequest.body) {
    body = await incomingRequest.text();
  }

  const headers = buildOutboundHeaders(incomingRequest.headers, provider, ctx.requestId);

  if (body) {
    headers.set("content-length", new TextEncoder().encode(body).byteLength.toString());
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeout);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      // @ts-expect-error Node.js fetch duplex
      duplex: body ? "half" : undefined,
    });

    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    // Network errors / timeouts — return a synthetic 502
    const message = error instanceof DOMException && error.name === "AbortError"
      ? `Provider "${provider.name}" timed out after ${provider.timeout}ms`
      : `Provider "${provider.name}" connection failed: ${(error as Error).message}`;

    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message },
      }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }
}

/**
 * Try forwarding through a chain of providers.
 * Returns the first successful response, or 502 if all fail.
 */
export async function forwardWithFallback(
  providers: Map<string, ProviderConfig>,
  chain: RoutingEntry[],
  ctx: RequestContext,
  incomingRequest: Request,
  onAttempt?: (provider: string, index: number) => void
): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const provider = providers.get(entry.provider);

    if (!provider) {
      lastResponse = new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `Unknown provider: ${entry.provider}` },
        }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
      continue;
    }

    onAttempt?.(entry.provider, i);

    // Re-create the request for each attempt (body can only be read once)
    // We store the raw body in ctx for re-use
    const response = await forwardRequest(provider, entry, ctx, incomingRequest);
    lastResponse = response;

    // Success — return immediately
    if (response.status >= 200 && response.status < 300) {
      return response;
    }

    // Non-retriable error — fail immediately
    if (!isRetriable(response.status)) {
      return response;
    }

    // Retriable error — try next provider
    continue;
  }

  // All providers exhausted
  return (
    lastResponse ||
    new Response(
      JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "All providers exhausted" },
      }),
      { status: 502, headers: { "content-type": "application/json" } }
    )
  );
}
```

- [ ] **Step 4: Fix: handle request body re-use across fallback attempts**

The body can only be read once from a Request. Update the test helper and proxy to cache the raw body. Add this to `types.ts`:

```typescript
// Add to RequestContext in src/types.ts
export interface RequestContext {
  requestId: string;
  model: string;
  tier: string;
  providerChain: RoutingEntry[];
  startTime: number;
  rawBody: string;       // cached request body for re-use across fallbacks
}
```

Update `forwardRequest` to use `ctx.rawBody` instead of reading from the request. Update tests to set `rawBody` on the context.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/proxy.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/proxy.ts src/types.ts tests/proxy.test.ts tests/helpers/mock-provider.ts
git commit -m "feat: proxy with SSE streaming, fallback chains, and error classification"
```

---

## Chunk 4: Server & Entry Point

### Task 7: HTTP Server

**Files:**
- Create: `src/server.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockProvider } from "./helpers/mock-provider.js";
import { createApp } from "../src/server.js";
import type { AppConfig } from "../src/types.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    providers: new Map([
      ["mock", { name: "mock", baseUrl: "http://127.0.0.1:1", apiKey: "sk-test", timeout: 5000 }],
    ]),
    routing: new Map([
      ["sonnet", [{ provider: "mock", model: "claude-sonnet-4" }]],
    ]),
    tierPatterns: new Map([
      ["sonnet", ["sonnet"]],
      ["opus", ["opus"]],
      ["haiku", ["haiku"]],
    ]),
    ...overrides,
  };
}

describe("server", () => {
  let mock: ReturnType<typeof createMockProvider>;

  beforeEach(async () => {
    mock = createMockProvider();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("routes requests to the correct provider and streams response", async () => {
    const config = makeConfig({
      providers: new Map([
        ["mock", { name: "mock", baseUrl: mock.url, apiKey: "sk-test", timeout: 5000 }],
      ]),
    });

    const app = createApp(config, "info");
    const res = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "unused",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 100,
          messages: [],
        }),
      })
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(text).toContain("Hello from mock provider");
  });

  it("returns 502 when no tier matches the model", async () => {
    const config = makeConfig();
    const app = createApp(config, "info");

    const res = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "unknown-model", max_tokens: 100, messages: [] }),
      })
    );

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.type).toBe("error");
    expect(json.error.type).toBe("invalid_request_error");
  });

  it("returns 502 with overloaded_error when all providers fail", async () => {
    mock.setBehavior("error-500");
    const config = makeConfig({
      providers: new Map([
        ["mock", { name: "mock", baseUrl: mock.url, apiKey: "sk-test", timeout: 5000 }],
      ]),
      routing: new Map([
        ["sonnet", [
          { provider: "mock" },
          // Only one provider in chain — it fails, so all exhausted
        ]],
      ]),
    });

    const app = createApp(config, "info");
    const res = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4", max_tokens: 100, messages: [] }),
      })
    );

    expect(res.status).toBe(502);
  });

  it("adds x-request-id to response headers", async () => {
    const config = makeConfig({
      providers: new Map([
        ["mock", { name: "mock", baseUrl: mock.url, apiKey: "sk-test", timeout: 5000 }],
      ]),
    });

    const app = createApp(config, "info");
    const res = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4", max_tokens: 100, messages: [] }),
      })
    );

    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement src/server.ts**

```typescript
// src/server.ts
import { Hono } from "hono";
import { resolveRequest } from "./router.js";
import { forwardWithFallback } from "./proxy.js";
import { createLogger, type Logger, type LogLevel } from "./logger.js";
import type { AppConfig } from "./types.js";
import { randomUUID } from "node:crypto";

function anthropicError(type: string, message: string, requestId: string): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status: 502,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
    }
  );
}

export function createApp(config: AppConfig, logLevel: LogLevel): Hono {
  const logger = createLogger(logLevel);
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    const requestId = randomUUID();

    // Parse model from request body
    let body: { model?: string };
    try {
      body = await c.req.json();
    } catch {
      return anthropicError("invalid_request_error", "Invalid JSON body", requestId);
    }

    const model = body.model;
    if (!model) {
      return anthropicError("invalid_request_error", "Missing 'model' field in request body", requestId);
    }

    // Resolve routing
    const ctx = resolveRequest(model, requestId, config);
    if (!ctx) {
      logger.info("No tier match", { requestId, model });
      return anthropicError(
        "invalid_request_error",
        `No routing tier matches model "${model}". Configured tiers: ${[...config.tierPatterns.keys()].join(", ")}`,
        requestId
      );
    }

    // Cache raw body for re-use across fallback attempts
    const rawBody = JSON.stringify(body);
    ctx.rawBody = rawBody;

    logger.info("Routing request", {
      requestId,
      model,
      tier: ctx.tier,
      providers: ctx.providerChain.map((e) => e.provider),
    });

    // Forward with fallback chain
    const response = await forwardWithFallback(
      config.providers,
      ctx.providerChain,
      ctx,
      c.req.raw,
      (provider, index) => {
        logger.info("Attempting provider", { requestId, provider, index, tier: ctx.tier });
      }
    );

    // Add request ID to response
    response.headers.set("x-request-id", requestId);

    const latency = Date.now() - ctx.startTime;
    logger.info("Request completed", {
      requestId,
      model,
      tier: ctx.tier,
      status: response.status,
      latencyMs: latency,
    });

    return response;
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: Hono server with request routing, fallback, and error responses"
```

---

### Task 8: CLI Entry Point

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Implement src/index.ts**

```typescript
// src/index.ts
import { serve } from "@hono/node-server";
import { createApp } from "./server.js";
import { loadConfig } from "./config.js";
import type { LogLevel } from "./logger.js";

function parseArgs(argv: string[]): { port?: number; config?: string; verbose: boolean; help: boolean } {
  const args = { verbose: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "-p":
      case "--port":
        args.port = parseInt(argv[++i], 10);
        break;
      case "-c":
      case "--config":
        args.config = argv[++i];
        break;
      case "-v":
      case "--verbose":
        args.verbose = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
ModelWeaver — Multi-provider model orchestration proxy for Claude Code

Usage: modelweaver [options]

Options:
  -p, --port <number>      Server port                    (default: from config)
  -c, --config <path>      Config file path               (auto-detected)
  -v, --verbose            Enable debug logging           (default: off)
  -h, --help               Show this help

Config locations (first found wins):
  ./modelweaver.yaml
  ~/.modelweaver/config.yaml
`);
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Load config
  let config;
  try {
    config = loadConfig(args.config);
  } catch (error) {
    console.error(`Config error: ${(error as Error).message}`);
    process.exit(1);
  }

  // CLI port override
  const port = args.port || config.server.port;
  const host = config.server.host;
  const logLevel: LogLevel = args.verbose ? "debug" : "info";

  // Create app
  const app = createApp(config, logLevel);

  // Print startup info
  console.log(`\n  ModelWeaver v0.1.0`);
  console.log(`  Listening: http://${host}:${port}\n`);

  console.log("  Routes:");
  for (const [tier, entries] of config.routing) {
    const providerList = entries
      .map((e, i) => `${e.provider}${i === 0 ? " (primary)" : " (fallback)"}`)
      .join(", ");
    console.log(`    ${tier.padEnd(8)} → ${providerList}`);
  }
  console.log();

  // Start server
  serve({ fetch: app.fetch, hostname: host, port });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n  Shutting down...");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
```

- [ ] **Step 2: Verify the dev server starts**

Run: `ANTHROPIC_API_KEY=sk-test npx tsx src/index.ts -c modelweaver.example.yaml`
Expected: Server starts, prints routes, waits for connections. Press Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: CLI entry point with arg parsing, startup output, and graceful shutdown"
```

---

### Task 9: Run Full Test Suite & Final Verification

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: `dist/index.js` created

- [ ] **Step 3: Smoke test with mock provider**

In two terminals:
```bash
# Terminal 1
npm run dev -c modelweaver.example.yaml

# Terminal 2
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

Expected: 502 error (no real API keys configured) — this confirms the proxy is running and routing correctly.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verify full test suite and build"
```
