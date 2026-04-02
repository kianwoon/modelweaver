// tests/adaptive-timeout.test.ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { resolveAdaptiveTTFB } from "../src/adaptive-timeout.js";
import { LatencyTracker } from "../src/hedging.js";
import { recordHealthEvent, clearHealthScores } from "../src/health-score.js";
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

  it("returns adaptive (tightened) TTFB when provider is consistently fast", () => {
    const provider = makeProvider({ ttfbTimeout: 8000 });

    // Provider consistently responds in ~500ms with low variance
    for (let i = 0; i < 10; i++) {
      tracker.record("test", 450 + Math.floor(Math.random() * 100));
    }

    const result = resolveAdaptiveTTFB(provider, tracker);

    // p95 approximation should be well below the static 8000
    expect(result).toBeLessThan(8000);
    // But should respect the floor of 2000ms
    expect(result).toBeGreaterThanOrEqual(2000);
    // Adaptive timeout should be the floor (p95 ≈ 600ms < 2000ms floor)
    expect(result).toBe(2000);
  });

  it("never goes below 2000ms floor", () => {
    const provider = makeProvider({ ttfbTimeout: 8000 });

    // Extremely fast provider — all responses under 200ms
    for (let i = 0; i < 10; i++) {
      tracker.record("test", 100 + Math.floor(Math.random() * 50));
    }

    const result = resolveAdaptiveTTFB(provider, tracker);
    expect(result).toBe(2000); // floor
  });

  it("never exceeds static configured value", () => {
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
    expect(result).toBeLessThanOrEqual(5000); // capped at configured value
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

    // Fast provider should have a tighter timeout
    expect(fastTimeout).toBeLessThan(slowTimeout);
    // Neither should exceed their configured static values
    expect(fastTimeout).toBeLessThanOrEqual(8000);
    expect(slowTimeout).toBeLessThanOrEqual(10000);

    tracker.clear("fast");
    tracker.clear("slow");
  });
});

describe("resolveAdaptiveTTFB — health score composition", () => {
  const tracker = new LatencyTracker(30);

  beforeEach(() => {
    clearHealthScores();
  });

  afterEach(() => {
    clearHealthScores();
    tracker.clear("test");
  });

  it("reduces TTFB for unhealthy provider even with no latency data", () => {
    const provider = makeProvider({ name: "sick", ttfbTimeout: 10000 });

    // Make provider unhealthy (50% success rate)
    for (let i = 0; i < 20; i++) {
      recordHealthEvent("sick", i % 2 === 0, 300);
    }

    const result = resolveAdaptiveTTFB(provider, tracker);
    // No latency data → latency-based falls back to 10000
    // Health-based: 0.5 × 10000 = 5000
    // min(10000, 5000) = 5000
    expect(result).toBeLessThanOrEqual(5000);
    expect(result).toBeGreaterThan(0);
  });

  it("health score floor at 20% prevents too-aggressive timeout", () => {
    const provider = makeProvider({ name: "dead", ttfbTimeout: 10000 });

    // Make provider score near 0 (all failures)
    for (let i = 0; i < 20; i++) {
      recordHealthEvent("dead", false, 30000);
    }

    const result = resolveAdaptiveTTFB(provider, tracker);
    // Health-based: max(0, 0.2) × 10000 = 2000 (floor)
    // min(10000, 2000) = 2000
    expect(result).toBe(2000);
  });

  it("takes min of latency-based and health-based signals", () => {
    const provider = makeProvider({ name: "combo", ttfbTimeout: 10000 });

    // Latency data: consistently ~300ms → latency-based = floor = 2000
    for (let i = 0; i < 10; i++) {
      tracker.record("combo", 300);
    }

    // Health data: 100% healthy → health-based = 10000 (full)
    for (let i = 0; i < 10; i++) {
      recordHealthEvent("combo", true, 300);
    }

    const result = resolveAdaptiveTTFB(provider, tracker);
    // Latency-based: 2000 (floor), Health-based: 10000 (full)
    // min(2000, 10000) = 2000
    expect(result).toBe(2000);
  });

  it("healthy provider with no latency data uses static TTFB", () => {
    const provider = makeProvider({ name: "healthy", ttfbTimeout: 15000 });

    // No latency data, no health data
    const result = resolveAdaptiveTTFB(provider, tracker);
    expect(result).toBe(15000);
  });
});
