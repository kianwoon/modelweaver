# OpenAI Upstream Adapter Design

> Date: 2026-04-20
> Status: Draft
> Scope: Add OpenAI-compatible upstream provider support to ModelWeaver

## Problem

ModelWeaver currently only supports Anthropic wire format for upstream providers. Requests and responses pass through as raw Anthropic SSE with no transformation. This locks out OpenAI, Mistral, Together, Groq, OpenRouter, and any provider using the OpenAI Chat Completions or Responses API format.

## Solution

Introduce a **Provider Adapter** layer using the Adapter Pattern. Each adapter encapsulates the translation logic for one upstream wire format. The proxy resolves the adapter from the provider's `apiFormat` config field and delegates all format-specific logic to it.

## Architecture

### Adapter Interface

```typescript
// src/adapters/base.ts
export interface ProviderAdapter {
  readonly format: "anthropic" | "openai-chat" | "openai-responses";

  transformRequest(body: string, headers: Record<string, string>): {
    body: string;
    headers: Record<string, string>;
  };

  buildUpstreamUrl(baseUrl: string, incomingPath: string, model: string): string;

  transformResponse(upstreamStream: NodeJS.ReadableStream): NodeJS.ReadableStream;

  transformError(status: number, body: string): { type: string; message: string };
}
```

### Data Flow

```
Client (Anthropic format)
  → ModelWeaver server
    → proxy.ts resolves adapter from provider.apiFormat
    → adapter.transformRequest(body, headers)
    → adapter.buildUpstreamUrl(baseUrl, path, model)
    → send to upstream
    → adapter.transformResponse(upstream SSE) → Anthropic SSE
    → pipe to client
```

The proxy retains all existing logic: fallback chains, circuit breakers, hedging, TTFB timeouts, stall detection. The adapter only handles wire format translation.

### Adapter Registry

```typescript
// src/adapters/registry.ts
export function getAdapter(format?: string): ProviderAdapter {
  switch (format) {
    case "openai-chat": return new OpenAIChatAdapter();
    case "openai-responses": return new OpenAIResponsesAdapter();
    default: return new AnthropicAdapter(); // passthrough
  }
}
```

## Adapters

### AnthropicAdapter (passthrough)

No-op adapter. Preserves current behavior exactly. All methods return inputs unchanged. This is the default when `apiFormat` is unset or `"anthropic"`.

### OpenAIChatAdapter

Translates between Anthropic format and OpenAI Chat Completions (`/v1/chat/completions`).

#### Request Translation (Anthropic → OpenAI Chat)

| Anthropic Field | OpenAI Chat Field | Notes |
|---|---|---|
| `model` | `model` | Pass-through |
| `max_tokens` | `max_tokens` | Pass-through |
| `system` (string or array) | `messages[{role:"system",content:...}]` | Prepended to messages array |
| `messages[{role:"user"}]` | `messages[{role:"user"}]` | Content mapped (see below) |
| `messages[{role:"assistant"}]` | `messages[{role:"assistant"}]` | Content mapped (see below) |
| `tools[{name,input_schema,description}]` | `tools[{type:"function",function:{name,parameters,description}}]` | Nested under `function` |
| `tool_choice{type:"auto"}` | `tool_choice:"auto"` | Simplified |
| `tool_choice{type:"tool",name:X}` | `tool_choice:{type:"function",function:{name:X}}` | Restructured |
| `thinking{type:"enabled",budget_tokens}` | `reasoning_effort: "high"` (or omit if upstream doesn't support reasoning) | budget_tokens → effort mapping: ≤4k="low", ≤16k="medium", >16k="high" |
| `metadata.user_id` | `user` | Top-level field |
| `stream: true` | `stream: true` | Pass-through |

**Message content mapping:**

| Anthropic Content Block | OpenAI Content Part |
|---|---|
| `{type:"text",text:"..."}` | `{type:"text",text:"..."}` |
| `{type:"image",source{type:"base64",data:"...",media_type:"..."}}` | `{type:"image_url",image_url:{url:"data:...;base64,..."}}` |
| `{type:"image",source{type:"url",url:"..."}}` | `{type:"image_url",image_url:{url:"..."}}` |
| `{type:"tool_use",id,name,input}` | Becomes `tool_calls[{id,function:{name,arguments:JSON.stringify(input)}}]` on assistant message |
| `{type:"tool_result",tool_use_id,content}` | Becomes `{role:"tool",tool_call_id,content}` message |

**Strategy:** Full JSON parse → map → serialize. Anthropic cache breakpoints (`cache_control`) are stripped since they're meaningless for OpenAI upstream.

#### Response Translation (OpenAI Chat → Anthropic SSE)

**SSE event mapping:**

| OpenAI SSE Chunk | Anthropic SSE Event |
|---|---|
| First chunk (role:"assistant") | `message_start` + `content_block_start(type:"text")` |
| `delta.content` | `content_block_delta(text_delta)` |
| `delta.tool_calls[i]` (first appearance) | `content_block_start(type:"tool_use")` |
| `delta.tool_calls[i].function.arguments` | `content_block_delta(input_json_delta)` |
| `delta.reasoning_content` | `content_block_start(type:"thinking")` + `content_block_delta(thinking_delta)` |
| `finish_reason:"stop"` or `"tool_calls"` | `content_block_stop` per block + `message_delta` + `message_stop` |
| `data: [DONE]` | Stream ends (already emitted `message_stop`) |

**Token usage mapping:**

| OpenAI | Anthropic |
|---|---|
| `usage.prompt_tokens` | `usage.input_tokens` |
| `usage.completion_tokens` | `usage.output_tokens` |

**Implementation:** A `Transform` stream that buffers incoming SSE lines, parses OpenAI JSON chunks, and emits Anthropic SSE events.

#### URL Construction

Anthropic incoming path is `/v1/messages`. OpenAI Chat Completions path is `/v1/chat/completions`. The adapter replaces the path entirely rather than appending.

```
buildUpstreamUrl(baseUrl, _incomingPath, model) → baseUrl + "/v1/chat/completions"
```

#### Header Transformation

- Replace `x-api-key` with `Authorization: Bearer <apiKey>` (or use existing `authType: "bearer"`)
- Remove `anthropic-version`, `anthropic-beta` headers
- Add `Accept: text/event-stream`

### OpenAIResponsesAdapter

Translates between Anthropic format and OpenAI Responses API (`/v1/responses`).

#### Request Translation (Anthropic → OpenAI Responses)

| Anthropic Field | OpenAI Responses Field | Notes |
|---|---|---|
| `model` | `model` | Pass-through |
| `max_tokens` | `max_output_tokens` | Renamed |
| `system` | `instructions` | Top-level string |
| `messages[]` | `input[]` | Flattened into input array |
| `tools[]` | `tools[{type:"function",...}]` | Same nesting as Chat |
| `thinking{type:"enabled",budget_tokens}` | `reasoning{max_tokens}` | Direct mapping |
| `stream: true` | `stream: true` | Pass-through |

#### Response Translation (OpenAI Responses → Anthropic SSE)

The Responses API uses a different event vocabulary:

| OpenAI Responses Event | Anthropic SSE Event |
|---|---|
| `response.created` | `message_start` |
| `response.output_item.added` (type:"message") | `content_block_start` |
| `response.content_part.added` | `content_block_start` |
| `response.output_text.delta` | `content_block_delta(text_delta)` |
| `response.function_call_arguments.delta` | `content_block_delta(input_json_delta)` |
| `response.output_item.done` | `content_block_stop` |
| `response.completed` | `message_delta` (usage) + `message_stop` |

#### URL Construction

```
buildUpstreamUrl(baseUrl, _incomingPath, model) → baseUrl + "/v1/responses"
```

## Error Handling

### Error Normalization

All adapters implement `transformError()` to normalize upstream errors into Anthropic shape:

**OpenAI error format:**
```json
{"error": {"message": "...", "type": "...", "code": "..."}}
```

**Anthropic error format (target):**
```json
{"type": "error", "error": {"type": "...", "message": "..."}}
```

Mapping: `error.type` → `error.type`, `error.message` → `error.message`.

This ensures existing proxy error handling (429 detection, retry logic, circuit breaker, fallback) works unchanged regardless of upstream format.

### Edge Cases

- **Parallel tool calls:** OpenAI sends multiple `tool_calls` in one delta chunk. The translator emits separate `content_block_start`/`content_block_stop` pairs for each tool call.
- **Tool result messages:** Client sends `tool_result` content blocks with `tool_use_id`. The translator maps these to `role: "tool"` messages with matching `tool_call_id`.
- **Missing reasoning support:** If the upstream doesn't emit reasoning tokens, the translator simply doesn't emit thinking events — no error.
- **`disableThinking: true`:** When set in server config, thinking blocks are stripped from outbound request regardless of adapter. This is handled in proxy.ts before adapter transformation.
- **Partial SSE chunks:** SSE data may be split across TCP packets. The `Transform` stream buffers incomplete lines before parsing.

## Configuration

### Provider Config Extension

New field `apiFormat` on `ProviderConfig`:

```yaml
providers:
  # Existing Anthropic provider (unchanged)
  anthropic:
    baseUrl: "https://api.anthropic.com"
    apiKey: "${ANTHROPIC_KEY}"
    timeout: 30000
    # apiFormat defaults to "anthropic"

  # New: OpenAI-compatible provider
  openrouter:
    baseUrl: "https://openrouter.ai/api"
    apiKey: "${OPENROUTER_KEY}"
    apiFormat: openai-chat
    authType: bearer
    timeout: 30000

  # New: OpenAI Responses API
  openai:
    baseUrl: "https://api.openai.com"
    apiKey: "${OPENAI_KEY}"
    apiFormat: openai-responses
    authType: bearer
    timeout: 30000
```

### Type Changes

```typescript
// src/types.ts — ProviderConfig addition
apiFormat?: "anthropic" | "openai-chat" | "openai-responses";
```

### Zod Schema Changes

```typescript
// src/config.ts — provider schema addition
apiFormat: z.enum(["anthropic", "openai-chat", "openai-responses"]).optional().default("anthropic")
```

## File Structure

### New Files

```
src/adapters/
  base.ts              — ProviderAdapter interface
  registry.ts          — getAdapter(format) factory function
  anthropic.ts         — Passthrough adapter (current behavior)
  openai-chat.ts       — Chat Completions adapter
  openai-responses.ts  — Responses API adapter
  openai-utils.ts      — Shared helpers (SSE line parser, token mapping, content block mappers)
tests/adapters/
  openai-chat.test.ts       — Request/response translation tests
  openai-responses.test.ts  — Request/response translation tests
```

### Modified Files

| File | Change |
|---|---|
| `src/types.ts` | Add `apiFormat` to `ProviderConfig` |
| `src/config.ts` | Add `apiFormat` to Zod provider schema, default `"anthropic"` |
| `src/proxy.ts` | Resolve adapter via `getAdapter()`, delegate request/response transformation |

### Proxy Integration Points

In `forwardRequest()`:

1. **Before request:** Replace `buildOutboundUrl()` → `adapter.buildUpstreamUrl()`. Replace header building with `adapter.transformRequest()` output.
2. **Request body:** Replace `applyTargetedReplacements()` for OpenAI adapters — full JSON parse/map/serialize instead.
3. **After response:** Wrap upstream body stream with `adapter.transformResponse()`.
4. **Error path:** Non-2xx responses go through `adapter.transformError()` before Anthropic error shaping.

The Anthropic adapter's methods are all passthrough, so existing Anthropic providers see zero behavioral change.

## Testing Strategy

### Unit Tests (per adapter)

1. **Request body translation:** Given Anthropic JSON body, assert OpenAI output matches expected mapping
2. **SSE event translation:** Given sequence of OpenAI SSE chunks, assert Anthropic SSE event stream output
3. **Error normalization:** Given OpenAI error JSON, assert Anthropic error shape
4. **URL construction:** Given baseUrl and incoming path, assert correct upstream URL
5. **Edge cases:** Parallel tool calls, empty content, missing fields

### Integration Tests

1. Mock OpenAI upstream server, send Anthropic request through proxy, verify Anthropic response
2. Fallback from OpenAI provider to Anthropic provider (mixed chain)
3. Circuit breaker with OpenAI providers

### Passthrough Verification

- Existing tests pass unchanged (AnthropicAdapter is pure passthrough)
- No behavioral regression for current Anthropic-only setups

## Scope Boundaries

### In Scope

- Anthropic → OpenAI Chat Completions request/response translation
- Anthropic → OpenAI Responses API request/response translation
- Streaming SSE translation in both directions
- Tool/function calling, vision/images, system messages, thinking/reasoning
- Error normalization
- Per-provider `apiFormat` config field

### Out of Scope

- OpenAI format as **downstream** (clients sending OpenAI format to ModelWeaver)
- Non-streaming response mode
- Batch/async endpoints
- Embeddings, fine-tuning, or non-chat endpoints
- Google Gemini or other provider formats (future adapter)
