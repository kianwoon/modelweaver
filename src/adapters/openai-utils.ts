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
    }

    if (toolCalls.length > 0) {
      return {
        content: textParts.length > 0 ? textParts.join("") : null,
        tool_calls: toolCalls,
      };
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

      return {
        content:
          mappedNonTool.length === 1 && mappedNonTool[0] && (mappedNonTool[0] as { type?: string }).type === "text"
            ? (mappedNonTool[0] as { text?: string }).text ?? mappedNonTool
            : mappedNonTool,
        extraMessages,
      };
    }
  }

  // General case: map each content block
  const mapped = content.map(mapContentBlockToChat);
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
  const cleaned = stripCacheControl(result);
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
 * - message_delta/message_stop on finish_reason or [DONE]
 * - Flush fallback for incomplete streams
 */
export function createOpenAIChatToAnthropicStream() {
  let messageId = "msg_" + Math.random().toString(36).substring(2, 15);
  let model = "model";
  let inputTokens = 0;
  let outputTokens = 0;

  let started = false;
  let closed = false;
  let currentBlockType: "text" | "thinking" | "tool_use" | null = null;
  let toolArgsBuffer = "";

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
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        })}\n\n`,
      );
      started = true;
    }
  }

  function closeBlock(push: PushFn) {
    if (currentBlockType) {
      push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      currentBlockType = null;
    }
  }

  function emitClosingEvents(push: PushFn) {
    if (closed) return;
    closed = true;
    closeBlock(push);
    const stopReason = toolArgsBuffer ? "tool_use" : "end_turn";
    push(
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
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

    // Handle role/assistant start
    if (delta?.role === "assistant" && !currentBlockType) {
      currentBlockType = "text";
      push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}\n\n`,
      );
    }

    // Handle reasoning_content -> thinking block
    if (delta?.reasoning_content) {
      if (currentBlockType === "text") {
        push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      }
      if (currentBlockType !== "thinking") {
        currentBlockType = "thinking";
        push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          })}\n\n`,
        );
      }
      push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        })}\n\n`,
      );
      return;
    }

    // Handle text content
    if (delta?.content) {
      if (currentBlockType === "thinking") {
        push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      }
      if (currentBlockType !== "text") {
        currentBlockType = "text";
        push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );
      }
      push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta.content },
        })}\n\n`,
      );
      return;
    }

    // Handle tool_calls
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        // New tool call with id
        if (tc.id) {
          closeBlock(push);
          currentBlockType = "tool_use";
          toolArgsBuffer = "";

          push(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: tc.id, name: tc.function?.name ?? "", input: {} },
            })}\n\n`,
          );
        }

        // Accumulate arguments
        if (tc.function?.arguments) {
          toolArgsBuffer += tc.function.arguments;
          push(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            })}\n\n`,
          );
        }
      }
      return;
    }

    // Handle finish_reason
    if (choice.finish_reason) {
      emitClosingEvents(push);
    }
  }

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      const lines = chunk.toString().split("\n");
      const push = this.push.bind(this);

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          emitMessageStart(push);
          emitClosingEvents(push);
          callback();
          return;
        }

        try {
          processChunk(JSON.parse(data), push);
        } catch {
          // Skip invalid JSON
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
