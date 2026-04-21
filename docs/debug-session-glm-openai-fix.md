# Debug Session: glm_openai Truncated Responses Fix

## Issue
Claude Code reported: `undefined is not an object (evaluating '_.input_tokens')` when routing through `glm_openai` provider.

## Root Cause

### Primary Bug: Stream State Race Condition

**Location:** `src/server.ts:727` and `src/proxy.ts:1325`

**What happened:**
1. `setImmediate(() => transitionStreamState(ctx, "complete"))` was queued immediately after creating the `Response` object
2. TTFB handler (line 670) also queues `setImmediate(() => transitionStreamState(ctx, "ttfb"))`
3. Event loop processes in order: `start → ttfb → complete`
4. `passThrough.on("data")` handler at proxy.ts:1325 checks:
   ```js
   if (ctx._streamState === "error" || ctx._streamState === "complete") return;
   ```
5. Since state was already `"complete"`, ALL chunks were dropped silently

**Why `glm` native worked but `glm_openai` didn't:**
- `glm` (Anthropic format): `undiciResponse.body` is lazy — doesn't emit data until client reads it. By then, metrics branch corrects state back to `"streaming"`
- `glm_openai` (Transform stream): Starts processing immediately when piped. Data arrives before metrics can fix state. Chunks get dropped.

### Secondary Bug: URL Construction

**Location:** `src/adapters/openai-chat.ts:21`

**Issue:** GLM's base URL `https://api.z.ai/api/coding/paas/v4` already includes version prefix (`/v4`). Adapter added `/v1/chat/completions`, creating `/v4/v1/chat/completions` → 404.

**Fix:** Detect versioned paths with regex `/\/v\d+(\.\d+)*$/` and append `/chat/completions` directly.

## The Fix

### 1. Stream State (`src/server.ts`)

Only transition to `"complete"` for non-streaming responses. Let proxy's `safeClose()` handle completion when stream actually ends:

```typescript
const latencyMs = Date.now() - ctx.startTime;
setImmediate(() => {
  const isStreaming = response.body instanceof ReadableStream;
  if (!isStreaming) {
    ctx._streamState = transitionStreamState(ctx, "complete", ctx.requestId);
  }
  // ... broadcast event
});
```

### 2. Pipe Ordering (`src/proxy.ts`)

Moved pipe setup inside `ReadableStream.start()` to ensure data handler is registered before upstream starts flowing. Though stream state fix addressed this, ordering is still cleaner.

### 3. URL Construction (`src/adapters/openai-chat.ts`)

```typescript
buildUpstreamUrl(baseUrl: string, _incomingPath: string, _model: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  // Match versioned paths like /v4, /v4.1, /v1, etc.
  if (/\/v\d+(\.\d+)*$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}
```

## Findings

### Streaming Behavior Differences

| Aspect | Anthropic (native) | OpenAI Adapter |
|---------|---------------------|-----------------|
| Data flow | Lazy (waits for reader) | Eager (Transform starts immediately) |
| Pipe timing | After Response created | After `transformResponse()` returns |
| State window | Metrics corrects state before data arrives | Data arrives before state fix |
| Buffering | Undici handles natively | Transform adds processing overhead |

### OpenAI → Anthropic Translation

**What works:**
- ✅ Message format (roles, text, images)
- ✅ Tool calls (Anthropic `tool_use` → OpenAI `tool_calls`)
- ✅ Tool results (Anthropic `tool_result` → OpenAI `tool` messages)
- ✅ Token mapping (`prompt_tokens` → `input_tokens`, etc.)
- ✅ SSE structure (message_start, content blocks, message_delta, message_stop)

**What's intentionally dropped:**
- ⚠️ `thinking` blocks (Anthropic-specific, GLM doesn't support them)
- ⚠️ `cache_control` headers (OpenAI providers handle caching differently)

**Limitation:**
- Content arrays are flattened to strings for text (many OpenAI-compatible providers don't accept arrays)
- Tool call arguments are stringified as JSON in `arguments` field

### Model Routing Behavior

GLM context capacity (200K input, 128K output) can handle large histories, but:
- Early in debug: `max_tokens=128000` caused context-exceeded on older GLM versions
- After fix: Requests with 379+ messages succeed through `glm-5.1`
- Weighted routing with mixed capabilities (5.1, 5-turbo, 4.7) can cause inconsistent agentic behavior

## Lessons Learned

### 1. Stream State Must Outlive Data Flow

State transitions to terminal states (`complete`, `error`) must only happen when the underlying stream **actually ends**. Using `setImmediate` for housekeeping (logging, metrics) must NOT mark streams as complete if data might still be flowing.

**Pattern to avoid:**
```typescript
// ❌ Bad: Premature completion
setImmediate(() => {
  transitionStreamState(ctx, "complete");
  recordMetrics();
});

// ✅ Good: Conditional completion
setImmediate(() => {
  if (!isStreaming) {
    transitionStreamState(ctx, "complete");
  }
  recordMetrics(); // Always record
});
```

### 2. Pipe Registration Order Matters

When wrapping Node.js streams in Web ReadableStream:
```typescript
// ❌ Risk: Data arrives before handler registered
const stream = upstream.pipe(transform);
const wrapped = new ReadableStream({ start(controller) {
  transform.on("data", (chunk) => controller.enqueue(chunk));
}});

// ✅ Safe: Handler registered before pipe
const wrapped = new ReadableStream({ start(controller) {
  transform.on("data", (chunk) => controller.enqueue(chunk));
  upstream.pipe(transform); // Pipe after listeners
}});
```

### 3. Lazy vs Eager Streams

- **Lazy streams** (undici responses, lazy fetch): Don't emit data until read. Safe for late listener registration.
- **Eager streams** (Transform, Duplex): Start processing immediately. Must register listeners **before** any pipe/operation that triggers data flow.

### 4. Adapter Format Translation

**Key insight:** OpenAI-to-Anthropic translation happens in a Transform stream. This means:
- Byte-level pass-through is **not** possible (must parse/reparse SSE)
- Metrics branch must parse transformed SSE, not raw bytes
- Debugging requires logging at multiple stages (transform input, transform output, proxy pass-through)

### 5. Version Detection in URLs

Always handle both patterns:
- Versioned base: `https://api.example.com/v4` → append `/chat/completions`
- Unversioned base: `https://api.example.com` → append `/v1/chat/completions`

Regex `/\/v\d+(\.\d+)*$/` catches `/v4`, `/v4.1`, `/v1.2.3`, etc.

## Testing Checklist

For future adapter implementations:

- [ ] Non-streaming responses return full JSON with usage fields
- [ ] Streaming responses include `message_start` with usage (even if 0)
- [ ] `message_delta` has both `stop_reason` and `usage`
- [ ] `message_stop` is always sent as last event
- [ ] Empty content responses (context exceeded) don't crash client
- [ ] Large context (100K+ tokens) doesn't trigger premature completion
- [ ] Mixed content types (text, images, tools) all translate correctly
- [ ] Tool calls generate valid function definitions and arguments

## Related Code

- `src/server.ts`: Response construction, metrics recording
- `src/proxy.ts`: Pass-through stream, safeClose, state guards
- `src/adapters/openai-chat.ts`: Request/response transformation
- `src/adapters/openai-utils.ts`: OpenAI ↔ Anthropic format conversion

## Commits

- `a6f9783`: fix: stream state race causing glm_openai truncated responses
