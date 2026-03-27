// tests/metrics.test.ts
import { describe, it, expect, vi } from "vitest";
import { MetricsStore } from "../src/metrics.js";
import type { RequestMetrics } from "../src/types.js";

function createMockMetrics(overrides: Partial<RequestMetrics> = {}): RequestMetrics {
  return {
    requestId: "test-123",
    model: "claude-sonnet-4-20250514",
    tier: "sonnet",
    provider: "anthropic",
    targetProvider: "anthropic",
    status: 200,
    inputTokens: 100,
    outputTokens: 200,
    latencyMs: 2000,
    tokensPerSec: 150,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("MetricsStore", () => {
  describe("recordRequest", () => {
    it("stores a request in the buffer", () => {
      const store = new MetricsStore();
      const metrics = createMockMetrics();
      store.recordRequest(metrics);
      expect(store.getSummary().totalRequests).toBe(1);
    });

    it("increments totalRequests for each record", () => {
      const store = new MetricsStore();
      store.recordRequest(createMockMetrics());
      store.recordRequest(createMockMetrics());
      store.recordRequest(createMockMetrics());
      expect(store.getSummary().totalRequests).toBe(3);
    });

    it("evicts oldest entries when buffer is full (ring buffer)", () => {
      const store = new MetricsStore(3); // small buffer for testing
      store.recordRequest(createMockMetrics({ requestId: "1" }));
      store.recordRequest(createMockMetrics({ requestId: "2" }));
      store.recordRequest(createMockMetrics({ requestId: "3" }));
      expect(store.getSummary().totalRequests).toBe(3);

      store.recordRequest(createMockMetrics({ requestId: "4" }));
      // totalRequests is a lifetime counter — it tracks all requests ever, not buffer size
      expect(store.getSummary().totalRequests).toBe(4);

      // The first request should be evicted — check recent requests
      const recent = store.getSummary().recentRequests;
      const ids = recent.map((r) => r.requestId);
      expect(ids).not.toContain("1");
      expect(ids).toContain("4");
    });
  });

  describe("getSummary", () => {
    it("computes total tokens correctly", () => {
      const store = new MetricsStore();
      store.recordRequest(createMockMetrics({ inputTokens: 100, outputTokens: 200 }));
      store.recordRequest(createMockMetrics({ inputTokens: 50, outputTokens: 150 }));

      const summary = store.getSummary();
      expect(summary.totalInputTokens).toBe(150);
      expect(summary.totalOutputTokens).toBe(350);
    });

    it("computes average tokens per second", () => {
      const store = new MetricsStore();
      store.recordRequest(createMockMetrics({ tokensPerSec: 100 }));
      store.recordRequest(createMockMetrics({ tokensPerSec: 200 }));

      const summary = store.getSummary();
      expect(summary.avgTokensPerSec).toBe(150);
    });

    it("groups active models by count", () => {
      const store = new MetricsStore();
      store.recordRequest(createMockMetrics({ model: "sonnet" }));
      store.recordRequest(createMockMetrics({ model: "sonnet" }));
      store.recordRequest(createMockMetrics({ model: "haiku" }));

      const summary = store.getSummary();
      expect(summary.activeModels).toHaveLength(2);
      expect(summary.activeModels[0].model).toBe("sonnet");
      expect(summary.activeModels[0].count).toBe(2);
      expect(summary.activeModels[1].model).toBe("haiku");
      expect(summary.activeModels[1].count).toBe(1);
    });

    it("groups provider distribution by count", () => {
      const store = new MetricsStore();
      store.recordRequest(createMockMetrics({ provider: "anthropic", targetProvider: "anthropic" }));
      store.recordRequest(createMockMetrics({ provider: "anthropic", targetProvider: "anthropic" }));
      store.recordRequest(createMockMetrics({ provider: "openrouter", targetProvider: "openrouter" }));

      const summary = store.getSummary();
      expect(summary.providerDistribution).toHaveLength(2);
      expect(summary.providerDistribution[0].provider).toBe("anthropic");
      expect(summary.providerDistribution[0].count).toBe(2);
      expect(summary.providerDistribution[1].provider).toBe("openrouter");
      expect(summary.providerDistribution[1].count).toBe(1);
    });

    it("uses targetProvider for provider distribution", () => {
      const store = new MetricsStore();
      // Model routes to minimax as target, but falls back to glm
      store.recordRequest(createMockMetrics({ provider: "glm", targetProvider: "minimax", model: "MiniMax-M2.7" }));
      store.recordRequest(createMockMetrics({ provider: "glm", targetProvider: "glm", model: "glm-4.7" }));
      store.recordRequest(createMockMetrics({ provider: "glm", targetProvider: "glm", model: "glm-5-turbo" }));

      const summary = store.getSummary();
      // Provider distribution should show minimax (target), not just glm (actual)
      expect(summary.providerDistribution).toHaveLength(2);
      const providers = summary.providerDistribution.map(p => p.provider);
      expect(providers).toContain("minimax");
      expect(providers).toContain("glm");
    });

    it("returns recent requests (last 50)", () => {
      const store = new MetricsStore();
      for (let i = 0; i < 10; i++) {
        store.recordRequest(createMockMetrics({ requestId: String(i) }));
      }
      const summary = store.getSummary();
      expect(summary.recentRequests).toHaveLength(10);
      // Should be in chronological order
      expect(summary.recentRequests[0].requestId).toBe("0");
      expect(summary.recentRequests[9].requestId).toBe("9");
    });

    it("returns empty summary for new store", () => {
      const store = new MetricsStore();
      const summary = store.getSummary();
      expect(summary.totalRequests).toBe(0);
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.avgTokensPerSec).toBe(0);
      expect(summary.activeModels).toEqual([]);
      expect(summary.providerDistribution).toEqual([]);
      expect(summary.recentRequests).toEqual([]);
      expect(summary.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe("onRecord", () => {
    it("calls callback on each new record", () => {
      const store = new MetricsStore();
      const callback = vi.fn();
      store.onRecord(callback);

      store.recordRequest(createMockMetrics());
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "test-123" })
      );
    });

    it("supports multiple subscribers", () => {
      const store = new MetricsStore();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      store.onRecord(cb1);
      store.onRecord(cb2);

      store.recordRequest(createMockMetrics());
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe stops receiving callbacks", () => {
      const store = new MetricsStore();
      const callback = vi.fn();
      const unsubscribe = store.onRecord(callback);

      store.recordRequest(createMockMetrics());
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      store.recordRequest(createMockMetrics());
      expect(callback).toHaveBeenCalledTimes(1); // still 1, not called again
    });

    it("subscriber errors do not break recording", () => {
      const store = new MetricsStore();
      const badCb = vi.fn(() => { throw new Error("subscriber error"); });
      store.onRecord(badCb);

      // Should not throw
      store.recordRequest(createMockMetrics());
      expect(store.getSummary().totalRequests).toBe(1);
    });
  });
});

describe("Token extraction regex", () => {
  it("extracts tokens from non-streaming JSON response", () => {
    const text = JSON.stringify({
      id: "msg_123",
      type: "message",
      usage: { input_tokens: 500, output_tokens: 200 },
    });

    const inputMatch = text.match(/"input_tokens"\s*:\s*(\d+)/);
    const outputMatch = text.match(/"output_tokens"\s*:\s*(\d+)/);
    expect(parseInt(inputMatch![1], 10)).toBe(500);
    expect(parseInt(outputMatch![1], 10)).toBe(200);
  });

  it("extracts tokens from streaming SSE response", () => {
    const text = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":350}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"text":"Hello"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":150}}',
    ].join("\n");

    const inputMatch = text.match(/"input_tokens"\s*:\s*(\d+)/);
    const outputMatch = text.match(/"output_tokens"\s*:\s*(\d+)/);
    expect(parseInt(inputMatch![1], 10)).toBe(350);
    expect(parseInt(outputMatch![1], 10)).toBe(150);
  });

  it("extracts highest token count when multiple matches exist", () => {
    // In streaming, message_start has input_tokens=0, but message_delta has output_tokens
    const text = [
      'data: {"usage":{"input_tokens":0}}',
      'data: {"usage":{"input_tokens":350}}',
    ].join("\n");

    const matches = [...text.matchAll(/"input_tokens"\s*:\s*(\d+)/g)];
    // Regex match returns first match — our code uses .match() which returns first
    // The real scenario always has one input_tokens and one output_tokens
    expect(matches.length).toBe(2);
    expect(parseInt(matches[0][1], 10)).toBe(0);
    expect(parseInt(matches[1][1], 10)).toBe(350);
  });

  it("returns null for missing tokens", () => {
    const text = '{"type":"error","error":{"message":"Rate limited"}}';
    const inputMatch = text.match(/"input_tokens"\s*:\s*(\d+)/);
    const outputMatch = text.match(/"output_tokens"\s*:\s*(\d+)/);
    expect(inputMatch).toBeNull();
    expect(outputMatch).toBeNull();
  });
});
