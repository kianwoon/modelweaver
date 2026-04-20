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
  it("translates basic text streaming response", async () => {
    const adapter = new OpenAIChatAdapter();
    const openaiSSE = [
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }),
      "data: [DONE]\n\n",
    ].join("");

    const source = Readable.from([openaiSSE]);
    const result = adapter.transformResponse(source);
    const output = await collectStream(result);

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
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "Let me check." }, finish_reason: null }],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"city"' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ':"SF"}' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
      "data: [DONE]\n\n",
    ].join("");

    const source = Readable.from([openaiSSE]);
    const result = adapter.transformResponse(source);
    const output = await collectStream(result);

    expect(output).toContain('"type":"text"');
    expect(output).toContain('"type":"tool_use"');
    expect(output).toContain('"name":"get_weather"');
    expect(output).toContain("input_json_delta");
    expect(output).toContain('"stop_reason":"tool_use"');
    expect(output).toContain("event: message_stop");
  });

  it("handles stream ending without [DONE] (flush fallback)", async () => {
    const adapter = new OpenAIChatAdapter();
    const openaiSSE = [
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
      }),
      // No [DONE] and no finish_reason — stream just ends
    ].join("");

    const source = Readable.from([openaiSSE]);
    const result = adapter.transformResponse(source);
    const output = await collectStream(result);

    expect(output).toContain("event: message_start");
    expect(output).toContain("event: content_block_delta");
    expect(output).toContain('"text":"Hi"');
    expect(output).toContain("event: message_stop");
  });

  it("translates reasoning_content as thinking blocks", async () => {
    const adapter = new OpenAIChatAdapter();
    const openaiSSE = [
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { reasoning_content: "Let me think..." }, finish_reason: null }],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "The answer is 42." }, finish_reason: null }],
      }),
      openAIChunk({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      }),
      "data: [DONE]\n\n",
    ].join("");

    const source = Readable.from([openaiSSE]);
    const result = adapter.transformResponse(source);
    const output = await collectStream(result);

    // Should have thinking block then text block
    expect(output).toContain("thinking_delta");
    expect(output).toContain('"thinking":"Let me think..."');
    expect(output).toContain('"type":"thinking"');
    expect(output).toContain('"type":"text"');
    expect(output).toContain('"text":"The answer is 42."');
    expect(output).toContain("event: message_stop");
  });
});
