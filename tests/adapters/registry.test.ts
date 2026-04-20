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
