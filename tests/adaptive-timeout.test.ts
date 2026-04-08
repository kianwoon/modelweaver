// tests/adaptive-timeout.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { resolveAdaptiveTTFB, TimeoutBoostManager } from "../src/adaptive-timeout.js";
import type { TimeoutErrorType } from "../src/adaptive-timeout.js";
import { LatencyTracker } from "../src/hedging.js";
import type { ProviderConfig } from "../src/types.js";

function makeProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: "test",
    baseUrl: "http://localhost:9999",
    apiKey: "test",
    timeout: 20000,
    ...overrides,
  };
}

describe("resolveAdaptiveTTFB", () => {
  const tracker = new LatencyTracker(30);

  afterEach(() => {
    tracker.clear("test");
  });

  it("returns static value when fewer than 5 samples", () => {
    const provider = makeProvider({ ttfbTimeout: 8000 });

    // Only 3 samples — not enough for adaptive
    tracker.record("test", 1500);
    tracker.record("test", 1600);
    tracker.record("test", 1700);

    const result = resolveAdaptiveTTFB(provider, tracker);
    expect(result).toBe(8000); // falls back to static
  });

  it("returns configured TTFB (floor) when provider is consistently fast", () => {
    const provider = makeProvider({ ttfbTimeout: 8000 });

    // Provider consistently responds in ~500ms with low variance
    for (let i = 0; i < 10; i++) {
      tracker.record("test", 450 + Math.floor(Math.random() * 100));
    }

    const result = resolveAdaptiveTTFB(provider, tracker);

    // Config is the floor — p95 can only raise, never lower the timeout
    expect(result).toBe(8000);
  });

  it("configured value is always the minimum", () => {
    const provider = makeProvider({ ttfbTimeout: 8000 });

    // Extremely fast provider — all responses under 200ms
    for (let i = 0; i < 10; i++) {
      tracker.record("test", 100 + Math.floor(Math.random() * 50));
    }

    const result = resolveAdaptiveTTFB(provider, tracker);
    expect(result).toBe(8000); // config is the floor, p95 cannot lower it
  });

  it("adapts upward when p95 exceeds configured value", () => {
    const provider = makeProvider({ ttfbTimeout: 5000 });

    // Provider with high variance — some slow responses
    tracker.record("test", 1000);
    tracker.record("test", 2000);
    tracker.record("test", 3000);
    tracker.record("test", 4000);
    tracker.record("test", 5000);
    tracker.record("test", 6000);
    tracker.record("test", 7000);
    tracker.record("test", 8000);
    tracker.record("test", 9000);
    tracker.record("test", 10000);

    const result = resolveAdaptiveTTFB(provider, tracker);
    // p95 exceeds configured 5000ms → timeout should be raised
    expect(result).toBeGreaterThan(5000);
  });

  it("defaults to 8000ms when ttfbTimeout not configured", () => {
    const provider = makeProvider({}); // no ttfbTimeout

    // No samples at all
    const result = resolveAdaptiveTTFB(provider, tracker);
    expect(result).toBe(8000);
  });

  it("falls back to static when provider has no samples", () => {
    const provider = makeProvider({ ttfbTimeout: 6000 });

    const result = resolveAdaptiveTTFB(provider, tracker);
    expect(result).toBe(6000);
  });

  it("adapts independently per provider", () => {
    const fastProvider = makeProvider({ name: "fast", ttfbTimeout: 8000 });
    const slowProvider = makeProvider({ name: "slow", ttfbTimeout: 10000 });

    // Fast provider: ~300ms TTFB
    for (let i = 0; i < 10; i++) {
      tracker.record("fast", 250 + Math.floor(Math.random() * 100));
    }
    // Slow provider: ~2000ms TTFB
    for (let i = 0; i < 10; i++) {
      tracker.record("slow", 1800 + Math.floor(Math.random() * 400));
    }

    const fastTimeout = resolveAdaptiveTTFB(fastProvider, tracker);
    const slowTimeout = resolveAdaptiveTTFB(slowProvider, tracker);

    // Fast provider should have a timeout equal to its configured value
    expect(fastTimeout).toBe(8000);
    // Slow provider: p95 may exceed configured 10000ms, so timeout adapts upward
    expect(slowTimeout).toBeGreaterThanOrEqual(10000);

    tracker.clear("fast");
    tracker.clear("slow");
  });
});

describe("resolveAdaptiveTTFB — health score no longer shrinks TTFB", () => {
  const tracker = new LatencyTracker(30);

  afterEach(() => {
    tracker.clear("test");
  });

  it("returns configured TTFB when no latency data regardless of provider health", () => {
    // Previously, an unhealthy provider would get a shortened TTFB.
    // Now health score is ignored — only latency data matters.
    const provider = makeProvider({ name: "sick", ttfbTimeout: 15000 });

    // No latency samples → should return configured value as-is
    const result = resolveAdaptiveTTFB(provider, tracker);
    expect(result).toBe(15000);
  });

  it("latency-based adaptation only raises, never lowers", () => {
    const provider = makeProvider({ name: "fast", ttfbTimeout: 15000 });

    // Consistently fast ~500ms TTFB
    for (let i = 0; i < 10; i++) {
      tracker.record("fast", 450 + Math.floor(Math.random() * 100));
    }

    const result = resolveAdaptiveTTFB(provider, tracker);
    // Config is the floor — fast p95 cannot lower it
    expect(result).toBe(15000);

    tracker.clear("fast");
  });

  it("slow provider keeps full configured TTFB when no latency samples", () => {
    const provider = makeProvider({ ttfbTimeout: 15000 });

    // No samples at all — returns configured value
    const result = resolveAdaptiveTTFB(provider, tracker);
    expect(result).toBe(15000);
  });
});

describe("TimeoutBoostManager", () => {
  const makeProvider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
    name: "test-provider",
    baseUrl: "https://api.test.com",
    apiKey: "test-key",
    timeout: 30000,
    ttfbTimeout: 10000,
    stallTimeout: 15000,
    ...overrides,
  });

  test("does not boost below threshold (4 errors)", () => {
    const mgr = new TimeoutBoostManager();
    const provider = makeProvider();
    for (let i = 0; i < 4; i++) {
      mgr.recordTimeoutError(provider, "ttfb");
    }
    expect(provider.ttfbTimeout).toBe(10000);
  });

  test("boosts ttfbTimeout by 50% after 5 errors within 10 min", () => {
    const mgr = new TimeoutBoostManager();
    const provider = makeProvider();
    for (let i = 0; i < 5; i++) {
      mgr.recordTimeoutError(provider, "ttfb");
    }
    expect(provider.ttfbTimeout).toBe(15000);
    expect(provider.timeout).toBe(30000);
    expect(provider.stallTimeout).toBe(15000);
  });

  test("boosts stallTimeout by 50% after 5 stall errors", () => {
    const mgr = new TimeoutBoostManager();
    const provider = makeProvider();
    for (let i = 0; i < 5; i++) {
      mgr.recordTimeoutError(provider, "stall");
    }
    expect(provider.stallTimeout).toBe(22500);
    expect(provider.ttfbTimeout).toBe(10000);
    expect(provider.timeout).toBe(30000);
  });

  test("boosts total timeout by 50% after 5 timeout errors", () => {
    const mgr = new TimeoutBoostManager();
    const provider = makeProvider();
    for (let i = 0; i < 5; i++) {
      mgr.recordTimeoutError(provider, "timeout");
    }
    expect(provider.timeout).toBe(45000);
  });

  test("caps boost at 50% even with more errors", () => {
    const mgr = new TimeoutBoostManager();
    const provider = makeProvider();
    for (let i = 0; i < 15; i++) {
      mgr.recordTimeoutError(provider, "ttfb");
    }
    expect(provider.ttfbTimeout).toBe(15000);
  });

  test("hard resets after 10 min of no errors", () => {
    const mgr = new TimeoutBoostManager({ now: () => 0 });
    const provider = makeProvider();
    for (let i = 0; i < 5; i++) {
      mgr.recordTimeoutError(provider, "ttfb");
    }
    expect(provider.ttfbTimeout).toBe(15000);
    mgr["now"] = () => 601_000;
    mgr.checkReset(provider);
    expect(provider.ttfbTimeout).toBe(10000);
  });

  test("does not reset while errors still arriving within window", () => {
    const mgr = new TimeoutBoostManager({ now: () => 0 });
    const provider = makeProvider();
    for (let i = 0; i < 5; i++) {
      mgr.recordTimeoutError(provider, "ttfb");
    }
    expect(provider.ttfbTimeout).toBe(15000);
    mgr["now"] = () => 300_000;
    mgr.recordTimeoutError(provider, "ttfb");
    mgr["now"] = () => 601_000;
    mgr.checkReset(provider);
    expect(provider.ttfbTimeout).toBe(15000);
  });

  test("resets when last error is older than cooldown", () => {
    const mgr = new TimeoutBoostManager({ now: () => 0 });
    const provider = makeProvider();
    for (let i = 0; i < 5; i++) {
      mgr.recordTimeoutError(provider, "ttfb");
    }
    mgr["now"] = () => 660_000;
    mgr.checkReset(provider);
    expect(provider.ttfbTimeout).toBe(10000);
  });

  test("per-provider independence", () => {
    const mgr = new TimeoutBoostManager();
    const p1 = makeProvider({ name: "p1", ttfbTimeout: 10000 });
    const p2 = makeProvider({ name: "p2", ttfbTimeout: 20000 });
    for (let i = 0; i < 5; i++) {
      mgr.recordTimeoutError(p1, "ttfb");
    }
    expect(p1.ttfbTimeout).toBe(15000);
    expect(p2.ttfbTimeout).toBe(20000);
  });

  test("each timeout type tracked independently", () => {
    const mgr = new TimeoutBoostManager();
    const provider = makeProvider({ timeout: 30000, ttfbTimeout: 10000, stallTimeout: 15000 });
    for (let i = 0; i < 5; i++) mgr.recordTimeoutError(provider, "ttfb");
    for (let i = 0; i < 3; i++) mgr.recordTimeoutError(provider, "stall");
    expect(provider.ttfbTimeout).toBe(15000);
    expect(provider.stallTimeout).toBe(15000);
    expect(provider.timeout).toBe(30000);
  });

  test("expired errors pruned from window", () => {
    const mgr = new TimeoutBoostManager({ now: () => 0 });
    const provider = makeProvider({ ttfbTimeout: 10000 });
    for (let i = 0; i < 5; i++) {
      mgr.recordTimeoutError(provider, "ttfb");
    }
    expect(provider.ttfbTimeout).toBe(15000);
    mgr["now"] = () => 660_000;
    mgr.checkReset(provider);
    expect(provider.ttfbTimeout).toBe(10000);
    for (let i = 0; i < 3; i++) {
      mgr.recordTimeoutError(provider, "ttfb");
    }
    expect(provider.ttfbTimeout).toBe(10000);
  });
});
