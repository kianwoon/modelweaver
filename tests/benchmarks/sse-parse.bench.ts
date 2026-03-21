import { describe, bench } from "vitest";

// ---------------------------------------------------------------------------
// Helpers: generate realistic SSE chunks
// ---------------------------------------------------------------------------

/** A single content_block_delta event (Anthropic format) */
const CONTENT_EVENT = `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello, world"}}`;

/** A message_stop event with usage (Anthropic format) */
function makeUsageEvent(inputTokens: number, outputTokens: number): string {
  return `event: message_stop
data: {"type":"message_stop","message":{"usage":{"input_tokens":${inputTokens},"output_tokens":${outputTokens}}}}`;
}

/** A ping/keepalive event */
const PING_EVENT = `event: ping
data: {"type":"ping"}`;

/** An OpenAI-style chunk with usage */
function makeOpenAIUsageEvent(promptTokens: number, completionTokens: number): string {
  return `data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":${promptTokens},"completion_tokens":${completionTokens}}}`;
}

/**
 * Build a realistic SSE stream as a single string (concatenation of chunks).
 * Includes content events, pings, and a usage event at the end.
 */
function generateSSEStream(numContentEvents: number, hasAnthropicUsage = true, hasOpenAIUsage = false): string {
  const parts: string[] = [];
  for (let i = 0; i < numContentEvents; i++) {
    parts.push(CONTENT_EVENT);
    // Mix in a ping every 10 events
    if (i > 0 && i % 10 === 0) {
      parts.push(PING_EVENT);
    }
  }
  if (hasAnthropicUsage) {
    parts.push(makeUsageEvent(1024, 512));
  }
  if (hasOpenAIUsage) {
    parts.push(makeOpenAIUsageEvent(1024, 512));
  }
  // SSE spec: events are separated by blank lines (\n\n)
  return parts.join("\n\n") + "\n\n";
}

// Pre-generate fixture data for benchmarks
const smallStream = generateSSEStream(20);
const mediumStream = generateSSEStream(200);
const largeStream = generateSSEStream(2000);
const noUsageStream = generateSSEStream(200, false, false);

// ---------------------------------------------------------------------------
// Core parseUsageFromData logic (inlined since it's private in server.ts)
// ---------------------------------------------------------------------------

function parseUsageFromData(data: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const usage = (data.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined
    ?? data.usage as Record<string, unknown> | undefined;
  if (!usage) return { inputTokens: 0, outputTokens: 0 };

  const inp = (usage.input_tokens as number | undefined) ?? (usage.prompt_tokens as number | undefined) ?? 0;
  const out = (usage.output_tokens as number | undefined) ?? (usage.completion_tokens as number | undefined) ?? 0;
  const cacheRead = (usage.cache_read_input_tokens as number | undefined) ?? 0;
  const cacheCreation = (usage.cache_creation_input_tokens as number | undefined) ?? 0;

  return { inputTokens: inp + cacheRead + cacheCreation, outputTokens: out };
}

// ---------------------------------------------------------------------------
// Full SSE parsing pipeline (mirrors extractTokensAsync's inner loop)
// ---------------------------------------------------------------------------

function parseSSEStream(sseText: string): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;

  for (const event of sseText.split("\n\n")) {
    const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    try {
      const data = JSON.parse(dataLine.slice(5)) as Record<string, unknown>;
      const usage = parseUsageFromData(data);
      if (usage.inputTokens > inputTokens) inputTokens = usage.inputTokens;
      if (usage.outputTokens > outputTokens) outputTokens = usage.outputTokens;
    } catch {
      /* skip malformed */
    }
  }

  return { inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("SSE parsing benchmarks", () => {
  // --- parseUsageFromData ---

  describe("parseUsageFromData", () => {
    const anthropicData = {
      type: "message_stop",
      message: { usage: { input_tokens: 1024, output_tokens: 512, cache_read_input_tokens: 128, cache_creation_input_tokens: 64 } },
    };
    const openAIData = {
      id: "chatcmpl-abc",
      usage: { prompt_tokens: 2048, completion_tokens: 256 },
    };
    const noUsageData = { type: "ping" };

    bench("Anthropic format with cache tokens", () => {
      parseUsageFromData(anthropicData as Record<string, unknown>);
    });

    bench("OpenAI format", () => {
      parseUsageFromData(openAIData as Record<string, unknown>);
    });

    bench("No usage field (early return)", () => {
      parseUsageFromData(noUsageData as Record<string, unknown>);
    });
  });

  // --- Short-circuit: includes("usage") vs full JSON.parse ---

  describe("short-circuit: includes vs JSON.parse", () => {
    const dataLineWithUsage = `data: {"type":"message_stop","message":{"usage":{"input_tokens":1024,"output_tokens":512}}}`;
    const dataLineNoUsage = `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`;

    bench("includes('usage') on usage line", () => {
      dataLineWithUsage.includes("usage");
    });

    bench("includes('usage') on non-usage line", () => {
      dataLineNoUsage.includes("usage");
    });

    bench("JSON.parse on usage line", () => {
      JSON.parse(dataLineWithUsage.slice(5));
    });

    bench("JSON.parse on non-usage line (with try/catch)", () => {
      try {
        JSON.parse(dataLineNoUsage.slice(5));
      } catch {
        // expected
      }
    });
  });

  // --- Line processing patterns ---

  describe("line processing: join-split vs direct split", () => {
    const lines = smallStream.split("\n");
    const fullText = smallStream;

    bench("lines.join('\\n').split('\\n\\n') pattern (current)", () => {
      for (const event of lines.join("\n").split("\n\n")) {
        const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          JSON.parse(dataLine.slice(5));
        } catch {
          // skip
        }
      }
    });

    bench("Direct fullText.split('\\n\\n') (alternative)", () => {
      for (const event of fullText.split("\n\n")) {
        const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          JSON.parse(dataLine.slice(5));
        } catch {
          // skip
        }
      }
    });
  });

  // --- Full SSE stream parsing at different sizes ---

  describe("full SSE stream parsing", () => {
    bench("small stream (20 events)", () => {
      parseSSEStream(smallStream);
    });

    bench("medium stream (200 events)", () => {
      parseSSEStream(mediumStream);
    });

    bench("large stream (2000 events)", () => {
      parseSSEStream(largeStream);
    });

    bench("medium stream with no usage data", () => {
      parseSSEStream(noUsageStream);
    });
  });
});
