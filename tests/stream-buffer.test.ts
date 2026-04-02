import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SSEBuffer } from "../src/stream-buffer.js";

const enc = new TextEncoder();

function sseEvent(name: string, data: string): Uint8Array {
  return enc.encode(`event: ${name}\ndata: ${data}\n\n`);
}

function raw(text: string): Uint8Array {
  return enc.encode(text);
}

describe("SSEBuffer", () => {
  let enqueue: ReturnType<typeof vi.fn<(chunk: Uint8Array) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    enqueue = vi.fn<(chunk: Uint8Array) => void>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passthrough: enqueues each write immediately when both opts are 0", () => {
    const buf = new SSEBuffer(enqueue, { bufferMs: 0, bufferBytes: 0 });
    buf.write(raw("hello"));
    buf.write(raw("world"));
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0][0]).toEqual(raw("hello"));
    expect(enqueue.mock.calls[1][0]).toEqual(raw("world"));
  });

  it("size threshold: flushes at \\n\\n boundary when bufferBytes exceeded", () => {
    const buf = new SSEBuffer(enqueue, { bufferMs: 0, bufferBytes: 25 });
    // Each event is ~22 bytes, two events ~44 bytes — exceeds 25
    const e1 = sseEvent("msg", "a"); // "event: msg\ndata: a\n\n" = 20 bytes
    const e2 = sseEvent("msg", "b"); // ~20 bytes

    buf.write(e1);
    // Not yet at threshold
    expect(enqueue).toHaveBeenCalledTimes(0);

    buf.write(e2);
    // Now at ~40 bytes, over 25 — should flush at last boundary
    expect(enqueue.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("holds partial event when size threshold hit mid-event", () => {
    const buf = new SSEBuffer(enqueue, { bufferMs: 0, bufferBytes: 20 });
    // No \n\n in this data
    buf.write(raw("event: partial data here"));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("time threshold: flushes after bufferMs", () => {
    const buf = new SSEBuffer(enqueue, { bufferMs: 10, bufferBytes: 0 });
    buf.write(raw("hello"));
    expect(enqueue).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toEqual(raw("hello"));
  });

  it("timer resets after each flush", () => {
    const buf = new SSEBuffer(enqueue, { bufferMs: 10, bufferBytes: 0 });
    buf.write(raw("chunk1"));
    vi.advanceTimersByTime(9); // almost fires
    buf.write(raw("chunk2")); // resets timer
    vi.advanceTimersByTime(9); // still not fired (9ms since last reset)
    expect(enqueue).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1); // now 10ms since last write → fires
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("end() flushes remaining buffer including partial events", () => {
    const buf = new SSEBuffer(enqueue, { bufferMs: 10000, bufferBytes: 10000 });
    buf.write(raw("event: partial")); // no \n\n
    expect(enqueue).not.toHaveBeenCalled();
    buf.end();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toEqual(raw("event: partial"));
  });

  it("only size trigger: no timer-based flush when bufferMs is 0", () => {
    const buf = new SSEBuffer(enqueue, { bufferMs: 0, bufferBytes: 100 });
    buf.write(raw("hello"));
    vi.advanceTimersByTime(100000); // way past any timer
    expect(enqueue).not.toHaveBeenCalled(); // no timer was ever set
  });

  it("only time trigger: no size-based flush when bufferBytes is 0", () => {
    const buf = new SSEBuffer(enqueue, { bufferMs: 10, bufferBytes: 0 });
    buf.write(new Uint8Array(1000)); // large data, but no byte limit
    expect(enqueue).not.toHaveBeenCalled(); // no size trigger
  });

  it("end() flushes all buffered events after multiple writes", () => {
    const buf = new SSEBuffer(enqueue, { bufferMs: 0, bufferBytes: 15 });
    buf.write(sseEvent("a", "1"));
    buf.write(sseEvent("b", "2"));
    buf.write(sseEvent("c", "3"));
    expect(enqueue).not.toHaveBeenCalled(); // boundary at ~18 beyond scan limit 15
    buf.end();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].length).toBeGreaterThan(50);
  });
});
