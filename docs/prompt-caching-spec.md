# Anthropic Prompt Caching — Technical Specification for ModelWeaver

Sourced from [Anthropic Prompt Caching Guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) and [Messages API Reference](https://docs.anthropic.com/en/api/messages), fetched 2026-03-28.

---

## 1. API Mechanics

### Two Activation Modes

**Automatic caching** (simplest): Add a single `cache_control` field at the top level of the request body. The API automatically places the cache breakpoint at the last cacheable block.

```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 1024,
  "cache_control": { "type": "ephemeral" },
  "system": "You are a helpful assistant.",
  "messages": [...]
}
```

**Explicit block-level caching**: Place `cache_control` directly on individual content blocks.

```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 1024,
  "system": {
    "type": "text",
    "text": "You are a helpful assistant.",
    "cache_control": { "type": "ephemeral" }
  },
  "messages": [
    {
      "role": "user",
      "content": "Analyze this document.",
      "cache_control": { "type": "ephemeral" }
    }
  ]
}
```

Both modes use the same `CacheControlEphemeral` schema:

```
cache_control?: {
  type: "ephemeral"
  ttl?: "5m" | "1h"   // defaults to "5m"
}
```

**CacheControlEphemeral** is valid on these content block types:
- `tools[].cache_control` — on each tool definition
- `system` array content blocks — system instructions
- `messages[].content[]` — text, image, document, tool_use, tool_result, bash_code_execution blocks
- `tool_use` blocks (`input`, `id`, `type` fields) and `tool_result` blocks
- Top-level `cache_control` field — triggers automatic caching

### Supported Models

Claude Opus 4.6, 4.5, 4.1, 4 | Claude Sonnet 4.6, 4.5, 4 | Claude Haiku 4.5, 3

---

## 2. Cache TTL

| TTL | Default | Cost multiplier | Notes |
|-----|---------|-----------------|-------|
| 5 minutes | Yes | 1.25x base input | Refreshed for free on every cache hit |
| 1 hour | Opt-in | 2x base input | Best for sparse conversations (>5 min gaps) |

Both TTLs behave identically regarding latency. Cache entries have a minimum lifetime of 5 or 60 minutes respectively, after which they are deleted. Cache entries are isolated per organization.

---

## 3. Cache Eligibility & Minimum Token Requirements

- **Minimum tokens to benefit from caching**: ~1024 tokens for Opus/Sonnet, ~2048 tokens for Haiku
- **Length-based caching failures are SILENT**: requests succeed but both `cache_creation_input_tokens` and `cache_read_input_tokens` are 0
- Cache eligibility requires the prefix to be long enough; the API does not return an error when conditions aren't met

---

## 4. Cache Hit Pricing

Multipliers relative to base input token price:

| Operation | Price multiplier |
|-----------|-----------------|
| 5-minute cache write | 1.25x base input |
| 1-hour cache write | 2x base input |
| Cache read (any TTL) | 0.1x base input |

Example (Claude Sonnet 4.6, base $3/M input):
- 5m cache write: $3.75/M tokens
- 1h cache write: $6/M tokens
- Cache read: $0.30/M tokens

### Mixing TTLs

When using both 1h and 5m cache controls in the same request, 1h blocks MUST appear before 5m blocks. The API calculates three positions:

1. **Position A**: Token count at highest cache hit (0 if no hits)
2. **Position B**: Token count at highest 1h `cache_control` block after A
3. **Position C**: Token count at last `cache_control` block

Billing: cache read tokens for A, 1h cache write tokens for (B-A), 5m cache write tokens for (C-B).

---

## 5. Cache Breakpoints

### Up to 4 Breakpoints Per Request

Each `cache_control` marker consumes one of 4 available breakpoint slots.

### Cache Hierarchy

Prefixes are created in this order: **tools** -> **system** -> **messages**. This forms a hierarchy where changes at any level invalidate that level and all subsequent levels.

| What changes | Tools cache | System cache | Messages cache |
|---|---|---|---|
| Tool definitions | INVALIDATED | INVALIDATED | INVALIDATED |
| Web search toggle | KEPT | INVALIDATED | INVALIDATED |
| Citations toggle | KEPT | INVALIDATED | INVALIDATED |
| Speed setting (fast mode) | KEPT | INVALIDATED | INVALIDATED |
| `tool_choice` parameter | KEPT | KEPT | INVALIDATED |
| Images | KEPT | KEPT | INVALIDATED |
| Extended thinking settings | KEPT | KEPT | INVALIDATED |

### Automatic Prefix Matching

With a single cache breakpoint, the system automatically finds the longest prefix that a prior request already wrote to cache. The lookback searches up to ~20 blocks backward. Cache writes happen ONLY at the breakpoint — earlier positions are NOT written individually.

**Critical**: Place `cache_control` on the LAST block that stays identical across requests. For a growing conversation, the final block works as long as each turn adds fewer than 20 blocks. For prompts with a varying suffix (timestamps, per-request context), place the breakpoint at the end of the STATIC prefix, not the varying block.

### What CAN Be Cached

- Tool definitions (`tools[]`)
- System messages (`system` content blocks)
- Text content blocks (`messages[].content` — user and assistant turns)
- Image and document content blocks
- Tool use and tool result blocks
- Thinking blocks (implicitly, alongside other content — they DO count as input tokens when read from cache)

### What CANNOT Be Cached

- Thinking blocks directly with `cache_control` (but can be cached alongside other content)
- Sub-content blocks (e.g., citations — cache the parent block instead)
- Empty text blocks

---

## 6. Streaming + Caching

The API returns cache usage information in SSE `usage` events during streaming.

### Streaming SSE Events with Cache Fields

The `message_start` event contains the full `usage` object including cache metrics:

```json
event: message_start
data: {"type":"message_start","message":{"id":"...","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2048,"cache_read_input_tokens":1800,"cache_creation_input_tokens":248,"output_tokens":503,"cache_creation":{"ephemeral_5m_input_tokens":248}}}
```

The `message_delta` event also contains `usage`:

```json
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":503,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"input_tokens":0}}
```

ModelWeaver already parses these fields — see `TOKEN_RE` regex on line 176 of `src/server.ts`.

---

## 7. Multi-Turn Caching

With automatic caching, the cache point moves forward automatically as conversations grow. Each new request caches everything up to the last cacheable block.

| Request | Content | Cache behavior |
|---------|---------|----------------|
| Request 1 | System + User(1) + **User(2)** | Everything written to cache |
| Request 2 | System + User(1) + Asst(1) + User(2) + Asst(2) + **User(3)** | System through User(2) read from cache; Asst(2) + User(3) written to cache |
| Request 3 | System + ... + User(3) + Asst(3) + **User(4)** | System through User(3) read from cache; Asst(3) + User(4) written to cache |

With explicit breakpoints, you must manually move the breakpoint marker on each request.

---

## 8. Best Practices

1. **Use automatic caching** for multi-turn conversations — it handles breakpoint management automatically
2. **Use explicit breakpoints** when different sections change at different frequencies (e.g., tools rarely, context daily)
3. **Cache stable content**: system instructions, tool definitions, background information, large contexts, frequent examples
4. **Place cached content at the prompt's beginning** for best performance
5. **Place breakpoints on static blocks** — not the varying final message
6. **Analyze cache hit rates** and adjust strategy as needed
7. **Use 1h cache** when conversations have gaps >5 minutes but <1 hour, or when rate limit utilization matters
8. **For growing conversations with <20 blocks per turn**: automatic caching or single breakpoint at the end works well
9. **For >20 blocks per turn**: use multiple breakpoints to ensure cache hits
10. **Combine both modes**: explicit breakpoints on tools/system + automatic caching on the conversation

---

## 9. Error Handling

- **Silent length-based failures**: If the prompt is too short (< ~1024 tokens for Opus/Sonnet, < ~2048 for Haiku), the request succeeds but both `cache_creation_input_tokens` and `cache_read_input_tokens` are 0. No error is returned.
- **Cache breakpoint on wrong block**: If the breakpoint is placed on a block that changes every request (e.g., the final user message with timestamps), caching is ineffective. The API does not error — it simply misses the cache.
- **Invalid beta header**: Returns `{ "type": "error", "error": { "type": "invalid_request_error", "message": "Unsupported beta header: ..." } }` — note: prompt caching does NOT require a beta header (see section 10).
- **Python SDK error**: `AttributeError: 'Beta' object has no attribute 'prompt_caching'` — this is a legacy error from older SDK versions; prompt caching is now GA.

---

## 10. Beta Headers

**Prompt caching is NOT a beta feature.** No `anthropic-beta` header is required. The feature is documented in the standard Messages API reference and has no beta namespace.

The beta headers documentation describes the pattern for accessing experimental features:

```http
anthropic-beta: feature-name-YYYY-MM-DD
```

For multiple beta features:
```http
anthropic-beta: feature1,feature2,feature3
```

Invalid beta headers return `invalid_request_error`. Prompt caching is generally available and uses no beta header.

---

## 11. Response Usage Fields

The API response `usage` object contains:

```json
{
  "usage": {
    "input_tokens": 2048,
    "cache_read_input_tokens": 1800,
    "cache_creation_input_tokens": 248,
    "output_tokens": 503,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 248,
      "ephemeral_1h_input_tokens": 0
    }
  }
}
```

**Total input tokens** = `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`

The `cache_creation_input_tokens` field equals the sum of `ephemeral_5m_input_tokens` + `ephemeral_1h_input_tokens` in the `cache_creation` breakdown object.

---

## 12. Data Retention

- Prompt caching is ZDR (Zero Data Retention) eligible
- Anthropic does NOT store raw text of prompts or responses
- KV cache representations and cryptographic hashes are held in memory only, not at rest
- Minimum lifetime: 5 minutes (standard) or 60 minutes (extended)
- Cache entries are isolated between organizations

---

## ModelWeaver Gap Analysis

### Already Implemented

| Feature | Location |
|---------|----------|
| Cache token metrics extraction (SSE streaming) | `src/server.ts:176` — `TOKEN_RE` regex parses `cache_read_input_tokens` and `cache_creation_input_tokens` |
| Cache token metrics extraction (non-streaming) | `src/server.ts:65-74` — `extractTokenCounts()` function |
| Raw body passthrough when no modifications needed | `src/proxy.ts:499-500` — preserves cache breakpoints intact |
| Targeted string replacements on primary attempt | `src/proxy.ts:464-468` — avoids JSON.stringify destroying position-sensitive cache breakpoints |
| Fallback note about broken caching | `src/proxy.ts:470` — documents that fallback attempts already break caching |

### Not Yet Implemented

| Feature | Priority | Notes |
|---------|----------|-------|
| Active cache_control injection | High | ModelWeaver only preserves upstream cache_control; cannot inject it for clients that don't include it |
| Token counting before forwarding | High | Needed to determine if prompt meets minimum ~1024 token threshold before deciding to inject cache_control |
| Per-provider cache capability detection | Medium | Need to detect which providers (Anthropic, Bedrock, Vertex) support which caching variants |
| Automatic caching mode injection | High | Inject top-level `cache_control: { type: "ephemeral" }` on eligible requests |
| Configurable TTL (5m vs 1h) | Medium | Per-provider or per-route TTL configuration |
| Cache hit rate monitoring | Low | Already tracks tokens; needs dashboard/metrics for hit rate |
| Cache invalidation on upstream changes | Medium | Detect system/tools changes and invalidate accordingly |
