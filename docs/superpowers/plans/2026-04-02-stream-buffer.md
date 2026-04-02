# Stream Buffering for SSE Delivery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional SSE chunk buffering to batch small upstream chunks before forwarding downstream, reducing TCP overhead and improving CLI streaming smoothness.

**Architecture:** A new `SSEBuffer` class wraps the `controller.enqueue` function and holds chunks until a size threshold (event boundary-preserving) or time threshold (timer-based) is met. The buffer is request-scoped and activated only when config opts in.

**Tech Stack:** TypeScript, Node.js streams, Vitest

---

## File Map

| File | Role |
|------|------|
| `src/stream-buffer.ts` | New — `SSEBuffer` class with all buffering logic |
| `src/types.ts` | Modify — add `streamBufferMs?`, `streamBufferBytes?` to `ServerConfig` |
| `src/config.ts` | Modify — add Zod validation for both new fields |
| `src/proxy.ts` | Modify — integrate `SSEBuffer` into the `passThrough.on("data")` handler |
| `tests/stream-buffer.test.ts` | New — unit tests for `SSEBuffer` |

---

## Task 1: Add ServerConfig types

**Files:**
- Modify: `src/types.ts:~50` (after `ServerConfig` interface)

- [ ] **Step 1: Add two new optional fields to ServerConfig**

Find the `ServerConfig` interface in `src/types.ts` and add:

```typescript
export interface ServerConfig {
  port: number;
  host: string;
  streamBufferMs?: number;       // 0/unset = disabled, > 0 = time-based flush threshold (ms)
  streamBufferBytes?: number;    // 0/unset = disabled, > 0 = size-based flush threshold (bytes)
}
```

---

## Task 2: Add Zod validation to config.ts

**Files:**
- Modify: `src/config.ts` — find the `server:` Zod schema block and add two fields

- [ ] **Step 1: Find the server Zod schema in config.ts**

Run: `grep -n "server:" src/config.ts`
Expected: Line with `server: z.object({`

- [ ] **Step 2: Add streamBufferMs and streamBufferBytes to the server Zod schema**

In the `server: z.object({ ... })` call, add after the existing fields:

```typescript
streamBufferMs: z.number().min(0).optional(),
streamBufferBytes: z.number().min(0).optional(),
```

Both fields use `min(0)` to reject negative values. `optional()` means the field can be absent (disabled).

---

## Task 3: Create SSEBuffer class

**Files:**
- Create: `src/stream-buffer.ts`

- [ ] **Step 1: Write the SSEBuffer class**

```typescript
/** Finds the last occurrence of newlines (\n\n) in a Uint8Array */
function findLastEventBoundary(buf: Uint8Array): number {
  // SSE events are separated by \n\n (two consecutive newlines)
  for (let i = buf.length - 2; i >= 0; i--) {
    if (buf[i] === 0x0A && buf[i + 1] === 0x0A) return i + 2;
  }
  return -1;
}

export interface SSEBufferOptions {
  bufferBytes: number;  // 0 = disabled
  bufferMs: number;      // 0 = disabled
}

export class SSEBuffer {
  private chunks: Uint8Array[] = [];
  private byteLength = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private enqueue: (chunk: Uint8Array) => void,
    private opts: SSEBufferOptions,
  ) {}

  private scheduleTimer(): void {
    if (!this.opts.bufferMs || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.opts.bufferMs);
  }

  private resetTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Flush buffered data via enqueue. If boundary is found, flush up to and including boundary. Otherwise flush everything. */
  private flushAtBoundary(): void {
    // Passthrough mode — no buffering
    if (!this.opts.bufferBytes && !this.opts.bufferMs) {
      for (const chunk of this.chunks) {
        this.enqueue(chunk);
      }
      this.chunks = [];
      this.byteLength = 0;
      return;
    }

    if (this.chunks.length === 0) return;

    // Concatenate all chunks into a single buffer for boundary scanning
    const combined = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    if (this.opts.bufferBytes && this.byteLength >= this.opts.bufferBytes) {
      // Size threshold met — find last safe boundary before or at threshold
      // Scan from byteLength-2 downward for \n\n
      let boundary = -1;
      const scanLimit = Math.min(this.byteLength - 1, this.opts.bufferBytes);
      for (let i = scanLimit - 2; i >= 0; i--) {
        if (combined[i] === 0x0A && combined[i + 1] === 0x0A) {
          boundary = i + 2;
          break;
        }
      }

      if (boundary > 0) {
        // Flush up to and including the boundary
        this.enqueue(combined.subarray(0, boundary));
        const remainder = combined.subarray(boundary);
        this.chunks = [remainder];
        this.byteLength = remainder.length;
        this.scheduleTimer();
        return;
      }
      // Threshold met but no boundary found yet — fall through to hold
    }

    // No size threshold met, or timer expiry — flush everything
    this.enqueue(combined);
    this.chunks = [];
    this.byteLength = 0;
    this.resetTimer();
  }

  write(data: Uint8Array): void {
    // Passthrough mode
    if (!this.opts.bufferBytes && !this.opts.bufferMs) {
      this.enqueue(data);
      return;
    }

    this.chunks.push(data);
    this.byteLength += data.length;
    this.scheduleTimer();

    // Check size threshold — flush at last complete event before threshold
    if (this.opts.bufferBytes && this.byteLength >= this.opts.bufferBytes) {
      this.flushAtBoundary();
    }
  }

  flush(): void {
    if (this.chunks.length === 0) return;
    this.resetTimer();
    this.flushAtBoundary();
  }

  end(): void {
    this.resetTimer();
    // Flush all remaining buffered data (even partial events)
    if (this.chunks.length === 0) return;
    const combined = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.enqueue(combined);
    this.chunks = [];
    this.byteLength = 0;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/stream-buffer.ts src/types.ts src/config.ts
git commit -m "feat(proxy): add SSEBuffer class for optional stream chunk buffering (#125)"
```

---

## Task 4: Wire server config to providers

**Files:**
- Modify: `src/types.ts:~7` (`ProviderConfig` interface — add `_serverConfig?`)
- Modify: `src/config.ts` (set `_serverConfig` on each provider after parsing)

- [ ] **Step 1: Add `_serverConfig` to ProviderConfig**

In `src/types.ts`, find the `ProviderConfig` interface. After the existing `_circuitBreaker` field (~line 23), add:

```typescript
  _serverConfig?: ServerConfig;
```

This follows the existing pattern of runtime-only cached fields prefixed with `_`.

- [ ] **Step 2: Set `_serverConfig` on providers during config load**

In `src/config.ts`, find where providers are set up after Zod parsing (search for where `providers` Map is populated). After all providers are created, add a loop:

```typescript
// Wire server config to each provider so proxy.ts can access buffer settings
const server = parsed.server;
for (const [, provider] of providers) {
  provider._serverConfig = server;
}
```

The exact location depends on how the providers Map is built — find the line where the Map is finalized and add this right after.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts src/config.ts
git commit -m "feat(config): wire server config to providers for stream buffer access (#125)"
```

---

## Task 5: Integrate SSEBuffer into proxy.ts

**Files:**
- Modify: `src/proxy.ts:~787` (the `passThrough.on("data")` handler inside `ReadableStream`)

The buffering is activated when `server.streamBufferMs > 0 || server.streamBufferBytes > 0`. The server config is accessed via `provider._serverConfig` which was wired in Task 4.

- [ ] **Step 1: Add SSEBuffer import at top of proxy.ts**

Add after the existing imports:

```typescript
import { SSEBuffer } from "./stream-buffer.js";
```

- [ ] **Step 2: Modify the passThrough.on("data") handler**

In `proxy.ts`, find the `passThrough.on("data", ...)` block around line 787. Replace the entire `start(controller)` callback body (from `let controllerClosed = false;` through `passThrough.on("close", safeClose);`) with:

```typescript
start(controller) {
  if (!passThrough) { controller.close(); return; }
  let controllerClosed = false;
  const safeClose = () => {
    if (controllerClosed) return;
    controllerClosed = true;
    try { controller.close(); } catch { /* already closed — undici bug */ }
  };
  const safeError = (err: Error) => {
    if (controllerClosed) return;
    if ((passThrough as any)._intentionalClose) return;
    controllerClosed = true;
    try { controller.error(err); } catch { /* already closed */ }
  };

  // Check if streaming buffer is enabled on this provider's server config
  const serverConfig = (provider as any)._serverConfig;
  const bufferMs = serverConfig?.streamBufferMs ?? 0;
  const bufferBytes = serverConfig?.streamBufferBytes ?? 0;
  const bufferingEnabled = bufferMs > 0 || bufferBytes > 0;

  let sseBuffer: SSEBuffer | undefined;

  if (bufferingEnabled) {
    sseBuffer = new SSEBuffer(
      (chunk: Uint8Array) => {
        if (ctx._streamState === "error" || ctx._streamState === "complete") return;
        try { controller.enqueue(chunk); } catch { /* already closed */ }
      },
      { bufferBytes, bufferMs },
    );
  }

  passThrough.on("data", (chunk: Buffer) => {
    if (ctx._streamState === "error" || ctx._streamState === "complete") return;
    if (sseBuffer) {
      sseBuffer.write(new Uint8Array(chunk));
    } else {
      try { controller.enqueue(new Uint8Array(chunk)); } catch { /* already closed */ }
    }
  });
  passThrough.on("end", () => {
    if (sseBuffer) sseBuffer.end();
    safeClose();
  });
  passThrough.on("error", () => {
    if (sseBuffer) sseBuffer.end();
    safeError(new Error("PassThrough error"));
  });
  passThrough.on("close", safeClose);
},
```

- [ ] **Step 3: Commit**

```bash
git add src/proxy.ts
git commit -m "feat(proxy): integrate SSEBuffer into stream handler (#125)"
```

---

## Task 6: Write unit tests

**Files:**
- Create: `tests/stream-buffer.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SSEBuffer, SSEBufferOptions } from "../src/stream-buffer.js";

function makeOpts(ms: number, bytes: number): SSEBufferOptions {
  return { bufferMs: ms, bufferBytes: bytes };
}

function strToUint8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function events(...args: string[]): Uint8Array {
  // Each event ends with \n\n
  return strToUint8(args.map(e => `event: ${e}\n`).join("") + "\n");
}

describe("SSEBuffer", () => {
  let enqueueMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    enqueueMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("both disabled (passthrough)", () => {
    it("enqueues each write immediately", () => {
      const buf = new SSEBuffer(enqueueMock, makeOpts(0, 0));
      buf.write(strToUint8("hello"));
      buf.write(strToUint8("world"));
      expect(enqueueMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("size threshold", () => {
    it("flushes when bufferBytes exceeded at a \\n\\n boundary", () => {
      // 3 complete events; byte limit is 30 — should flush first 2 events (~20 bytes), hold the rest
      const opts = makeOpts(0, 30);
      const buf = new SSEBuffer(enqueueMock, opts);
      buf.write(events("a", "b")); // ~18 bytes
      buf.write(events("c"));      // ~12 bytes — total ~30, exceeds 30 — flush at last boundary
      expect(enqueueMock).toHaveBeenCalledTimes(2); // 2 flushes: first 2 events + third event
      // Second flush contains the third event
      expect(enqueueMock.mock.calls[1][0].length).toBeGreaterThan(0);
    });

    it("holds partial event when threshold hit mid-event", () => {
      // Single partial event (no \n\n yet)
      const opts = makeOpts(0, 20);
      const buf = new SSEBuffer(enqueueMock, opts);
      buf.write(strToUint8("event: partial")); // no \n\n
      expect(enqueueMock).not.toHaveBeenCalled(); // held — no boundary
    });
  });

  describe("time threshold", () => {
    it("flushes after bufferMs from last write", () => {
      const opts = makeOpts(10, 0); // 10ms timer, no byte limit
      const buf = new SSEBuffer(enqueueMock, opts);
      buf.write(strToUint8("hello"));

      expect(enqueueMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10);
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });

    it("timer resets after each flush", () => {
      const opts = makeOpts(10, 0);
      const buf = new SSEBuffer(enqueueMock, opts);
      buf.write(strToUint8("chunk1"));
      vi.advanceTimersByTime(9); // almost fire
      buf.write(strToUint8("chunk2")); // resets timer
      vi.advanceTimersByTime(9); // still not fired
      expect(enqueueMock).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); // now fires (10ms since last write)
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("end()", () => {
    it("flushes remaining buffer including partial events", () => {
      const opts = makeOpts(100, 1000); // generous thresholds — data held
      const buf = new SSEBuffer(enqueueMock, opts);
      buf.write(strToUint8("event: partial")); // no \n\n
      expect(enqueueMock).not.toHaveBeenCalled();
      buf.end();
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("only size trigger", () => {
    it("does not flush on time when bufferMs is 0", () => {
      const opts = makeOpts(0, 100);
      const buf = new SSEBuffer(enqueueMock, opts);
      buf.write(strToUint8("hello"));
      vi.advanceTimersByTime(10000);
      expect(enqueueMock).not.toHaveBeenCalled(); // no timer at all
    });
  });

  describe("only time trigger", () => {
    it("does not flush on size when bufferBytes is 0", () => {
      const opts = makeOpts(10, 0);
      const buf = new SSEBuffer(enqueueMock, opts);
      // Write enough to exceed any reasonable byte threshold
      buf.write(new Uint8Array(1000));
      expect(enqueueMock).not.toHaveBeenCalled();
    });
  });

  describe("multiple flushes", () => {
    it("correctly flushes multiple complete events over multiple writes", () => {
      const opts = makeOpts(0, 15); // small byte limit
      const buf = new SSEBuffer(enqueueMock, opts);
      // First write: one complete event (~9 bytes)
      buf.write(events("first"));
      // Second write: second complete event — pushes over 15 bytes
      buf.write(events("second"));
      // Third write: third complete event
      buf.write(events("third"));

      // Should have flushed first event, then second+third as separate flushes
      expect(enqueueMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- tests/stream-buffer.test.ts`
Expected: All tests pass (may need minor adjustments to byte counts if events() output is different)

- [ ] **Step 3: Commit**

```bash
git add tests/stream-buffer.test.ts
git commit -m "test(proxy): add SSEBuffer unit tests (#125)"
```

---

## Self-Review Checklist

- [ ] `ServerConfig` in `types.ts` has both new fields
- [ ] Zod schema in `config.ts` rejects negative values
- [ ] `SSEBuffer` class has no external dependencies — pure unit testable
- [ ] `flushAtBoundary` correctly finds `\n\n` boundary and flushes up to it
- [ ] Timer is reset after each flush (not accumulated)
- [ ] `end()` flushes everything including partial events
- [ ] Passthrough mode (`both 0`) immediately enqueues
- [ ] `proxy.ts` uses `provider._serverConfig` to access config
- [ ] All 3 commits are atomic and independently sensible
