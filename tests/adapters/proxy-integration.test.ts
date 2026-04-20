import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { forwardRequest } from "../../src/proxy.js";
import type { ProviderConfig, RoutingEntry, RequestContext } from "../../src/types.js";

function createMockOpenAIProvider() {
  const app = new Hono();
  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json();
    // Verify the request was transformed to OpenAI format
    if (!body.messages || !Array.isArray(body.messages)) {
      return c.json({ error: { message: "Invalid request: expected messages array" } }, 400);
    }
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

    const incomingRequest = new Request(new URL("http://localhost/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        max_tokens: 1024,
        system: "Be helpful.",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });

    const response = await forwardRequest(provider, { provider: "openai-mock", model: "gpt-4" } as RoutingEntry, ctx, incomingRequest);
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
