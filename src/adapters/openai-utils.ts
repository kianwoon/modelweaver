import { Transform } from "node:stream";

/**
 * OpenAI shared utilities for request mapping and error normalization.
 * Used by both OpenAI Chat and Responses API adapters.
 */

interface ContentBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  cache_control?: unknown;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
  cache_control?: unknown;
}

interface AnthropicMessage {
  role: string;
  content: string | ContentBlock[];
  cache_control?: unknown;
}

/**
 * Deep-strip all `cache_control` keys from an object (recursively).
 */
function stripCacheControl(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(stripCacheControl);
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k !== "cache_control") {
        out[k] = stripCacheControl(v);
      }
    }
    return out;
  }
  return obj;
}

/**
 * Map a single Anthropic content block to OpenAI Chat format.
 */
function mapContentBlockToChat(block: ContentBlock): unknown {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }

  if (block.type === "image" && block.source) {
    if (block.source.type === "base64") {
      return {
        type: "image_url",
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      };
    }
    if (block.source.type === "url") {
      return {
        type: "image_url",
        image_url: { url: block.source.url },
      };
    }
  }

  // Pass through other blocks as-is
  return block;
}

/**
 * Map Anthropic message content (string or content blocks) to OpenAI Chat format.
 * Returns mapped content + any extra messages to insert (e.g., tool result messages).
 */
function mapAnthropicMessageToChat(
  msg: AnthropicMessage,
): { content: string | unknown[] | null; extraMessages?: unknown[]; skipOriginal?: boolean; tool_calls?: unknown[] } {
  // Simple string content
  if (typeof msg.content === "string") {
    return { content: msg.content };
  }

  const content = msg.content as ContentBlock[];

  // For assistant messages with tool_use blocks, restructure into tool_calls
  if (msg.role === "assistant") {
    const textParts: string[] = [];
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];

    for (const block of content) {
      if (block.type === "text") {
        textParts.push(block.text ?? "");
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id ?? "",
          type: "function" as const,
          function: {
            name: block.name ?? "",
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
      // Note: thinking blocks are ignored for OpenAI format - they're Anthropic-specific
    }

    if (toolCalls.length > 0) {
      return {
        content: textParts.length > 0 ? textParts.join("") : null,
        tool_calls: toolCalls,
      };
    }

    // Assistant messages with only text (no tool_calls) - flatten to string
    if (textParts.length > 0) {
      return { content: textParts.join("") };
    }
  }

  // For user messages with tool_result blocks, extract into separate tool messages
  if (msg.role === "user") {
    const toolResults = content.filter((b) => b.type === "tool_result");
    if (toolResults.length > 0) {
      const nonToolContent = content.filter((b) => b.type !== "tool_result");
      const mappedNonTool = nonToolContent.map(mapContentBlockToChat);
      const extraMessages = toolResults.map((tr) => ({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content:
          typeof tr.content === "string"
            ? tr.content
            : Array.isArray(tr.content)
              ? JSON.stringify(tr.content)
              : "",
      }));

      // If only tool_results, skip the original user message entirely
      if (nonToolContent.length === 0) {
        return { content: null, skipOriginal: true, extraMessages };
      }

      // Flatten all text blocks into a single string
      const allText = mappedNonTool.every(
        (m) => typeof m === "string" || (m && typeof m === "object" && (m as { type?: string }).type === "text"),
      );
      const finalContent = allText
        ? mappedNonTool
            .map((m) => (typeof m === "string" ? m : (m as { text?: string }).text ?? ""))
            .filter(Boolean)
            .join("\n")
        : mappedNonTool;

      return {
        content: finalContent,
        extraMessages,
      };
    }
  }

  // General case: map each content block
  const mapped = content.map(mapContentBlockToChat);

  // Flatten all text blocks into a single string — many OpenAI-compatible providers
  // (Z.AI, etc.) do not accept content arrays, only plain strings.
  const allText = mapped.every(
    (m) => typeof m === "string" || (m && typeof m === "object" && (m as { type?: string }).type === "text"),
  );
  if (allText) {
    const joined = mapped
      .map((m) => (typeof m === "string" ? m : (m as { text?: string }).text ?? ""))
      .filter(Boolean)
      .join("\n");
    return { content: joined };
  }

  return { content: mapped };
}

/**
 * Translates an Anthropic-format request body to OpenAI Chat Completions format.
 */
export function mapAnthropicToOpenAIChat(anthropicBody: string): string {
  const parsed = JSON.parse(anthropicBody);
  const result: Record<string, unknown> = {};

  // Direct passthrough fields
  if (parsed.model !== undefined) result.model = parsed.model;
  if (parsed.max_tokens !== undefined) result.max_tokens = parsed.max_tokens;
  if (parsed.stream !== undefined) result.stream = parsed.stream;
  if (parsed.temperature !== undefined) result.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) result.top_p = parsed.top_p;
  if (parsed.stop_sequences !== undefined) result.stop = parsed.stop_sequences;
  if (parsed.stop !== undefined) result.stop = parsed.stop;

  // metadata.user_id → user
  if (parsed.metadata?.user_id !== undefined) {
    result.user = parsed.metadata.user_id;
  }

  // system → prepend system message(s)
  const messages: unknown[] = [];
  if (parsed.system !== undefined) {
    if (typeof parsed.system === "string") {
      messages.push({ role: "system", content: parsed.system });
    } else if (Array.isArray(parsed.system)) {
      const textParts = parsed.system
        .filter((b: ContentBlock) => b.type === "text")
        .map((b: ContentBlock) => b.text);
      if (textParts.length > 0) {
        messages.push({ role: "system", content: textParts.join("\n") });
      }
    }
  }

  // messages[] → messages[] with content mapping
  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      const mapped = mapAnthropicMessageToChat(msg);

      // Skip the original message if it only contained tool_results (already extracted)
      if (mapped.skipOriginal) {
        if (mapped.extraMessages) {
          for (const extra of mapped.extraMessages) {
            messages.push(extra);
          }
        }
        continue;
      }

      const message: Record<string, unknown> = { role: msg.role, content: mapped.content };

      // Carry over tool_calls if present (from assistant tool_use mapping)
      if (mapped.tool_calls) {
        message.tool_calls = mapped.tool_calls;
      }

      messages.push(message);

      // Insert extra messages (e.g., tool result messages)
      if (mapped.extraMessages) {
        for (const extra of mapped.extraMessages) {
          messages.push(extra);
        }
      }
    }
  }

  result.messages = messages;

  // tools[] mapping
  if (Array.isArray(parsed.tools)) {
    result.tools = parsed.tools.map((tool: AnthropicTool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema,
      },
    }));
  }

  // tool_choice mapping
  if (parsed.tool_choice !== undefined) {
    if (parsed.tool_choice.type === "auto") {
      result.tool_choice = "auto";
    } else if (parsed.tool_choice.type === "any") {
      result.tool_choice = "required";
    } else if (parsed.tool_choice.type === "tool") {
      result.tool_choice = {
        type: "function",
        function: { name: parsed.tool_choice.name },
      };
    } else {
      result.tool_choice = parsed.tool_choice;
    }
  }

  // Deep strip cache_control
  const cleaned = stripCacheControl(result) as Record<string, unknown>;
  return JSON.stringify(cleaned);
}

/**
 * Translates an Anthropic-format request body to OpenAI Responses API format.
 */
export function mapAnthropicToOpenAIResponses(anthropicBody: string): string {
  const parsed = JSON.parse(anthropicBody);
  const result: Record<string, unknown> = {};

  // Direct fields
  if (parsed.model !== undefined) result.model = parsed.model;
  if (parsed.stream !== undefined) result.stream = parsed.stream;

  // max_tokens → max_output_tokens
  if (parsed.max_tokens !== undefined) {
    result.max_output_tokens = parsed.max_tokens;
  }

  // system → instructions (top-level string)
  if (parsed.system !== undefined) {
    if (typeof parsed.system === "string") {
      result.instructions = parsed.system;
    } else if (Array.isArray(parsed.system)) {
      const textParts = parsed.system
        .filter((b: ContentBlock) => b.type === "text")
        .map((b: ContentBlock) => b.text);
      result.instructions = textParts.join("\n");
    }
  }

  // messages[] → input[]
  if (Array.isArray(parsed.messages)) {
    result.input = parsed.messages;
  }

  // thinking{type:"enabled",budget_tokens} → reasoning{max_tokens}
  if (parsed.thinking?.type === "enabled" && parsed.thinking.budget_tokens !== undefined) {
    result.reasoning = { max_tokens: parsed.thinking.budget_tokens };
  }

  // Deep strip cache_control
  const cleaned = stripCacheControl(result);
  return JSON.stringify(cleaned);
}

/** Map HTTP status codes to Anthropic error types. */
function statusToErrorType(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 429:
      return "rate_limit_error";
    case 500:
      return "api_error";
    case 503:
      return "overloaded_error";
    default:
      return "api_error";
  }
}

/**
 * Normalizes an OpenAI error response to Anthropic error format.
 */
export function mapOpenAIErrorToAnthropic(status: number, body: string): string {
  let message: string;
  let errorType: string;

  try {
    const parsed = JSON.parse(body);
    if (parsed.error?.message) {
      message = parsed.error.message;
    } else {
      message = body || "Unknown error";
    }
    errorType = statusToErrorType(status);
  } catch {
    message = body || "Unknown error";
    errorType = statusToErrorType(status);
  }

  return JSON.stringify({
    type: "error",
    error: { type: errorType, message },
  });
}

/**
 * Creates a Node.js Transform stream that converts OpenAI Chat SSE format to Anthropic SSE format.
 *
 * Handles:
 * - message_start/content_block_start initialization
 * - text_delta, thinking_delta, input_json_delta content streaming
 * - content_block_stop for switching between block types
 * - message_delta/message_stop on [DONE]
 * - Multiple tool calls with proper block index tracking
 * - Flush fallback for incomplete streams
 */
export function createOpenAIChatToAnthropicStream() {
  let messageId = "msg_" + Math.random().toString(36).substring(2, 15);
  let model = "model";
  let inputTokens = 0;
  let outputTokens = 0;

  let started = false;
  let closed = false;
  let currentBlockType: "text" | "thinking" | null = null;
  let currentBlockIndex = 0;
  let hasToolCalls = false;

  // Track tool calls by OpenAI index → block index mapping
  const toolBlockIndices = new Map<number, number>();

  type PushFn = (data: string) => boolean;

  function emitMessageStart(push: PushFn) {
    if (!started) {
      push(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        })}\n\n`,
      );
      started = true;
    }
  }

  function closeBlock(push: PushFn, index: number) {
    push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`);
  }

  function closeCurrentBlock(push: PushFn) {
    if (currentBlockType !== null) {
      closeBlock(push, currentBlockIndex);
      currentBlockIndex++;
      currentBlockType = null;
    }
  }

  function mapFinishReason(reason: string): string {
    switch (reason) {
      case "tool_calls":
        return "tool_use";
      case "stop":
        return "end_turn";
      case "length":
        return "max_tokens";
      case "content_filter":
        return "end_turn";
      default:
        return "end_turn";
    }
  }

  function emitClosingEvents(push: PushFn, finishReason?: string) {
    if (closed) return;
    closed = true;

    // Close any open text/thinking block
    closeCurrentBlock(push);

    // Close all open tool blocks
    for (const [_tcIndex, blockIdx] of toolBlockIndices) {
      closeBlock(push, blockIdx);
    }
    toolBlockIndices.clear();

    // Determine stop_reason: prefer explicit finish_reason, fall back to tool call presence
    const stopReason = finishReason
      ? mapFinishReason(finishReason)
      : (hasToolCalls ? "tool_use" : "end_turn");

    push(
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens, input_tokens: inputTokens },
      })}\n\n`,
    );
    push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  }

  function processChunk(parsed: any, push: PushFn) {
    if (parsed.id) messageId = `msg_${parsed.id}`;
    if (parsed.model) model = parsed.model;

    if (parsed.usage) {
      if (parsed.usage.prompt_tokens) inputTokens = parsed.usage.prompt_tokens;
      if (parsed.usage.completion_tokens) outputTokens = parsed.usage.completion_tokens;
    }

    const choice = parsed.choices?.[0];
    if (!choice) return;

    emitMessageStart(push);
    const delta = choice.delta;

    // Handle reasoning_content -> thinking block
    if (delta?.reasoning_content) {
      // Close text block if we're transitioning from text to thinking
      if (currentBlockType === "text") {
        closeCurrentBlock(push);
      }
      if (currentBlockType !== "thinking") {
        currentBlockType = "thinking";
        push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: currentBlockIndex,
            content_block: { type: "thinking", thinking: "" },
          })}\n\n`,
        );
      }
      push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: currentBlockIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        })}\n\n`,
      );
      return;
    }

    // Handle text content
    if (delta?.content) {
      // Close thinking block if we're transitioning from thinking to text
      if (currentBlockType === "thinking") {
        closeCurrentBlock(push);
      }
      if (currentBlockType !== "text") {
        currentBlockType = "text";
        push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: currentBlockIndex,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );
      }
      push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: currentBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        })}\n\n`,
      );
      return;
    }

    // Handle tool_calls
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0;

        // New tool call with id — start a new content block
        if (tc.id) {
          hasToolCalls = true;
          // Close any open text/thinking block
          closeCurrentBlock(push);

          const blockIdx = currentBlockIndex;
          toolBlockIndices.set(tcIndex, blockIdx);

          push(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: blockIdx,
              content_block: { type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input: {} },
            })}\n\n`,
          );

          currentBlockIndex++;
        }

        // Stream argument deltas using the correct block index for this tool call
        if (tc.function?.arguments) {
          const blockIdx = toolBlockIndices.get(tcIndex);
          if (blockIdx !== undefined) {
            push(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: blockIdx,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              })}\n\n`,
            );
          }
        }
      }
      return;
    }

    // Note: We do NOT close blocks on finish_reason.
    // Block closing is handled at [DONE] to avoid premature closes
    // with providers that send finish_reason on every chunk.
    // We just capture the finish_reason for stop_reason mapping.
  }

  // Buffer for incomplete lines across chunks
  let lineBuffer = "";

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      console.warn(`[openai-transform] Received chunk: ${chunk.toString().slice(0, 200)}`);
      const text = lineBuffer + chunk.toString();
      const lines = text.split("\n");
      // Last element might be incomplete — save for next chunk
      lineBuffer = lines.pop() ?? "";

      const push = this.push.bind(this);
      const debugPush: PushFn = (data: string) => {
        console.warn(`[openai-push] ${data.slice(0, 150)}`);
        return push(data);
      };
      let lastFinishReason: string | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        // Handle both "data: ..." and "data:..." (with/without space)
        const data = trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed.slice(5).trim();
        if (data === "[DONE]") {
          emitMessageStart(debugPush);
          emitClosingEvents(debugPush, lastFinishReason ?? undefined);
          callback();
          return;
        }

        try {
          const parsed = JSON.parse(data);
          // Capture finish_reason from the chunk for stop_reason mapping
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) {
            lastFinishReason = choice.finish_reason;
          }
          processChunk(parsed, debugPush);
        } catch {
          // Skip invalid JSON — likely a partial chunk that spans boundaries
          // (handled by lineBuffer on next chunk)
        }
      }
      callback();
    },

    flush(callback: () => void) {
      const push = this.push.bind(this);
      emitMessageStart(push);
      emitClosingEvents(push);
      callback();
    },
  });
}

/**
 * Converts a non-streaming OpenAI Chat Completions JSON response to Anthropic SSE format.
 * Used when the upstream returns application/json instead of text/event-stream.
 */
export function mapOpenAIChatJsonToAnthropicSSE(body: string): string {
  const parsed = JSON.parse(body);
  const messageId = `msg_${parsed.id ?? Math.random().toString(36).substring(2, 15)}`;
  const model = parsed.model ?? "model";
  const choice = parsed.choices?.[0];
  const message = choice?.message;
  const finishReason = choice?.finish_reason;
  const usage = parsed.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;

  const events: string[] = [];

  // message_start
  events.push(`event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: messageId, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  })}\n\n`);

  let blockIndex = 0;

  // Text content
  if (message?.content) {
    events.push(`event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start", index: blockIndex,
      content_block: { type: "text", text: "" },
    })}\n\n`);
    events.push(`event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta", index: blockIndex,
      delta: { type: "text_delta", text: message.content },
    })}\n\n`);
    events.push(`event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop", index: blockIndex,
    })}\n\n`);
    blockIndex++;
  }

  // Tool calls
  if (message?.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      let input: unknown = {};
      try { input = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* keep empty */ }
      events.push(`event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start", index: blockIndex,
        content_block: { type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input: {} },
      })}\n\n`);
      events.push(`event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta", index: blockIndex,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      })}\n\n`);
      events.push(`event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop", index: blockIndex,
      })}\n\n`);
      blockIndex++;
    }
  }

  // message_delta + message_stop
  const stopReason = message?.tool_calls?.length ? "tool_use"
    : finishReason === "length" ? "max_tokens" : "end_turn";
  events.push(`event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens, input_tokens: inputTokens },
  })}\n\n`);
  events.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);

  return events.join("");
}

/**
 * Creates a Node.js Transform stream that converts OpenAI Responses API SSE format
 * to Anthropic SSE format.
 *
 * Responses API events mapped:
 * - response.created (status: "in_progress") → message_start
 * - response.content_part.added (type: "output_text") → content_block_start(type: "text")
 * - response.output_text.delta → content_block_delta(text_delta)
 * - response.function_call_arguments.delta → content_block_delta(input_json_delta)
 * - response.output_item.done → content_block_stop
 * - response.completed (has usage) → message_delta (usage) + message_stop
 */
export function createOpenAIResponsesToAnthropicStream() {
  let messageId = "msg_" + Math.random().toString(36).substring(2, 15);
  let inputTokens = 0;
  let outputTokens = 0;
  let blockIndex = 0;

  let started = false;
  let closed = false;
  let blockOpen = false;

  type PushFn = (data: string) => boolean;

  function emitMessageStart(push: PushFn) {
    if (!started) {
      push(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [],
            stop_reason: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        })}\n\n`,
      );
      started = true;
    }
  }

  function closeBlock(push: PushFn) {
    if (blockOpen) {
      push(
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`,
      );
      blockOpen = false;
      blockIndex++;
    }
  }

  function emitClosingEvents(push: PushFn, stopReason = "end_turn") {
    if (closed) return;
    closed = true;
    closeBlock(push);
    push(
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      })}\n\n`,
    );
    push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  }

  // Buffer for incomplete lines across chunks
  let lineBuffer = "";

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      const text = lineBuffer + chunk.toString();
      const lines = text.split("\n");
      // Last element might be incomplete — save for next chunk
      lineBuffer = lines.pop() ?? "";

      const push = this.push.bind(this);

      let currentEvent = "";
      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7).trim();
          continue;
        }

        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6).trim();

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        // Track message id from response.created or response.completed
        if (parsed.id && (currentEvent === "response.created" || currentEvent === "response.completed")) {
          messageId = `msg_${parsed.id}`;
        }

        // Track usage
        if (parsed.usage) {
          if (parsed.usage.input_tokens !== undefined) inputTokens = parsed.usage.input_tokens;
          if (parsed.usage.output_tokens !== undefined) outputTokens = parsed.usage.output_tokens;
        }

        // response.created → message_start
        if (currentEvent === "response.created" && parsed.status === "in_progress") {
          emitMessageStart(push);
          continue;
        }

        // response.content_part.added (type: "output_text") → content_block_start
        if (currentEvent === "response.content_part.added") {
          if (parsed.type === "output_text") {
            closeBlock(push);
            blockOpen = true;
            push(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: blockIndex,
                content_block: { type: "text", text: "" },
              })}\n\n`,
            );
          }
          continue;
        }

        // response.output_text.delta → content_block_delta (text_delta)
        if (currentEvent === "response.output_text.delta" && parsed.delta !== undefined) {
          if (!started) emitMessageStart(push);
          if (!blockOpen) {
            blockOpen = true;
            push(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: blockIndex,
                content_block: { type: "text", text: "" },
              })}\n\n`,
            );
          }
          push(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "text_delta", text: parsed.delta },
            })}\n\n`,
          );
          continue;
        }

        // response.function_call_arguments.delta → content_block_delta (input_json_delta)
        if (currentEvent === "response.function_call_arguments.delta" && parsed.delta !== undefined) {
          if (!started) emitMessageStart(push);
          push(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: parsed.delta },
            })}\n\n`,
          );
          continue;
        }

        // response.output_item.done → content_block_stop
        if (currentEvent === "response.output_item.done") {
          closeBlock(push);
          continue;
        }

        // response.completed → message_delta + message_stop
        if (currentEvent === "response.completed") {
          emitMessageStart(push);
          emitClosingEvents(push);
          continue;
        }
      }
      callback();
    },

    flush(callback: () => void) {
      const push = this.push.bind(this);
      // Process any remaining buffered line
      if (lineBuffer.trim()) {
        const line = lineBuffer.trim();
        if (line.startsWith("data: ")) {
          try {
            JSON.parse(line.slice(6).trim());
          } catch {
            // Ignore
          }
        }
      }
      emitMessageStart(push);
      emitClosingEvents(push);
      callback();
    },
  });
}
