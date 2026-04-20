# OpenAI Upstream Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI-compatible upstream provider support (Chat Completions + Responses API) via a per-provider adapter layer that translates between Anthropic and OpenAI wire formats.

**Architecture:** Adapter Pattern — a `ProviderAdapter` interface with three implementations: `AnthropicAdapter` (passthrough), `OpenAIChatAdapter`, and `OpenAIResponsesAdapter`. The proxy resolves the adapter from `provider.apiFormat` and delegates request/response transformation. All existing proxy logic (fallback chains, circuit breakers, hedging, timeouts) remains unchanged.

**Tech Stack:** TypeScript, Node.js streams (Transform), Vitest, tsup

**Design doc:** `docs/2026-04-20-openai-upstream-adapter-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/adapters/base.ts` | `ProviderAdapter` interface + shared types |
| `src/adapters/registry.ts` | `getAdapter(format)` factory |
| `src/adapters/anthropic.ts` | Passthrough adapter (no-op) |
| `src/adapters/openai-utils.ts` | Shared helpers: SSE line parser, content block mappers, token mapping |
| `src/adapters/openai-chat.ts` | Chat Completions adapter |
| `src/adapters/openai-responses.ts` | Responses API adapter |
| `tests/adapters/openai-chat.test.ts` | Chat Completions adapter tests |
| `tests/adapters/openai-responses.test.ts` | Responses API adapter tests |
| `tests/helpers/mock-openai-provider.ts` | Mock OpenAI-compatible provider for integration tests |

### Modified files

| File | Change |
|------|--------|
| `src/types.ts:14` | Add `apiFormat` field to `ProviderConfig` |
| `src/config.ts:126-160` | Add `apiFormat` to Zod provider schema |
| `src/proxy.ts` | Import adapter, resolve in `forwardRequest()`, delegate URL/headers/body/response/error transformation |

---

## Task 1: Adapter Interface + Registry

**Files:**
- Create: `src/adapters/base.ts`
- Create: `src/adapters/registry.ts`
- Create: `src/adapters/anthropic.ts`
- Test: `tests/adapters/registry.test.ts`

- [ ] **Step 1: Write the failing test for registry**

```typescript
// tests/adapters/registry.test.ts
import { describe, it, expect } from "vitest";
import { getAdapter } from "../../src/adapters/registry.js";

describe("getAdapter", () => {
  it("returns AnthropicAdapter for undefined", () => {
    const adapter = getAdapter(undefined);
    expect(adapter.format).toBe("anthropic");
  });

  it("returns AnthropicAdapter for 'anthropic'", () => {
    const adapter = getAdapter("anthropic");
    expect(adapter.format).toBe("anthropic");
  });

  it("returns OpenAIChatAdapter for 'openai-chat'", () => {
    const adapter = getAdapter("openai-chat");
    expect(adapter.format).toBe("openai-chat");
  });

  it("returns OpenAIResponsesAdapter for 'openai-responses'", () => {
    const adapter = getAdapter("openai-responses");
    expect(adapter.format).toBe("openai-responses");
  });

  it("AnthropicAdapter passes body/headers through unchanged", () => {
    const adapter = getAdapter("anthropic");
    const body = '{"model":"test","max_tokens":1024}';
    const headers = { "content-type": "application/json", "x-api-key": "key" };
    const result = adapter.transformRequest(body, headers);
    expect(result.body).toBe(body);
    expect(result.headers).toEqual(headers);
  });

  it("AnthropicAdapter passes URL through unchanged", () => {
    const adapter = getAdapter("anthropic");
    const url = adapter.buildUpstreamUrl("https://api.anthropic.com", "/v1/messages", "claude-3");
    expect(url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("AnthropicAdapter transformError returns parsed fields", () => {
    const adapter = getAdapter("anthropic");
    const result = adapter.transformError(500, '{"type":"error","error":{"type":"api_error","message":"boom"}}');
    expect(result).toEqual({ type: "api_error", message: "boom" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the adapter interface**

```typescript
// src/adapters/base.ts
export type ApiFormat = "anthropic" | "openai-chat" | "openai-responses";

export interface TransformResult {
  body: string;
  headers: Record<string, string>;
}

export interface ProviderAdapter {
  readonly format: ApiFormat;

  transformRequest(body: string, headers: Record<string, string>): TransformResult;

  buildUpstreamUrl(baseUrl: string, incomingPath: string, model: string): string;

  transformResponse(upstreamBody: NodeJS.ReadableStream): NodeJS.ReadableStream;

  transformError(status: number, body: string): { type: string; message: string };
}
```

- [ ] **Step 4: Create the Anthropic passthrough adapter**

```typescript
// src/adapters/anthropic.ts
import { PassThrough } from "node:stream";
import type { ProviderAdapter, TransformResult } from "./base.js";

export class AnthropicAdapter implements ProviderAdapter {
  readonly format = "anthropic" as const;

  transformRequest(body: string, headers: Record<string, string>): TransformResult {
    return { body, headers };
  }

  buildUpstreamUrl(baseUrl: string, incomingPath: string, _model: string): string {
    const url = new URL(incomingPath, baseUrl);
    return url.toString();
  }

  transformResponse(upstreamBody: NodeJS.ReadableStream): NodeJS.ReadableStream {
    return upstreamBody;
  }

  transformError(_status: number, body: string): { type: string; message: string } {
    try {
      const parsed = JSON.parse(body);
      const err = parsed.error ?? parsed;
      return { type: err.type ?? "unknown_error", message: err.message ?? "Unknown error" };
    } catch {
      return { type: "unknown_error", message: body };
    }
  }
}
```

- [ ] **Step 5: Create the registry**

```typescript
// src/adapters/registry.ts
import type { ApiFormat, ProviderAdapter } from "./base.js";
import { AnthropicAdapter } from "./anthropic.js";

const cache = new Map<string, ProviderAdapter>();

export function getAdapter(format?: string): ProviderAdapter {
  const key = format ?? "anthropic";
  let adapter = cache.get(key);
  if (adapter) return adapter;

  switch (key as ApiFormat) {
    case "openai-chat": {
      const { OpenAIChatAdapter } = require("./openai-chat.js");
      adapter = new OpenAIChatAdapter();
      break;
    }
    case "openai-responses": {
      const { OpenAIResponsesAdapter } = require("./openai-responses.js");
      adapter = new OpenAIResponsesAdapter();
      break;
    }
    default:
      adapter = new AnthropicAdapter();
  }

  cache.set(key, adapter);
  return adapter;
}
```

- [ ] **Step 6: Create placeholder adapter files (so imports resolve)**

```typescript
// src/adapters/openai-chat.ts — placeholder, implemented in Task 3
import type { ProviderAdapter } from "./base.js";
export class OpenAIChatAdapter implements ProviderAdapter {
  readonly format = "openai-chat" as const;
  transformRequest(body: string, headers: Record<string, string>) { return { body, headers }; }
  buildUpstreamUrl(baseUrl: string, _incomingPath: string, _model: string) { return `${baseUrl}/v1/chat/completions`; }
  transformResponse(stream: NodeJS.ReadableStream) { return stream; }
  transformError(status: number, body: string) { return { type: "error", message: body }; }
}
```

```typescript
// src/adapters/openai-responses.ts — placeholder, implemented in Task 4
import type { ProviderAdapter } from "./base.js";
export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly format = "openai-responses" as const;
  transformRequest(body: string, headers: Record<string, string>) { return { body, headers }; }
  buildUpstreamUrl(baseUrl: string, _incomingPath: string, _model: string) { return `${baseUrl}/v1/responses`; }
  transformResponse(stream: NodeJS.ReadableStream) { return stream; }
  transformError(status: number, body: string) { return { type: "error", message: body }; }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/registry.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/adapters/ tests/adapters/registry.test.ts
git commit -m "feat: add adapter interface, registry, and Anthropic passthrough adapter"
```

---

## Task 2: Config & Type Changes

**Files:**
- Modify: `src/types.ts:14`
- Modify: `src/config.ts:126-160`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```typescript
it("parses apiFormat field on provider", () => {
  const result = parseConfig(`
server:
  port: 3000
  host: localhost
providers:
  openrouter:
    baseUrl: https://openrouter.ai/api
    apiKey: test-key
    apiFormat: openai-chat
    authType: bearer
`);
  const provider = result.providers.get("openrouter");
  expect(provider?.apiFormat).toBe("openai-chat");
});

it("defaults apiFormat to anthropic", () => {
  const result = parseConfig(`
server:
  port: 3000
  host: localhost
providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    apiKey: test-key
`);
  const provider = result.providers.get("anthropic");
  expect(provider?.apiFormat).toBe("anthropic");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `apiFormat` is undefined

- [ ] **Step 3: Add apiFormat to ProviderConfig type**

In `src/types.ts`, add after line 14 (`authType`):

```typescript
apiFormat?: "anthropic" | "openai-chat" | "openai-responses";
```

- [ ] **Step 4: Add apiFormat to Zod schema**

In `src/config.ts`, add after line 135 (`authType`):

```typescript
apiFormat: z.enum(["anthropic", "openai-chat", "openai-responses"]).optional().default("anthropic"),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: add apiFormat field to provider config"
```

---

## Task 3: OpenAI Shared Utilities

**Files:**
- Create: `src/adapters/openai-utils.ts`
- Test: `tests/adapters/openai-utils.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/adapters/openai-utils.test.ts
import { describe, it, expect } from "vitest";
import {
  mapAnthropicToOpenAIChat,
  mapOpenAIErrorToAnthropic,
  mapAnthropicSystemToMessages,
} from "../../src/adapters/openai-utils.js";

describe("mapAnthropicToOpenAIChat", () => {
  it("maps basic request with system and messages", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });
    const result = JSON.parse(mapAnthropicToOpenAIChat(input));
    expect(result.model).toBe("gpt-4");
    expect(result.max_tokens).toBe(1024);
    expect(result.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(result.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(result.stream).toBe(true);
  });

  it("maps tool_use content blocks to tool_calls", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "Sunny, 72F" },
          ],
        },
      ],
      stream: true,
    });
    const result = JSON.parse(mapAnthropicToOpenAIChat(input));
    // Assistant message should have tool_calls
    const assistantMsg = result.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0].id).toBe("call_1");
    expect(assistantMsg.tool_calls[0].function.name).toBe("get_weather");
    expect(assistantMsg.tool_calls[0].function.arguments).toBe(JSON.stringify({ city: "SF" }));
    // Tool result becomes a separate message
    const toolMsg = result.messages[2];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(toolMsg.content).toBe("Sunny, 72F");
  });

  it("maps image blocks to image_url format", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
            { type: "text", text: "What's in this image?" },
          ],
        },
      ],
      stream: true,
    });
    const result = JSON.parse(mapAnthropicToOpenAIChat(input));
    const content = result.messages[0].content;
    expect(content[0].type).toBe("image_url");
    expect(content[0].image_url.url).toContain("data:image/png;base64,abc123");
  });

  it("maps tool_choice", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Use the tool" }],
      tool_choice: { type: "auto" },
      stream: true,
    });
    const result = JSON.parse(mapAnthropicToOpenAIChat(input));
    expect(result.tool_choice).toBe("auto");
  });

  it("maps tool_choice with specific tool name", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Use the tool" }],
      tool_choice: { type: "tool", name: "get_weather" },
      stream: true,
    });
    const result = JSON.parse(mapAnthropicToOpenAIChat(input));
    expect(result.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  it("maps tools array", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      stream: true,
    });
    const result = JSON.parse(mapAnthropicToOpenAIChat(input));
    expect(result.tools[0].type).toBe("function");
    expect(result.tools[0].function.name).toBe("get_weather");
    expect(result.tools[0].function.parameters).toEqual({ type: "object", properties: { city: { type: "string" } } });
  });

  it("strips cache_control markers", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });
    const result = JSON.parse(mapAnthropicToOpenAIChat(input));
    expect(result.messages[0].cache_control).toBeUndefined();
  });
});

describe("mapOpenAIErrorToAnthropic", () => {
  it("maps OpenAI error to Anthropic format", () => {
    const result = mapOpenAIErrorToAnthropic(429, JSON.stringify({
      error: { message: "Rate limit exceeded", type: "rate_limit_error", code: "rate_limit_exceeded" },
    }));
    expect(result).toBe(JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "Rate limit exceeded" },
    }));
  });

  it("handles unparseable body", () => {
    const result = mapOpenAIErrorToAnthropic(500, "Internal Server Error");
    expect(result).toBe(JSON.stringify({
      type: "error",
      error: { type: "api_error", message: "Internal Server Error" },
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/openai-utils.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement openai-utils.ts**

```typescript
// src/adapters/openai-utils.ts

export function mapAnthropicToOpenAIChat(anthropicBody: string): string {
  const body = JSON.parse(anthropicBody);
  const openai: Record<string, unknown> = {};

  openai.model = body.model;
  openai.max_tokens = body.max_tokens;
  openai.stream = body.stream ?? true;

  if (body.user) openai.user = body.user;
  if (body.metadata?.user_id) openai.user = body.metadata.user_id;

  // System message → prepend to messages
  const messages: unknown[] = [];
  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      // Array of content blocks — extract text
      const text = body.system
        .filter((b: Record<string, unknown>) => b.type === "text")
        .map((b: Record<string, unknown>) => b.text)
        .join("\n");
      messages.push({ role: "system", content: text });
    }
  }

  // Map messages
  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        const mapped = mapMessageContent(msg);
        messages.push(mapped);
      }
    }
  }

  openai.messages = messages;

  // Tools
  if (body.tools) {
    openai.tools = body.tools.map((t: Record<string, unknown>) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  // Tool choice
  if (body.tool_choice) {
    if (body.tool_choice.type === "auto") {
      openai.tool_choice = "auto";
    } else if (body.tool_choice.type === "tool") {
      openai.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    }
  }

  return JSON.stringify(openai);
}

function mapMessageContent(msg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { role: msg.role };

  if (typeof msg.content === "string") {
    out.content = msg.content;
    return out;
  }

  if (!Array.isArray(msg.content)) {
    out.content = msg.content;
    return out;
  }

  // Check for tool_use blocks — they become tool_calls on assistant messages
  if (msg.role === "assistant") {
    const toolCalls = msg.content
      .filter((b: Record<string, unknown>) => b.type === "tool_use")
      .map((b: Record<string, unknown>) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));

    if (toolCalls.length > 0) {
      out.tool_calls = toolCalls;
    }

    // Non-tool content becomes content array
    const textBlocks = msg.content
      .filter((b: Record<string, unknown>) => b.type === "text")
      .map((b: Record<string, unknown>) => ({ type: "text", text: b.text }));

    if (textBlocks.length > 0) {
      out.content = textBlocks;
    }
    return out;
  }

  // User message — may contain tool_result blocks → become separate messages
  // But tool_result on user role is unusual; handle as separate messages if present
  const toolResults = msg.content.filter((b: Record<string, unknown>) => b.type === "tool_result");
  if (toolResults.length > 0 && msg.content.length === toolResults.length) {
    // Entire message is tool results — return first one as tool message
    // (Caller should split these into separate messages)
    const tr = toolResults[0];
    out.role = "tool";
    out.tool_call_id = tr.tool_use_id;
    out.content = typeof tr.content === "string"
      ? tr.content
      : JSON.stringify(tr.content);
    return out;
  }

  // Map content blocks
  out.content = msg.content.map((b: Record<string, unknown>) => mapContentBlock(b));
  return out;
}

function mapContentBlock(block: Record<string, unknown>): Record<string, unknown> {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }

  if (block.type === "image") {
    const src = block.source as Record<string, unknown>;
    if (src.type === "base64") {
      return {
        type: "image_url",
        image_url: { url: `data:${src.media_type};base64,${src.data}` },
      };
    }
    if (src.type === "url") {
      return {
        type: "image_url",
        image_url: { url: src.url },
      };
    }
  }

  // Unknown block type — pass through as text
  return { type: "text", text: JSON.stringify(block) };
}

export function mapOpenAIErrorToAnthropic(status: number, body: string): string {
  const typeMap: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    429: "rate_limit_error",
    500: "api_error",
    502: "api_error",
    503: "overloaded_error",
  };

  try {
    const parsed = JSON.parse(body);
    const err = parsed.error ?? parsed;
    return JSON.stringify({
      type: "error",
      error: {
        type: err.type ?? typeMap[status] ?? "api_error",
        message: err.message ?? body,
      },
    });
  } catch {
    return JSON.stringify({
      type: "error",
      error: {
        type: typeMap[status] ?? "api_error",
        message: body,
      },
    });
  }
}

export function mapAnthropicToOpenAIResponses(anthropicBody: string): string {
  const body = JSON.parse(anthropicBody);
  const openai: Record<string, unknown> = {};

  openai.model = body.model;
  openai.max_output_tokens = body.max_tokens;
  openai.stream = body.stream ?? true;

  if (body.system) {
    openai.instructions = typeof body.system === "string"
      ? body.system
      : body.system.filter((b: Record<string, unknown>) => b.type === "text").map((b: Record<string, unknown>) => b.text).join("\n");
  }

  // Flatten messages into input array
  const input: unknown[] = [];
  if (body.messages) {
    for (const msg of body.messages) {
      if (msg.role === "system") {
        // Skip — already handled via instructions
        continue;
      }
      input.push({ role: msg.role, content: typeof msg.content === "string" ? msg.content : msg.content });
    }
  }
  openai.input = input;

  // Tools
  if (body.tools) {
    openai.tools = body.tools.map((t: Record<string, unknown>) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));
  }

  // Thinking
  if (body.thinking?.type === "enabled") {
    openai.reasoning = { max_tokens: body.thinking.budget_tokens ?? 10000 };
  }

  return JSON.stringify(openai);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/openai-utils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/openai-utils.ts tests/adapters/openai-utils.test.ts
git commit -m "feat: add OpenAI request/error translation utilities"
```

---

## Task 4: OpenAI Chat Completions Adapter (Request)

**Files:**
- Modify: `src/adapters/openai-chat.ts`
- Test: `tests/adapters/openai-chat.test.ts`

- [ ] **Step 1: Write the failing test for request transformation**

```typescript
// tests/adapters/openai-chat.test.ts
import { describe, it, expect } from "vitest";
import { OpenAIChatAdapter } from "../../src/adapters/openai-chat.js";

describe("OpenAIChatAdapter", () => {
  describe("transformRequest", () => {
    it("transforms Anthropic body to OpenAI Chat format", () => {
      const adapter = new OpenAIChatAdapter();
      const body = JSON.stringify({
        model: "gpt-4",
        max_tokens: 1024,
        system: "Be helpful.",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      });
      const result = adapter.transformRequest(body, {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      });

      const parsed = JSON.parse(result.body);
      expect(parsed.model).toBe("gpt-4");
      expect(parsed.messages[0].role).toBe("system");
      expect(parsed.messages[0].content).toBe("Be helpful.");
      expect(parsed.messages[1].role).toBe("user");

      // Anthropic headers removed
      expect(result.headers["anthropic-version"]).toBeUndefined();
      expect(result.headers["anthropic-beta"]).toBeUndefined();
      // x-api-key removed, Authorization set
      expect(result.headers["x-api-key"]).toBeUndefined();
      expect(result.headers["authorization"]).toBe("Bearer test-key");
    });

    it("preserves non-Anthropic headers", () => {
      const adapter = new OpenAIChatAdapter();
      const result = adapter.transformRequest("{}", {
        "content-type": "application/json",
        "x-request-id": "req-123",
        "x-custom": "value",
      });
      expect(result.headers["content-type"]).toBe("application/json");
      expect(result.headers["x-request-id"]).toBe("req-123");
      expect(result.headers["x-custom"]).toBe("value");
    });
  });

  describe("buildUpstreamUrl", () => {
    it("replaces path with /v1/chat/completions", () => {
      const adapter = new OpenAIChatAdapter();
      const url = adapter.buildUpstreamUrl("https://openrouter.ai/api", "/v1/messages", "gpt-4");
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    });

    it("deduplicates /v1 if baseUrl already has it", () => {
      const adapter = new OpenAIChatAdapter();
      const url = adapter.buildUpstreamUrl("https://api.openai.com/v1", "/v1/messages", "gpt-4");
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
    });
  });

  describe("transformError", () => {
    it("normalizes OpenAI errors to Anthropic format", () => {
      const adapter = new OpenAIChatAdapter();
      const result = adapter.transformError(429, JSON.stringify({
        error: { message: "Rate limited", type: "rate_limit_error" },
      }));
      expect(result).toEqual({ type: "rate_limit_error", message: "Rate limited" });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/openai-chat.test.ts`
Expected: FAIL (placeholder adapter returns passthrough values)

- [ ] **Step 3: Implement OpenAIChatAdapter request path**

Replace the placeholder in `src/adapters/openai-chat.ts`:

```typescript
// src/adapters/openai-chat.ts
import { PassThrough } from "node:stream";
import type { ProviderAdapter, TransformResult } from "./base.js";
import { mapAnthropicToOpenAIChat, mapOpenAIErrorToAnthropic } from "./openai-utils.js";

export class OpenAIChatAdapter implements ProviderAdapter {
  readonly format = "openai-chat" as const;

  transformRequest(body: string, headers: Record<string, string>): TransformResult {
    const outHeaders: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      // Skip Anthropic-specific headers
      if (key === "anthropic-version" || key === "anthropic-beta") continue;
      // Transform x-api-key to Authorization
      if (key === "x-api-key") {
        outHeaders["authorization"] = `Bearer ${value}`;
        continue;
      }
      outHeaders[key] = value;
    }

    return {
      body: mapAnthropicToOpenAIChat(body),
      headers: outHeaders,
    };
  }

  buildUpstreamUrl(baseUrl: string, _incomingPath: string, _model: string): string {
    // Normalize baseUrl — remove trailing slash
    const base = baseUrl.replace(/\/+$/, "");
    // Deduplicate /v1 if baseUrl already contains it
    if (base.endsWith("/v1")) {
      return `${base}/chat/completions`;
    }
    return `${base}/v1/chat/completions`;
  }

  transformResponse(upstreamBody: NodeJS.ReadableStream): NodeJS.ReadableStream {
    // Placeholder — implemented in Task 5
    return upstreamBody;
  }

  transformError(status: number, body: string): { type: string; message: string } {
    const normalized = JSON.parse(mapOpenAIErrorToAnthropic(status, body));
    return { type: normalized.error.type, message: normalized.error.message };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/openai-chat.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/openai-chat.ts tests/adapters/openai-chat.test.ts
git commit -m "feat: implement OpenAI Chat Completions adapter (request + URL + error)"
```

---

## Task 5: OpenAI Chat Completions Adapter (Response SSE)

This is the most complex task — translating OpenAI SSE chunks into Anthropic SSE events using a Transform stream.

**Files:**
- Modify: `src/adapters/openai-chat.ts` (`transformResponse`)
- Test: `tests/adapters/openai-chat-response.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/openai-chat-response.test.ts
import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { OpenAIChatAdapter } from "../../src/adapters/openai-chat.js";

function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", reject);
  });
}

function openAIChunk(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

describe("OpenAIChatAdapter transformResponse", () => {
  it("translates a basic text streaming response", async () => {
    const adapter = new OpenAIChatAdapter();
    const openaiSSE = [
      openAIChunk({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
      openAIChunk({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] }),
      openAIChunk({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] }),
      openAIChunk({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ].join("");

    const source = Readable.from([openaiSSE]);
    const result = adapter.transformResponse(source);
    const output = await collectStream(result);

    // Should contain Anthropic SSE events
    expect(output).toContain("event: message_start");
    expect(output).toContain("content_block_start");
    expect(output).toContain('"type":"text"');
    expect(output).toContain("event: content_block_delta");
    expect(output).toContain('"text":"Hello"');
    expect(output).toContain('"text":" world"');
    expect(output).toContain("event: content_block_stop");
    expect(output).toContain("event: message_delta");
    expect(output).toContain('"stop_reason":"end_turn"');
    expect(output).toContain("event: message_stop");
    expect(output).toContain('"input_tokens":10');
    expect(output).toContain('"output_tokens":3');
  });

  it("translates tool_calls response", async () => {
    const adapter = new OpenAIChatAdapter();
    const openaiSSE = [
      openAIChunk({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
      openAIChunk({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Let me check." }, finish_reason: null }] }),
      openAIChunk({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] }),
      openAIChunk({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, finish_reason: null }] }),
      openAIChunk({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"SF"}' } }] }, finish_reason: null }] }),
      openAIChunk({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ].join("");

    const source = Readable.from([openaiSSE]);
    const result = adapter.transformResponse(source);
    const output = await collectStream(result);

    expect(output).toContain("event: content_block_start");
    expect(output).toContain('"type":"text"');
    expect(output).toContain('"type":"tool_use"');
    expect(output).toContain('"name":"get_weather"');
    expect(output).toContain("input_json_delta");
    expect(output).toContain('"stop_reason":"tool_use"');
    expect(output).toContain("event: message_stop");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/openai-chat-response.test.ts`
Expected: FAIL — passthrough returns raw OpenAI SSE

- [ ] **Step 3: Implement SSE transform stream**

Add to `src/adapters/openai-utils.ts`:

```typescript
// Add to src/adapters/openai-utils.ts
import { Transform, type TransformCallback } from "node:stream";

export interface OpenAIChatTranslatorState {
  messageStarted: boolean;
  currentBlockType: "text" | "tool_use" | "thinking" | null;
  activeToolCalls: Map<number, { id: string; name: string; arguments: string }>;
  inputTokens: number;
  outputTokens: number;
  model: string;
  messageId: string;
  pendingContent: string;
}

export function createOpenAIChatToAnthropicStream(): Transform {
  const state: OpenAIChatTranslatorState = {
    messageStarted: false,
    currentBlockType: null,
    activeToolCalls: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    model: "unknown",
    messageId: "msg_openai",
    pendingContent: "",
  };

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      const text = chunk.toString();
      const lines = text.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed === "data: [DONE]") {
          // Close any open content block
          if (state.currentBlockType) {
            this.push("event: content_block_stop\n");
            this.push("data: {\"type\":\"content_block_stop\",\"index\":0}\n\n");
            state.currentBlockType = null;
          }
          // Final message events
          const stopReason = state.activeToolCalls.size > 0 ? "tool_use" : "end_turn";
          this.push("event: message_delta\n");
          this.push(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: state.outputTokens } })}\n\n`);
          this.push("event: message_stop\n");
          this.push("data: {\"type\":\"message_stop\"}\n\n");
          continue;
        }

        if (!trimmed.startsWith("data: ")) continue;

        try {
          const parsed = JSON.parse(trimmed.slice(6));
          const choice = parsed.choices?.[0];
          if (!choice) {
            // Extract usage if present at top level
            if (parsed.usage) {
              state.inputTokens = parsed.usage.prompt_tokens ?? state.inputTokens;
              state.outputTokens = parsed.usage.completion_tokens ?? state.outputTokens;
            }
            continue;
          }

          if (!state.messageStarted) {
            state.messageStarted = true;
            state.model = parsed.model ?? "unknown";
            state.messageId = `msg_${parsed.id ?? Date.now()}`;

            this.push("event: message_start\n");
            this.push(`data: ${JSON.stringify({
              type: "message_start",
              message: {
                id: state.messageId,
                type: "message",
                role: "assistant",
                model: state.model,
                content: [],
                stop_reason: null,
                usage: { input_tokens: state.inputTokens, output_tokens: 0 },
              },
            })}\n\n`);
          }

          const delta = choice.delta ?? {};

          // Usage from chunk
          if (parsed.usage) {
            state.inputTokens = parsed.usage.prompt_tokens ?? state.inputTokens;
            state.outputTokens = parsed.usage.completion_tokens ?? state.outputTokens;
          }

          // Content text
          if (delta.content != null && delta.content !== "") {
            if (state.currentBlockType !== "text") {
              // Close previous block if any
              if (state.currentBlockType) {
                this.push("event: content_block_stop\n");
                this.push("data: {\"type\":\"content_block_stop\",\"index\":0}\n\n");
              }
              state.currentBlockType = "text";
              this.push("event: content_block_start\n");
              this.push("data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n");
            }
            this.push("event: content_block_delta\n");
            this.push(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta.content } })}\n\n`);
          }

          // Reasoning content
          if (delta.reasoning_content != null && delta.reasoning_content !== "") {
            if (state.currentBlockType !== "thinking") {
              if (state.currentBlockType) {
                this.push("event: content_block_stop\n");
                this.push("data: {\"type\":\"content_block_stop\",\"index\":0}\n\n");
              }
              state.currentBlockType = "thinking";
              this.push("event: content_block_start\n");
              this.push("data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n");
            }
            this.push("event: content_block_delta\n");
            this.push(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: delta.reasoning_content } })}\n\n`);
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;

              // New tool call — close text block if open
              if (tc.id && !state.activeToolCalls.has(idx)) {
                if (state.currentBlockType) {
                  this.push("event: content_block_stop\n");
                  this.push("data: {\"type\":\"content_block_stop\",\"index\":0}\n\n");
                }
                state.currentBlockType = "tool_use";
                state.activeToolCalls.set(idx, { id: tc.id, name: tc.function?.name ?? "", arguments: "" });

                this.push("event: content_block_start\n");
                this.push(`data: ${JSON.stringify({
                  type: "content_block_start",
                  index: idx,
                  content_block: { type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input: {} },
                })}\n\n`);
              }

              // Tool call arguments (may come in fragments)
              if (tc.function?.arguments) {
                const existing = state.activeToolCalls.get(idx);
                if (existing) {
                  existing.arguments += tc.function.arguments;
                }
                this.push("event: content_block_delta\n");
                this.push(`data: ${JSON.stringify({
                  type: "content_block_delta",
                  index: idx,
                  delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                })}\n\n`);
              }
            }
          }
        } catch {
          // Malformed JSON — skip
        }
      }

      callback();
    },

    flush(callback: TransformCallback) {
      // If stream ended without [DONE], emit closing events
      if (state.messageStarted) {
        if (state.currentBlockType) {
          this.push("event: content_block_stop\n");
          this.push("data: {\"type\":\"content_block_stop\",\"index\":0}\n\n");
        }
        const stopReason = state.activeToolCalls.size > 0 ? "tool_use" : "end_turn";
        this.push("event: message_delta\n");
        this.push(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason }, usage: { output_tokens: state.outputTokens } })}\n\n`);
        this.push("event: message_stop\n");
        this.push("data: {\"type\":\"message_stop\"}\n\n");
      }
      callback();
    },
  });
}
```

Then update `openai-chat.ts` `transformResponse`:

```typescript
transformResponse(upstreamBody: NodeJS.ReadableStream): NodeJS.ReadableStream {
  return (upstreamBody as NodeJS.Readable).pipe(createOpenAIChatToAnthropicStream());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/openai-chat-response.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/openai-utils.ts src/adapters/openai-chat.ts tests/adapters/openai-chat-response.test.ts
git commit -m "feat: implement OpenAI Chat SSE → Anthropic SSE translation"
```

---

## Task 6: OpenAI Responses API Adapter

**Files:**
- Modify: `src/adapters/openai-responses.ts`
- Test: `tests/adapters/openai-responses.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/openai-responses.test.ts
import { describe, it, expect } from "vitest";
import { OpenAIResponsesAdapter } from "../../src/adapters/openai-responses.js";

describe("OpenAIResponsesAdapter", () => {
  describe("transformRequest", () => {
    it("transforms Anthropic body to OpenAI Responses format", () => {
      const adapter = new OpenAIResponsesAdapter();
      const body = JSON.stringify({
        model: "gpt-4",
        max_tokens: 1024,
        system: "Be helpful.",
        messages: [{ role: "user", content: "Hi" }],
        thinking: { type: "enabled", budget_tokens: 8000 },
        stream: true,
      });
      const result = adapter.transformRequest(body, {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      });

      const parsed = JSON.parse(result.body);
      expect(parsed.model).toBe("gpt-4");
      expect(parsed.max_output_tokens).toBe(1024);
      expect(parsed.instructions).toBe("Be helpful.");
      expect(parsed.input[0].role).toBe("user");
      expect(parsed.reasoning.max_tokens).toBe(8000);
    });
  });

  describe("buildUpstreamUrl", () => {
    it("replaces path with /v1/responses", () => {
      const adapter = new OpenAIResponsesAdapter();
      const url = adapter.buildUpstreamUrl("https://api.openai.com", "/v1/messages", "gpt-4");
      expect(url).toBe("https://api.openai.com/v1/responses");
    });
  });

  describe("transformError", () => {
    it("normalizes OpenAI errors", () => {
      const adapter = new OpenAIResponsesAdapter();
      const result = adapter.transformError(500, JSON.stringify({
        error: { message: "Server error", type: "server_error" },
      }));
      expect(result).toEqual({ type: "server_error", message: "Server error" });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/openai-responses.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement OpenAIResponsesAdapter**

Replace the placeholder in `src/adapters/openai-responses.ts`:

```typescript
// src/adapters/openai-responses.ts
import type { ProviderAdapter, TransformResult } from "./base.js";
import { mapAnthropicToOpenAIResponses, mapOpenAIErrorToAnthropic } from "./openai-utils.js";

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly format = "openai-responses" as const;

  transformRequest(body: string, headers: Record<string, string>): TransformResult {
    const outHeaders: Record<string, string> = {};

    for (const [key, value] of Object.entries(headers)) {
      if (key === "anthropic-version" || key === "anthropic-beta") continue;
      if (key === "x-api-key") {
        outHeaders["authorization"] = `Bearer ${value}`;
        continue;
      }
      outHeaders[key] = value;
    }

    return {
      body: mapAnthropicToOpenAIResponses(body),
      headers: outHeaders,
    };
  }

  buildUpstreamUrl(baseUrl: string, _incomingPath: string, _model: string): string {
    const base = baseUrl.replace(/\/+$/, "");
    if (base.endsWith("/v1")) {
      return `${base}/responses`;
    }
    return `${base}/v1/responses`;
  }

  transformResponse(upstreamBody: NodeJS.ReadableStream): NodeJS.ReadableStream {
    // Placeholder — Responses API SSE translation
    // Can reuse createOpenAIChatToAnthropicStream with minor adjustments
    // or create a dedicated Responses SSE translator
    return upstreamBody;
  }

  transformError(status: number, body: string): { type: string; message: string } {
    const normalized = JSON.parse(mapOpenAIErrorToAnthropic(status, body));
    return { type: normalized.error.type, message: normalized.error.message };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/openai-responses.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/openai-responses.ts tests/adapters/openai-responses.test.ts
git commit -m "feat: implement OpenAI Responses API adapter (request + URL + error)"
```

---

## Task 7: Proxy Integration

**Files:**
- Modify: `src/proxy.ts`
- Test: `tests/adapters/proxy-integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/adapters/proxy-integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { forwardRequest } from "../../src/proxy.js";
import type { ProviderConfig, RoutingEntry, RequestContext } from "../../src/types.js";

function createMockOpenAIProvider() {
  const app = new Hono();
  app.post("/v1/chat/completions", async (c) => {
    return new Response(
      [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello from OpenAI"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":4}}\n\n',
        "data: [DONE]\n\n",
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); setTimeout(() => resolve(), 2000); }),
  };
}

describe("proxy integration with OpenAI adapter", () => {
  let mock: ReturnType<typeof createMockOpenAIProvider>;
  let provider: ProviderConfig;

  beforeAll(async () => {
    mock = createMockOpenAIProvider();
    provider = {
      name: "openai-mock",
      baseUrl: mock.url,
      apiKey: "test-key",
      timeout: 5000,
      ttfbTimeout: 5000,
      authType: "bearer",
      apiFormat: "openai-chat",
    };
  });

  afterAll(async () => {
    await mock.close();
  });

  it("forwards request through OpenAI adapter and returns Anthropic SSE", async () => {
    const ctx: RequestContext = {
      requestId: "test-1",
      model: "gpt-4",
      tier: "default",
      providerChain: [{ provider: "openai-mock", model: "gpt-4" }] as RoutingEntry[],
      startTime: Date.now(),
      rawBody: JSON.stringify({
        model: "gpt-4",
        max_tokens: 1024,
        system: "Be helpful.",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    };

    const response = await forwardRequest(provider, "/v1/messages", ctx);
    const body = await response.text();

    // Response should be Anthropic SSE format
    expect(body).toContain("event: message_start");
    expect(body).toContain('"type":"message"');
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain('"text":"Hello from OpenAI"');
    expect(body).toContain("event: message_stop");
    expect(response.status).toBe(200);
  }, 10000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/proxy-integration.test.ts`
Expected: FAIL — proxy doesn't use adapter yet

- [ ] **Step 3: Integrate adapter into proxy.ts**

In `src/proxy.ts`, add at the top:

```typescript
import { getAdapter } from "./adapters/registry.js";
```

In `forwardRequest()`, after the body is prepared and before the URL/headers are built, add adapter resolution. The key changes are:

1. **After line ~630** (where `outgoingPath` is determined), resolve the adapter:
```typescript
const adapter = getAdapter(provider.apiFormat);
```

2. **Replace the `buildOutboundUrl` call** (line ~634) with:
```typescript
const url = adapter.buildUpstreamUrl(provider.baseUrl, outgoingPath, ctx.actualModel ?? ctx.model);
```

3. **Replace the `buildOutboundHeaders` call** (line ~729) with adapter-driven headers. Wrap the existing header-building logic so the adapter gets the raw headers, then we use the adapter's output:
```typescript
const rawHeaders = buildOutboundHeaders(provider, ctx, isRetry);
const { headers: adapterHeaders } = adapter.transformRequest("", rawHeaders);
```

4. **For request body** — after the existing `applyTargetedReplacements` block (line ~727), apply the adapter body transformation. For non-Anthropic adapters, we need full JSON transform (not regex):
```typescript
// After body is prepared (mutatedBody or rawBody):
const { body: adapterBody } = adapter.transformRequest(
  typeof preparedBody === "string" ? preparedBody : JSON.stringify(preparedBody),
  adapterHeaders,
);
```

5. **For response** — after `undiciResponse` is received, pipe through adapter if non-Anthropic:
```typescript
// After response stream is available:
const responseBody = adapter.format === "anthropic"
  ? undiciResponse.body
  : adapter.transformResponse(undiciResponse.body);
```

6. **For error responses** (non-2xx, line ~919) — apply `adapter.transformError()`:
```typescript
// When reading error body, wrap with adapter:
const errorBody = adapter.transformError(undiciResponse.statusCode, rawErrorBody);
// Then use errorBody.type and errorBody.message for existing error handling
```

> **Note:** The exact line-by-line edits depend on the current state of proxy.ts. The implementer should read the relevant sections and make targeted insertions. The Anthropic adapter is pure passthrough, so these changes are no-ops for existing Anthropic providers.

- [ ] **Step 4: Run integration test to verify it passes**

Run: `npx vitest run tests/adapters/proxy-integration.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests pass (Anthropic adapter is passthrough)

- [ ] **Step 6: Commit**

```bash
git add src/proxy.ts tests/adapters/proxy-integration.test.ts
git commit -m "feat: integrate adapter layer into proxy for OpenAI upstream support"
```

---

## Task 8: OpenAI Responses API SSE Translation

**Files:**
- Modify: `src/adapters/openai-responses.ts` (`transformResponse`)
- Test: `tests/adapters/openai-responses-response.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/openai-responses-response.test.ts
import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { OpenAIResponsesAdapter } from "../../src/adapters/openai-responses.js";

function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", reject);
  });
}

describe("OpenAIResponsesAdapter transformResponse", () => {
  it("translates Responses API SSE to Anthropic SSE", async () => {
    const adapter = new OpenAIResponsesAdapter();
    const responsesSSE = [
      'event: response.created\ndata: {"id":"resp_1","object":"response","status":"in_progress"}\n\n',
      'event: response.output_item.added\ndata: {"type":"message","id":"msg_1","role":"assistant","content":[]}\n\n',
      'event: response.content_part.added\ndata: {"type":"output_text","text":""}\n\n',
      'event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n',
      'event: response.output_text.delta\ndata: {"delta":" from responses"}\n\n',
      'event: response.content_part.done\ndata: {"type":"output_text","text":"Hello from responses"}\n\n',
      'event: response.output_item.done\ndata: {"type":"message","role":"assistant"}\n\n',
      'event: response.completed\ndata: {"id":"resp_1","usage":{"input_tokens":8,"output_tokens":4}}\n\n',
    ].join("");

    const source = Readable.from([responsesSSE]);
    const result = adapter.transformResponse(source);
    const output = await collectStream(result);

    expect(output).toContain("event: message_start");
    expect(output).toContain("event: content_block_start");
    expect(output).toContain('"type":"text"');
    expect(output).toContain("event: content_block_delta");
    expect(output).toContain('"text":"Hello"');
    expect(output).toContain('"text":" from responses"');
    expect(output).toContain("event: content_block_stop");
    expect(output).toContain("event: message_delta");
    expect(output).toContain('"stop_reason":"end_turn"');
    expect(output).toContain("event: message_stop");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/openai-responses-response.test.ts`
Expected: FAIL (passthrough)

- [ ] **Step 3: Implement Responses API SSE translator**

Add to `src/adapters/openai-utils.ts`:

```typescript
export function createOpenAIResponsesToAnthropicStream(): Transform {
  let messageStarted = false;
  let currentBlockType: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      const text = chunk.toString();
      const lines = text.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        try {
          const parsed = JSON.parse(trimmed.slice(6));

          // response.created → message_start
          if (parsed.object === "response" && parsed.status === "in_progress") {
            if (!messageStarted) {
              messageStarted = true;
              this.push("event: message_start\n");
              this.push(`data: ${JSON.stringify({
                type: "message_start",
                message: {
                  id: `msg_${parsed.id}`,
                  type: "message",
                  role: "assistant",
                  model: "unknown",
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              })}\n\n`);
            }
            continue;
          }

          // content_part.added → content_block_start
          if (parsed.type === "output_text") {
            if (currentBlockType && currentBlockType !== "text") {
              this.push("event: content_block_stop\n");
              this.push("data: {\"type\":\"content_block_stop\",\"index\":0}\n\n");
            }
            currentBlockType = "text";
            this.push("event: content_block_start\n");
            this.push("data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n");
            continue;
          }

          // output_text.delta → content_block_delta
          if (parsed.delta != null) {
            this.push("event: content_block_delta\n");
            this.push(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: parsed.delta } })}\n\n`);
            continue;
          }

          // content_part.done → content_block_stop
          if (parsed.type === "output_text" && parsed.text != null) {
            continue; // Don't close yet — wait for output_item.done
          }

          // output_item.done → content_block_stop
          if (parsed.type === "message" && parsed.role === "assistant") {
            if (currentBlockType) {
              this.push("event: content_block_stop\n");
              this.push("data: {\"type\":\"content_block_stop\",\"index\":0}\n\n");
              currentBlockType = null;
            }
            continue;
          }

          // response.completed → message_delta + message_stop
          if (parsed.usage) {
            inputTokens = parsed.usage.input_tokens ?? 0;
            outputTokens = parsed.usage.output_tokens ?? 0;
          }
          if (parsed.object === "response" && parsed.status === "completed") {
            this.push("event: message_delta\n");
            this.push(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } })}\n\n`);
            this.push("event: message_stop\n");
            this.push("data: {\"type\":\"message_stop\"}\n\n");
          }
        } catch {
          // Malformed JSON — skip
        }
      }

      callback();
    },

    flush(callback: TransformCallback) {
      if (messageStarted) {
        if (currentBlockType) {
          this.push("event: content_block_stop\n");
          this.push("data: {\"type\":\"content_block_stop\",\"index\":0}\n\n");
        }
        this.push("event: message_delta\n");
        this.push(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } })}\n\n`);
        this.push("event: message_stop\n");
        this.push("data: {\"type\":\"message_stop\"}\n\n");
      }
      callback();
    },
  });
}
```

Update `openai-responses.ts` `transformResponse`:

```typescript
transformResponse(upstreamBody: NodeJS.ReadableStream): NodeJS.ReadableStream {
  return (upstreamBody as NodeJS.Readable).pipe(createOpenAIResponsesToAnthropicStream());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/openai-responses-response.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/openai-utils.ts src/adapters/openai-responses.ts tests/adapters/openai-responses-response.test.ts
git commit -m "feat: implement OpenAI Responses API SSE → Anthropic SSE translation"
```

---

## Task 9: Full Test Suite + Build Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new)

- [ ] **Step 2: TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address test/build issues from OpenAI adapter integration"
```
