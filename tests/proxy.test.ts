// tests/proxy.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockProvider } from "./helpers/mock-provider.js";
import { forwardRequest, forwardWithFallback, isRetriable, buildOutboundUrl, buildOutboundHeaders, sanitizeSSEChunk } from "../src/proxy.js";
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

  it("deduplicates /v1 when baseUrl already ends with it", () => {
    // Fireworks: baseUrl has /inference/v1, incoming path has /v1/chat/completions
    expect(buildOutboundUrl("https://api.fireworks.ai/inference/v1", "/v1/chat/completions"))
      .toBe("https://api.fireworks.ai/inference/v1/chat/completions");
  });

  it("deduplicates /v1 with Anthropic-style paths", () => {
    expect(buildOutboundUrl("https://api.fireworks.ai/inference/v1", "/v1/messages"))
      .toBe("https://api.fireworks.ai/inference/v1/messages");
  });

  it("deduplicates /v1 with query string", () => {
    expect(buildOutboundUrl("https://api.fireworks.ai/inference/v1", "/v1/chat/completions?model=test"))
      .toBe("https://api.fireworks.ai/inference/v1/chat/completions?model=test");
  });

  it("does not deduplicate when only base has /v1", () => {
    expect(buildOutboundUrl("https://api.example.com/v1", "/chat/completions"))
      .toBe("https://api.example.com/v1/chat/completions");
  });

  it("does not deduplicate when only incoming path has /v1", () => {
    expect(buildOutboundUrl("https://api.example.com", "/v1/messages"))
      .toBe("https://api.example.com/v1/messages");
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

  it("uses Authorization: Bearer when authType is bearer", () => {
    const bearerProvider: ProviderConfig = {
      name: "bearer-test",
      baseUrl: "https://openrouter.ai/api",
      apiKey: "sk-or-123",
      timeout: 30000,
      authType: "bearer",
    };
    const headers = buildOutboundHeaders(new Headers(), bearerProvider, "req-456");
    expect(headers.get("Authorization")).toBe("Bearer sk-or-123");
    expect(headers.get("x-api-key")).toBeNull();
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
    const body = JSON.stringify({ model: "claude-sonnet-4", max_tokens: 100, messages: [] });
    const ctx: RequestContext = {
      requestId: "test-123",
      model: "claude-sonnet-4",
      tier: "sonnet",
      providerChain: [entry],
      startTime: Date.now(),
      rawBody: body,
    };

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

  it("returns 502 with timeout message when provider times out", async () => {
    mock.setBehavior("timeout");
    const provider: ProviderConfig = {
      name: "mock",
      baseUrl: mock.url,
      apiKey: "sk-test",
      timeout: 500,
    };
    const entry: RoutingEntry = { provider: "mock" };
    const body = JSON.stringify({ model: "claude-sonnet-4", max_tokens: 100, messages: [] });
    const ctx: RequestContext = {
      requestId: "test-timeout",
      model: "claude-sonnet-4",
      tier: "sonnet",
      providerChain: [entry],
      startTime: Date.now(),
      rawBody: body,
    };

    const result = await forwardRequest(provider, entry, ctx, new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));

    expect(result.status).toBe(502);
    const json = await result.json() as { type: string; error: { type: string; message: string } };
    expect(json.type).toBe("error");
    expect(json.error.message).toContain("timed out");
    expect(json.error.message).toContain("500ms");
  }, 10_000);

  it("returns error response for non-retriable status", async () => {
    mock.setBehavior("error-401");
    const provider: ProviderConfig = {
      name: "mock",
      baseUrl: mock.url,
      apiKey: "sk-test",
      timeout: 5000,
    };
    const entry: RoutingEntry = { provider: "mock" };
    const body = JSON.stringify({ model: "claude-sonnet-4", max_tokens: 100, messages: [] });
    const ctx: RequestContext = {
      requestId: "test-401",
      model: "claude-sonnet-4",
      tier: "sonnet",
      providerChain: [entry],
      startTime: Date.now(),
      rawBody: body,
    };

    const result = await forwardRequest(provider, entry, ctx, new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));

    expect(result.status).toBe(401);
  });
});

describe("forwardWithFallback race mode", () => {
  it("races remaining providers when first returns 429", async () => {
    const mock1 = createMockProvider();
    const mock2 = createMockProvider();
    mock1.setBehavior("error-429");
    // mock2 succeeds by default

    const provider1: ProviderConfig = {
      name: "provider-1",
      baseUrl: mock1.url,
      apiKey: "test",
      timeout: 5000,
    };
    const provider2: ProviderConfig = {
      name: "provider-2",
      baseUrl: mock2.url,
      apiKey: "test",
      timeout: 5000,
    };

    const providers = new Map<string, ProviderConfig>();
    providers.set("provider-1", provider1);
    providers.set("provider-2", provider2);

    const chain: RoutingEntry[] = [
      { provider: "provider-1" },
      { provider: "provider-2" },
    ];

    const ctx: RequestContext = {
      requestId: "test-race",
      model: "test-model",
      tier: "test",
      providerChain: chain,
      startTime: Date.now(),
      rawBody: JSON.stringify({ model: "test-model", messages: [] }),
    };

    const incoming = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ctx.rawBody,
    });

    const result = await forwardWithFallback(providers, chain, ctx, incoming);
    expect(result.response.status).toBe(200);

    await mock1.close();
    await mock2.close();
  });

  it("falls back sequentially on 500 (no race)", async () => {
    const mock1 = createMockProvider();
    const mock2 = createMockProvider();
    mock1.setBehavior("error-500");
    // mock2 succeeds by default

    const provider1: ProviderConfig = {
      name: "provider-1",
      baseUrl: mock1.url,
      apiKey: "test",
      timeout: 5000,
    };
    const provider2: ProviderConfig = {
      name: "provider-2",
      baseUrl: mock2.url,
      apiKey: "test",
      timeout: 5000,
    };

    const providers = new Map<string, ProviderConfig>();
    providers.set("provider-1", provider1);
    providers.set("provider-2", provider2);

    const chain: RoutingEntry[] = [
      { provider: "provider-1" },
      { provider: "provider-2" },
    ];

    const ctx: RequestContext = {
      requestId: "test-no-race",
      model: "test-model",
      tier: "test",
      providerChain: chain,
      startTime: Date.now(),
      rawBody: JSON.stringify({ model: "test-model", messages: [] }),
    };

    const incoming = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ctx.rawBody,
    });

    const result = await forwardWithFallback(providers, chain, ctx, incoming);
    expect(result.response.status).toBe(200);

    await mock1.close();
    await mock2.close();
  });
});

describe("forwardRequest TTFB timeout", () => {
  let mock: ReturnType<typeof createMockProvider>;

  beforeEach(async () => {
    mock = createMockProvider();
    mock.setBehavior("timeout");
  });

  afterEach(async () => {
    await mock.close();
  });

  it("returns 502 when TTFB timeout fires before total timeout", async () => {
    const provider: ProviderConfig = {
      name: "mock",
      baseUrl: mock.url,
      apiKey: "sk-test",
      timeout: 5000, // Total timeout: 5s (longer than TTFB)
      ttfbTimeout: 200, // TTFB timeout: 200ms (shorter than total)
    };
    const entry: RoutingEntry = { provider: "mock" };
    const body = JSON.stringify({ model: "claude-sonnet-4", max_tokens: 100, messages: [] });
    const ctx: RequestContext = {
      requestId: "test-ttfb",
      model: "claude-sonnet-4",
      tier: "sonnet",
      providerChain: [entry],
      startTime: Date.now(),
      rawBody: body,
    };

    const result = await forwardRequest(provider, entry, ctx, new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
    expect(result.status).toBe(502);
    const json = (await result.json()) as { type: string; error: { type: string; message: string } };
    expect(json.type).toBe("error");
    expect(json.error.message).toContain("timed out waiting for first byte");
    expect(json.error.message).toContain("200ms");
  }, 10_000);

  it("TTFB timeout message differs from total timeout message", async () => {
    const provider: ProviderConfig = {
      name: "mock",
      baseUrl: mock.url,
      apiKey: "sk-test",
      timeout: 1000, // Total timeout: 1s (longer than TTFB so TTFB fires first)
      ttfbTimeout: 200,
    };
    const entry: RoutingEntry = { provider: "mock" };
    const body = JSON.stringify({ model: "claude-sonnet-4", max_tokens: 100, messages: [] });
    const ctx: RequestContext = {
      requestId: "test-ttfb-msg",
      model: "claude-sonnet-4",
      tier: "sonnet",
      providerChain: [entry],
      startTime: Date.now(),
      rawBody: body,
    };

    const result = await forwardRequest(provider, entry, ctx, new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
    expect(result.status).toBe(502);
    const json = (await result.json()) as { type: string; error: { type: string; message: string } };
    // TTFB message should mention "first byte", not just generic "timed out after Xms"
    expect(json.error.message).toContain("first byte");
  }, 10_000);
});

describe("forwardRequest stall detection", () => {
  let mock: ReturnType<typeof createMockProvider>;

  beforeEach(async () => {
    mock = createMockProvider();
    mock.setBehavior("stall");
  });

  afterEach(async () => {
    await mock.close();
  });

  it("closes stream cleanly when body stalls after headers received", async () => {
    const provider: ProviderConfig = {
      name: "mock",
      baseUrl: mock.url,
      apiKey: "sk-test",
      timeout: 5000,
      stallTimeout: 300, // Stall timeout: 300ms
    };
    const entry: RoutingEntry = { provider: "mock" };
    const body = JSON.stringify({ model: "claude-sonnet-4", max_tokens: 100, messages: [] });
    const ctx: RequestContext = {
      requestId: "test-stall",
      model: "claude-sonnet-4",
      tier: "sonnet",
      providerChain: [entry],
      startTime: Date.now(),
      rawBody: body,
    };

    const result = await forwardRequest(provider, entry, ctx, new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
    // Stall detection closes the stream cleanly — does NOT inject SSE error events
    // because the Anthropic SDK crashes on unrecognized event types (e.g. "event: error").
    // The client SDK detects the incomplete stream and throws a retryable error.
    expect(result.status).toBe(200);

    const text = await result.text();
    // Stream should be empty (or contain only partial data before stall) — no SSE error payload
    expect(text).not.toContain("event: error");
  }, 20_000);
});

describe("sanitizeSSEChunk", () => {
  it("returns original chunk unchanged when no null patterns present", () => {
    const chunk = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n';
    expect(sanitizeSSEChunk(chunk)).toBe(chunk);
  });

  it("replaces content:null with content:[]", () => {
    const chunk = 'data: {"type":"message","role":"assistant","content":null}\n\n';
    const result = sanitizeSSEChunk(chunk);
    expect(result).toContain('"content":[]');
    expect(result).not.toContain('"content":null');
  });

  it("replaces message:null with message:{}", () => {
    const chunk = 'data: {"type":"message_start","message":null}\n\n';
    const result = sanitizeSSEChunk(chunk);
    expect(result).toContain('"message":{}');
    expect(result).not.toContain('"message":null');
  });

  it("replaces delta:null with delta:{}", () => {
    const chunk = 'data: {"type":"content_block_delta","delta":null}\n\n';
    const result = sanitizeSSEChunk(chunk);
    expect(result).toContain('"delta":{}');
    expect(result).not.toContain('"delta":null');
  });

  it("handles multiple null fields in one chunk", () => {
    const chunk = 'data: {"content":null,"message":null,"delta":null}\n\n';
    const result = sanitizeSSEChunk(chunk);
    expect(result).toContain('"content":[]');
    expect(result).toContain('"message":{}');
    expect(result).toContain('"delta":{}');
    expect(result).not.toContain(":null");
  });

  it("handles whitespace variations around null", () => {
    const chunk = 'data: {"content" : null , "message":  null}\n\n';
    const result = sanitizeSSEChunk(chunk);
    expect(result).toContain('"content":[]');
    expect(result).toContain('"message":{}');
  });

  it("does not corrupt unrelated fields containing 'null' substring", () => {
    const chunk = 'data: {"type":"text_delta","text":"nullable value is nullish"}\n\n';
    const result = sanitizeSSEChunk(chunk);
    expect(result).toBe(chunk); // no :null pattern in JSON value positions
  });

  it("fast-paths chunks without :null substring (zero allocation)", () => {
    const chunk = 'data: {"type":"ping"}\n\n';
    expect(sanitizeSSEChunk(chunk)).toBe(chunk);
  });

  it("handles real SSE event: message_start with null content", () => {
    const chunk = `event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":null,"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null}}

`;
    const result = sanitizeSSEChunk(chunk);
    expect(result).toContain('"content":[]');
    // stop_reason:null and stop_sequence:null should NOT be replaced (not in our regex)
    expect(result).toContain('"stop_reason":null');
  });
});
