import { describe, it, expect } from "vitest";
import {
  mapAnthropicToOpenAIChat,
  mapAnthropicToOpenAIResponses,
  mapOpenAIErrorToAnthropic,
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
    const assistantMsg = result.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0].id).toBe("call_1");
    expect(assistantMsg.tool_calls[0].function.name).toBe("get_weather");
    expect(assistantMsg.tool_calls[0].function.arguments).toBe(JSON.stringify({ city: "SF" }));
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

  it("maps tool_choice auto", () => {
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

  it("maps metadata.user_id to user field", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      metadata: { user_id: "user-123" },
      stream: true,
    });
    const result = JSON.parse(mapAnthropicToOpenAIChat(input));
    expect(result.user).toBe("user-123");
  });

  it("maps image with url source", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
          ],
        },
      ],
      stream: true,
    });
    const result = JSON.parse(mapAnthropicToOpenAIChat(input));
    const content = result.messages[0].content;
    expect(content[0].type).toBe("image_url");
    expect(content[0].image_url.url).toBe("https://example.com/image.png");
  });

  it("maps system array to system message", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      system: [
        { type: "text", text: "You are helpful." },
        { type: "text", text: "Be concise." },
      ],
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });
    const result = JSON.parse(mapAnthropicToOpenAIChat(input));
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("You are helpful.");
    expect(result.messages[0].content).toContain("Be concise.");
  });
});

describe("mapAnthropicToOpenAIResponses", () => {
  it("maps max_tokens to max_output_tokens", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    });
    const result = JSON.parse(mapAnthropicToOpenAIResponses(input));
    expect(result.max_output_tokens).toBe(1024);
  });

  it("maps system to instructions", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
    });
    const result = JSON.parse(mapAnthropicToOpenAIResponses(input));
    expect(result.instructions).toBe("You are helpful.");
  });

  it("maps messages to input", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    });
    const result = JSON.parse(mapAnthropicToOpenAIResponses(input));
    expect(result.input).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("maps thinking to reasoning", () => {
    const input = JSON.stringify({
      model: "gpt-4",
      max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 5000 },
      messages: [{ role: "user", content: "Hello" }],
    });
    const result = JSON.parse(mapAnthropicToOpenAIResponses(input));
    expect(result.reasoning).toEqual({ max_tokens: 5000 });
  });
});

describe("mapOpenAIErrorToAnthropic", () => {
  it("maps OpenAI error to Anthropic format", () => {
    const result = JSON.parse(mapOpenAIErrorToAnthropic(429, JSON.stringify({
      error: { message: "Rate limit exceeded", type: "rate_limit_error", code: "rate_limit_exceeded" },
    })));
    expect(result).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "Rate limit exceeded" },
    });
  });

  it("maps 400 to invalid_request_error", () => {
    const result = JSON.parse(mapOpenAIErrorToAnthropic(400, JSON.stringify({
      error: { message: "Invalid request", type: "invalid_request_error" },
    })));
    expect(result.error.type).toBe("invalid_request_error");
  });

  it("maps 401 to authentication_error", () => {
    const result = JSON.parse(mapOpenAIErrorToAnthropic(401, JSON.stringify({
      error: { message: "Invalid API key", type: "invalid_request_error" },
    })));
    expect(result.error.type).toBe("authentication_error");
  });

  it("maps 500 to api_error", () => {
    const result = JSON.parse(mapOpenAIErrorToAnthropic(500, JSON.stringify({
      error: { message: "Internal server error", type: "server_error" },
    })));
    expect(result.error.type).toBe("api_error");
  });

  it("maps 503 to overloaded_error", () => {
    const result = JSON.parse(mapOpenAIErrorToAnthropic(503, JSON.stringify({
      error: { message: "Service unavailable", type: "server_error" },
    })));
    expect(result.error.type).toBe("overloaded_error");
  });

  it("handles unparseable body", () => {
    const result = JSON.parse(mapOpenAIErrorToAnthropic(500, "Internal Server Error"));
    expect(result).toEqual({
      type: "error",
      error: { type: "api_error", message: "Internal Server Error" },
    });
  });

  it("handles empty body", () => {
    const result = JSON.parse(mapOpenAIErrorToAnthropic(500, ""));
    expect(result).toEqual({
      type: "error",
      error: { type: "api_error", message: "Unknown error" },
    });
  });
});
