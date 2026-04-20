import { describe, it, expect } from "vitest";
import { OpenAIResponsesAdapter } from "../../src/adapters/openai-responses.js";

describe("OpenAIResponsesAdapter", () => {
  describe("transformRequest", () => {
    it("transforms body to Responses API format", () => {
      const adapter = new OpenAIResponsesAdapter();
      const result = adapter.transformRequest(
        JSON.stringify({
          model: "gpt-4",
          max_tokens: 1024,
          system: "Be helpful.",
          messages: [{ role: "user", content: "Hi" }],
          thinking: { type: "enabled", budget_tokens: 8000 },
          stream: true,
        }),
        {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
      );
      const parsed = JSON.parse(result.body);
      expect(parsed.model).toBe("gpt-4");
      expect(parsed.max_output_tokens).toBe(1024);
      expect(parsed.instructions).toBe("Be helpful.");
      expect(parsed.input[0].role).toBe("user");
      expect(parsed.reasoning.max_tokens).toBe(8000);
      expect(result.headers["anthropic-version"]).toBeUndefined();
      expect(result.headers["authorization"]).toBe("Bearer test-key");
    });
  });

  describe("buildUpstreamUrl", () => {
    it("replaces path with /v1/responses", () => {
      const adapter = new OpenAIResponsesAdapter();
      expect(
        adapter.buildUpstreamUrl("https://api.openai.com", "/v1/messages", "gpt-4"),
      ).toBe("https://api.openai.com/v1/responses");
    });
    it("deduplicates /v1", () => {
      const adapter = new OpenAIResponsesAdapter();
      expect(
        adapter.buildUpstreamUrl("https://api.openai.com/v1", "/v1/messages", "gpt-4"),
      ).toBe("https://api.openai.com/v1/responses");
    });
  });

  describe("transformError", () => {
    it("normalizes errors", () => {
      const adapter = new OpenAIResponsesAdapter();
      const result = adapter.transformError(
        500,
        JSON.stringify({ error: { message: "Server error", type: "server_error" } }),
      );
      expect(result).toEqual({ type: "api_error", message: "Server error" });
    });
  });
});
