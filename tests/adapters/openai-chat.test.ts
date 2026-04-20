import { describe, it, expect } from "vitest";
import { OpenAIChatAdapter } from "../../src/adapters/openai-chat.js";

describe("OpenAIChatAdapter", () => {
  describe("transformRequest", () => {
    it("transforms body and removes Anthropic headers", () => {
      const adapter = new OpenAIChatAdapter();
      const result = adapter.transformRequest(
        JSON.stringify({
          model: "gpt-4",
          max_tokens: 1024,
          system: "Be helpful.",
          messages: [{ role: "user", content: "Hi" }],
          stream: true,
        }),
        {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
      );
      const parsed = JSON.parse(result.body);
      expect(parsed.model).toBe("gpt-4");
      expect(parsed.messages[0].role).toBe("system");
      expect(parsed.messages[1].role).toBe("user");
      expect(result.headers["anthropic-version"]).toBeUndefined();
      expect(result.headers["anthropic-beta"]).toBeUndefined();
      expect(result.headers["x-api-key"]).toBeUndefined();
      expect(result.headers["authorization"]).toBe("Bearer test-key");
    });

    it("preserves non-Anthropic headers", () => {
      const adapter = new OpenAIChatAdapter();
      const result = adapter.transformRequest("{}", {
        "content-type": "application/json",
        "x-request-id": "req-123",
      });
      expect(result.headers["content-type"]).toBe("application/json");
      expect(result.headers["x-request-id"]).toBe("req-123");
    });
  });

  describe("buildUpstreamUrl", () => {
    it("appends /v1/chat/completions to base URL", () => {
      const adapter = new OpenAIChatAdapter();
      expect(
        adapter.buildUpstreamUrl("https://openrouter.ai/api", "/v1/messages", "gpt-4"),
      ).toBe("https://openrouter.ai/api/v1/chat/completions");
    });

    it("deduplicates /v1 if baseUrl already has it", () => {
      const adapter = new OpenAIChatAdapter();
      expect(
        adapter.buildUpstreamUrl("https://api.openai.com/v1", "/v1/messages", "gpt-4"),
      ).toBe("https://api.openai.com/v1/chat/completions");
    });
  });

  describe("transformError", () => {
    it("normalizes OpenAI errors", () => {
      const adapter = new OpenAIChatAdapter();
      const result = adapter.transformError(
        429,
        JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error" } }),
      );
      expect(result).toEqual({ type: "rate_limit_error", message: "Rate limited" });
    });
  });
});
