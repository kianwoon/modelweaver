# Stream Buffering for SSE Delivery — Design Spec

**Date**: 2026-04-02
**Issue**: github.com/kianwoon/modelweaver/issues/125
**Status**: Approved

---

## 1. Problem

SSE events currently pass through directly from upstream to downstream. Some providers send many tiny chunks (a few bytes each), resulting in high TCP packet overhead and potential stuttering in CLI clients.

---

## 2. Solution

Add an optional streaming chunk buffer that batches small SSE chunks before forwarding downstream. The buffer is entirely opt-in and off by default.

---

## 3. Configuration

**File**: `~/.modelweaver/config.yaml` (existing)

```yaml
server:
  streamBufferMs: 5       # time-based flush (ms), 0/unset = disabled
  streamBufferBytes: 16384 # size-based flush (bytes), 0/unset = disabled
```

- Both fields are independently optional — setting either `> 0` activates buffering
- `0` or `undefined` means that trigger is disabled
- Config schema rejects negative values

**Files modified**:
- `src/types.ts` — add `streamBufferMs?` and `streamBufferBytes?` to `ServerConfig`
- `src/config.ts` — add Zod validation for both fields

---

## 4. SSEBuffer Class

**File**: `src/stream-buffer.ts` (new)

### Interface

```typescript
export interface SSEBufferOptions {
  bufferBytes: number;   // 0 = disabled
  bufferMs: number;      // 0 = disabled
}

export class SSEBuffer {
  constructor(
    private enqueue: (chunk: Uint8Array) => void,
    private opts: SSEBufferOptions,
  ) {}

  /** Write a chunk from upstream. May trigger a flush. */
  write(data: Uint8Array): void;

  /** Force flush — called on end/error paths. */
  flush(): void;

  /** Called when upstream stream ends. Flushes remainder. */
  end(): void;
}
```

### Behavior

- **Accumulation**: Chunks are held in an internal `Uint8Array[]` accumulator, tracking total `byteLength`.
- **Size threshold**: On each `write()`, if `byteLength >= bufferBytes` AND a `\n\n` boundary exists at or before that threshold, flush up to (and including) the boundary. Remainder stays buffered.
- **Time threshold**: A `setTimeout` fires after `bufferMs` from the last flush (timer resets after each flush). When it fires, flush all currently buffered data — even if mid-event.
- **Boundary preservation**: `\n\n` is the SSE event separator. The buffer finds the last safe flush point (last `\n\n`) and never flushes mid-event.
- **Timer expiry flush**: When the timer fires (time-based trigger), flush everything regardless of boundary — this is intentional and SSE parsers handle partial events gracefully.
- **End flush**: When `end()` is called (upstream closed), flush all remaining buffered data immediately.
- **Passthrough mode**: If both `bufferBytes === 0` and `bufferMs === 0`, `write()` immediately calls `enqueue()` — no buffering.

### Boundary Detection

Uses `lastIndexOf(\n\n)` on the accumulated byte buffer to find the last complete SSE event boundary. This is O(n) on the chunk list size — acceptable since chunks are typically small and boundaries are checked frequently.

---

## 5. Proxy Integration

**File**: `src/proxy.ts` (modified)

### Activation condition

Buffering is active when: `(server.streamBufferMs ?? 0) > 0 || (server.streamBufferBytes ?? 0) > 0`

### Request-scoped lifecycle

```
1. Request starts
2. Check if buffering is enabled
3. If yes → create SSEBuffer(controller.enqueue, { bufferBytes, bufferMs })
4. passThrough.on("data", chunk => sseBuffer.write(new Uint8Array(chunk)))
5. passThrough.on("end",  () => sseBuffer.end())
6. passThrough.on("error", () => sseBuffer.end())
7. Stream completes → buffer discarded (GC-eligible)
```

No changes to:
- Error response paths (4xx/5xx — consumed without buffering)
- Non-streaming response paths (plain text/buffer fallback)
- The ReadableStream controller lifecycle (close/error remain the same)

---

## 6. Testing

**File**: `tests/stream-buffer.test.ts` (new)

| Test | Description |
|------|-------------|
| `size threshold flush` | Buffer fills past threshold with complete events; flushes at boundary |
| `time threshold flush` | Timer fires; all buffered data flushed |
| `timer resets on flush` | After size-based flush, timer does not fire on next chunk immediately |
| `event boundary preserved` | Partial event (no `\n\n`) is held until complete event arrives |
| `end flushes remainder` | `end()` called with partial buffer; all data flushed |
| `both disabled passthrough` | `bufferMs=0` and `bufferBytes=0`; each `write` → immediate `enqueue` |
| `only time trigger` | `bufferBytes=0`; only timer triggers flush |
| `only size trigger` | `bufferMs=0`; only size threshold + boundary triggers flush |
| `multiple flushes` | Large stream; multiple flush cycles each preserve correct boundaries |

---

## 7. Scope

**In scope**:
- SSEBuffer class with all behavior above
- Config schema and types for the two new server fields
- Proxy.ts integration (streaming path only)

**Out of scope**:
- Integration tests with live providers
- Changes to non-streaming paths
- GUI changes for buffer configuration
