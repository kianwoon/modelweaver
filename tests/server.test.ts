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

  it("returns actual provider error status when all providers fail", async () => {
    mock.setBehavior("error-500");
    const config = makeConfig({
      providers: new Map([
        ["mock", { name: "mock", baseUrl: mock.url, apiKey: "sk-test", timeout: 5000 }],
      ]),
      routing: new Map([
        ["sonnet", [
          { provider: "mock" },
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

    // When all providers are exhausted, the last real error response is returned (500)
    expect(res.status).toBe(500);
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

  // 10s timeout: two sequential provider requests with 5s timeout each can exceed default on slow CI
  it("falls back to second provider when first returns 429", async () => {
    const mock2 = createMockProvider();
    mock.setBehavior("error-429");

    const config = makeConfig({
      providers: new Map([
        ["mock", { name: "mock", baseUrl: mock.url, apiKey: "sk-test", timeout: 5000 }],
        ["mock2", { name: "mock2", baseUrl: mock2.url, apiKey: "sk-test", timeout: 5000 }],
      ]),
      routing: new Map([
        ["sonnet", [
          { provider: "mock" },
          { provider: "mock2" },
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

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Hello from mock provider");
    await mock2.close();
  }, 10_000);

  it("fails immediately on non-retriable error (401) without trying fallback", async () => {
    const mock2 = createMockProvider();
    mock.setBehavior("error-401");

    const config = makeConfig({
      providers: new Map([
        ["mock", { name: "mock", baseUrl: mock.url, apiKey: "sk-test", timeout: 5000 }],
        ["mock2", { name: "mock2", baseUrl: mock2.url, apiKey: "sk-test", timeout: 5000 }],
      ]),
      routing: new Map([
        ["sonnet", [
          { provider: "mock" },
          { provider: "mock2" },
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

    expect(res.status).toBe(401);
    await mock2.close();
  });
});
