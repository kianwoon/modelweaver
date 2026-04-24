/**
 * Benchmark: Streaming hotpath performance
 *
 * Measures the specific optimizations from Tier 1 + Tier 2:
 * - #317: chunk.toString("utf8") deduplication
 * - #318: rolling tail early exit
 * - #319: eventBuf array collector
 * - #322: p50 cache in LatencyTracker
 */
import { describe, it, expect } from "vitest";
import { LatencyTracker } from "../src/hedging.js";

// ── Helper: generate realistic SSE chunks ──────────────────────────────
function generateSSEChunks(eventCount: number): Buffer[] {
  const chunks: Buffer[] = [];
  // message_start
  chunks.push(Buffer.from(`event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"usage":{"input_tokens":100,"output_tokens":0}}}\n\n`));
  // content_block_start
  chunks.push(Buffer.from(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`));

  // content_block_delta events (the bulk of the stream)
  for (let i = 0; i < eventCount; i++) {
    const text = `This is sample text delta ${i} with some realistic content. `;
    chunks.push(Buffer.from(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\n`));
  }

  // content_block_stop
  chunks.push(Buffer.from(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`));
  // message_delta + message_stop
  chunks.push(Buffer.from(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${eventCount * 10}}}\n\n`));
  chunks.push(Buffer.from(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));

  return chunks;
}

// ── Benchmark: Data handler state tracking (#317 + #318) ──────────────
describe("Benchmark: streaming data handler", () => {
  it("measures per-chunk processing cost with realistic SSE stream", () => {
    const chunks = generateSSEChunks(200); // ~206 chunks total
    const ITERATIONS = 100;

    // Warmup
    for (let i = 0; i < 5; i++) {
      let sawMessageStart = false, sawContentBlockStart = false;
      let sawContentBlockStop = false, sawMessageStop = false, sawRealContent = false;
      let _rollingTail = "";
      let bytesForwarded = 0;

      for (const chunk of chunks) {
        bytesForwarded += chunk.length;
        const chunkText = chunk.toString("utf8");
        if (!sawMessageStop) {
          if (!sawMessageStart || !sawContentBlockStart || !sawContentBlockStop) {
            _rollingTail = (_rollingTail + chunkText).slice(-500);
            if (!sawMessageStart && _rollingTail.includes('"message_start"')) sawMessageStart = true;
            if (!sawContentBlockStart && _rollingTail.includes('"content_block_start"')) sawContentBlockStart = true;
            if (!sawContentBlockStop && _rollingTail.includes('"content_block_stop"')) sawContentBlockStop = true;
          }
          if (chunkText.includes('"message_stop"')) sawMessageStop = true;
          if (!sawRealContent && chunkText.includes('"text_delta"')) sawRealContent = true;
        }
      }
    }

    // Benchmark: optimized path (#317 + #318)
    const startOpt = performance.now();
    for (let iter = 0; iter < ITERATIONS; iter++) {
      let sawMessageStart = false, sawContentBlockStart = false;
      let sawContentBlockStop = false, sawMessageStop = false, sawRealContent = false;
      let _rollingTail = "";
      let bytesForwarded = 0;

      for (const chunk of chunks) {
        bytesForwarded += chunk.length;
        const chunkText = chunk.toString("utf8"); // Single decode (#317)
        if (!sawMessageStop) {
          // Early exit when flags are set (#318)
          if (!sawMessageStart || !sawContentBlockStart || !sawContentBlockStop) {
            _rollingTail = (_rollingTail + chunkText).slice(-500);
            if (!sawMessageStart && _rollingTail.includes('"message_start"')) sawMessageStart = true;
            if (!sawContentBlockStart && _rollingTail.includes('"content_block_start"')) sawContentBlockStart = true;
            if (!sawContentBlockStop && _rollingTail.includes('"content_block_stop"')) sawContentBlockStop = true;
          }
          if (chunkText.includes('"message_stop"')) sawMessageStop = true;
          if (!sawRealContent && chunkText.includes('"text_delta"')) sawRealContent = true;
        }
      }
    }
    const elapsedOpt = performance.now() - startOpt;

    // Benchmark: old path (triple decode + rolling tail on every chunk)
    const startOld = performance.now();
    for (let iter = 0; iter < ITERATIONS; iter++) {
      let sawMessageStart = false, sawContentBlockStart = false;
      let sawContentBlockStop = false, sawMessageStop = false, sawRealContent = false;
      let _rollingTail = "";
      let bytesForwarded = 0;

      for (const chunk of chunks) {
        bytesForwarded += chunk.length;
        const chunkText1 = chunk.toString("utf8"); // Decode 1
        if (!sawMessageStop) {
          _rollingTail = (_rollingTail + chunkText1).slice(-500); // Always concat+slice
          if (!sawMessageStart && _rollingTail.includes('"message_start"')) sawMessageStart = true;
          if (!sawContentBlockStart && _rollingTail.includes('"content_block_start"')) sawContentBlockStart = true;
          if (!sawContentBlockStop && _rollingTail.includes('"content_block_stop"')) sawContentBlockStop = true;
        }
        const chunkText2 = chunk.toString("utf8"); // Decode 2 (early empty detection)
        if (chunkText2.includes('"text_delta"')) sawRealContent = true;
        const chunkText3 = chunk.toString("utf8"); // Decode 3 (debug log)
        if (bytesForwarded <= chunk.length) { void chunkText3.slice(0, 400); }
      }
    }
    const elapsedOld = performance.now() - startOld;

    const speedup = ((elapsedOld - elapsedOpt) / elapsedOld * 100).toFixed(1);
    console.log(`\n  [Benchmark] Data handler (${chunks.length} chunks × ${ITERATIONS} iters):`);
    console.log(`    Old path:   ${elapsedOld.toFixed(1)}ms`);
    console.log(`    Optimized:  ${elapsedOpt.toFixed(1)}ms`);
    console.log(`    Speedup:    ${speedup}% faster`);

    // No strict assertion — micro-benchmarks are non-deterministic on CI runners
  });
});

// ── Benchmark: SSE event collection (#319) ─────────────────────────────
describe("Benchmark: SSE event collection", () => {
  function generateSSELines(eventCount: number): string[] {
    const lines: string[] = [];
    lines.push('event: message_start', 'data: {"type":"message_start"}', '');
    lines.push('event: content_block_start', 'data: {"type":"content_block_start"}', '');
    for (let i = 0; i < eventCount; i++) {
      lines.push('event: content_block_delta', `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"chunk ${i}"}}`, '');
    }
    lines.push('event: content_block_stop', 'data: {"type":"content_block_stop"}', '');
    lines.push('event: message_delta', 'data: {"type":"message_delta"}', '');
    lines.push('event: message_stop', 'data: {"type":"message_stop"}', '');
    return lines;
  }

  it("confirms string concatenation is faster than array collector for SSE events", () => {
    const lines = generateSSELines(200);
    const ITERATIONS = 500;

    // Warmup
    for (let i = 0; i < 10; i++) {
      let eventLines: string[] = [];
      for (const line of lines) {
        if (line === "") {
          if (eventLines.length > 0) { void eventLines.join("\n"); eventLines.length = 0; }
        } else { eventLines.push(line); }
      }
    }

    // Benchmark: array collector (#319)
    const startArr = performance.now();
    for (let iter = 0; iter < ITERATIONS; iter++) {
      let eventLines: string[] = [];
      const events: string[] = [];
      for (const line of lines) {
        if (line === "") {
          if (eventLines.length > 0) {
            events.push(eventLines.join("\n"));
            eventLines.length = 0;
          }
        } else {
          eventLines.push(line);
        }
      }
    }
    const elapsedArr = performance.now() - startArr;

    // Benchmark: string concatenation (old way)
    const startStr = performance.now();
    for (let iter = 0; iter < ITERATIONS; iter++) {
      let eventBuf = "";
      const events: string[] = [];
      for (const line of lines) {
        if (line === "") {
          if (eventBuf) {
            events.push(eventBuf);
            eventBuf = "";
          }
        } else {
          eventBuf += (eventBuf ? "\n" : "") + line;
        }
      }
    }
    const elapsedStr = performance.now() - startStr;

    const regression = ((elapsedArr - elapsedStr) / elapsedStr * 100).toFixed(1);
    console.log(`\n  [Benchmark] Event collection (${lines.length} lines × ${ITERATIONS} iters):`);
    console.log(`    String concat: ${elapsedStr.toFixed(1)}ms`);
    console.log(`    Array collect: ${elapsedArr.toFixed(1)}ms`);
    console.log(`    Regression:    ${regression}% slower (V8 optimizes small string concat)`);

    // No strict assertion — micro-benchmarks are non-deterministic on CI runners
  });
});

// ── Benchmark: p50 cache (#322) ────────────────────────────────────────
describe("Benchmark: LatencyTracker p50 cache", () => {
  it("measures cache hit vs recomputation", () => {
    const tracker = new LatencyTracker(30);
    // Fill with samples
    for (let i = 0; i < 30; i++) {
      tracker.record("provider-a", 100 + Math.random() * 200);
    }

    const ITERATIONS = 10000;

    // Warmup
    for (let i = 0; i < 100; i++) tracker.getP50("provider-a");

    // Benchmark: cached getP50 (after record, subsequent calls are cached)
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      tracker.getP50("provider-a");
    }
    const elapsedCached = performance.now() - start;

    // Benchmark: uncached (record invalidates cache each time)
    const startUncached = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      tracker.record("provider-b", 100 + i);
      tracker.getP50("provider-b");
    }
    const elapsedUncached = performance.now() - startUncached;

    // Benchmark: pure recomputation (no cache, simulate old code)
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) samples.push(100 + Math.random() * 200);
    const startRaw = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const sorted = [...samples].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      void (sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2));
    }
    const elapsedRaw = performance.now() - startRaw;

    const cacheSpeedup = ((elapsedRaw - elapsedCached) / elapsedRaw * 100).toFixed(1);
    console.log(`\n  [Benchmark] p50 lookup (${ITERATIONS} iterations):`);
    console.log(`    Cached (no invalidate): ${elapsedCached.toFixed(2)}ms`);
    console.log(`    Uncached (record+p50):  ${elapsedUncached.toFixed(2)}ms`);
    console.log(`    Raw recomputation:       ${elapsedRaw.toFixed(2)}ms`);
    console.log(`    Cache speedup:           ${cacheSpeedup}% faster vs raw`);

    // No strict assertion — micro-benchmarks are non-deterministic on CI runners
  });
});
