import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { OpenAIResponsesAdapter } from "../../src/adapters/openai-responses.js";

function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: string[] = [];
    stream.on("data", (chunk: Buffer | string) => parts.push(typeof chunk === "string" ? chunk : chunk.toString()));
    stream.on("end", () => resolve(parts.join("")));
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
