import { describe, it, expect, beforeEach } from "vitest";
import {
  LatencyTracker,
  InFlightCounter,
  latencyTracker,
  inFlightCounter,
  computeHedgingCount,
  recordHedgeWin,
  recordHedgeLosses,
  getHedgeStats,
  clearHedgeStats,
} from "../src/hedging.js";
import type { ProviderConfig } from "../src/types.js";

describe("LatencyTracker", () => {
  let tracker: LatencyTracker;
  beforeEach(() => {
    tracker = new LatencyTracker(10);
  });

  it("returns 0 CV with insufficient data (< 5 samples)", () => {
    for (let i = 0; i < 4; i++) tracker.record("p1", 100);
    expect(tracker.getCV("p1")).toBe(0);
  });

  it("computes CV with enough varied samples", () => {
    tracker.record("p2", 50);
    tracker.record("p2", 100);
    tracker.record("p2", 150);
    tracker.record("p2", 200);
    tracker.record("p2", 250);
    expect(tracker.getCV("p2")).toBeGreaterThan(0);
  });

  it("returns stats with count, mean, cv", () => {
    tracker.record("p1", 100);
    tracker.record("p1", 200);
    const stats = tracker.getStats("p1");
    expect(stats.count).toBe(2);
    expect(stats.mean).toBe(150);
  });

  it("evicts oldest samples when exceeding maxSize", () => {
    for (let i = 0; i < 15; i++) tracker.record("p1", i * 10);
    expect(tracker.getStats("p1").count).toBe(10);
  });

  it("prunes providers not in active list", () => {
    tracker.record("keep", 100);
    tracker.record("remove", 200);
    tracker.prune(["keep"]);
    expect(tracker.getStats("remove").count).toBe(0);
  });
});

describe("InFlightCounter", () => {
  let counter: InFlightCounter;
  beforeEach(() => {
    counter = new InFlightCounter();
  });

  it("increments and decrements correctly", () => {
    expect(counter.get("p1")).toBe(0);
    counter.increment("p1");
    expect(counter.get("p1")).toBe(1);
    counter.decrement("p1");
    expect(counter.get("p1")).toBe(0);
  });

  it("never goes below zero", () => {
    counter.decrement("p1");
    expect(counter.get("p1")).toBe(0);
  });
});

describe("computeHedgingCount", () => {
  const baseProvider: ProviderConfig = {
    name: "test-provider",
    baseUrl: "https://api.example.com",
    apiKey: "test",
    timeout: 60000,
    concurrentLimit: 4,
  };

  beforeEach(() => {
    latencyTracker.clear("test-provider");
    for (let i = 0; i < 5; i++) latencyTracker.record("test-provider", 100);
    while (inFlightCounter.get("test-provider") > 0) inFlightCounter.decrement("test-provider");
  });

  it("returns 1 when CV is below threshold", () => {
    expect(computeHedgingCount(baseProvider)).toBe(1);
  });

  it("returns > 1 when CV exceeds threshold", () => {
    latencyTracker.clear("test-provider");
    for (let i = 0; i < 5; i++) latencyTracker.record("test-provider", 10 + i * 1000);
    const stats = latencyTracker.getStats("test-provider");
    console.log("DEBUG: stats =", JSON.stringify(stats));
    expect(computeHedgingCount(baseProvider)).toBeGreaterThan(1);
  });

  it("respects maxHedge config", () => {
    latencyTracker.clear("test-provider");
    for (let i = 0; i < 5; i++) latencyTracker.record("test-provider", 10 + i * 500);
    expect(computeHedgingCount(baseProvider, { maxHedge: 2 })).toBeLessThanOrEqual(2);
  });
});

describe("hedge win/loss stats", () => {
  beforeEach(() => {
    clearHedgeStats();
  });

  it("tracks wins and losses per provider", () => {
    recordHedgeWin("p1");
    recordHedgeLosses("p1", 2);
    const stats = getHedgeStats("p1");
    expect(stats.hedgeWins).toBe(1);
    expect(stats.hedgeLosses).toBe(2);
  });

  it("returns zeros for unknown provider", () => {
    expect(getHedgeStats("unknown")).toEqual({ hedgeWins: 0, hedgeLosses: 0 });
  });

  it("clears all stats", () => {
    recordHedgeWin("p1");
    clearHedgeStats();
    expect(getHedgeStats("p1")).toEqual({ hedgeWins: 0, hedgeLosses: 0 });
  });
});

// --- Edge-case tests ---

describe("LatencyTracker edge cases", () => {
  it("enforces MAX_PROVIDERS cap by evicting oldest provider", () => {
    const tracker = new LatencyTracker(10);
    // Fill 50 providers (the MAX_PROVIDERS limit)
    for (let i = 0; i < 50; i++) {
      tracker.record(`provider-${i}`, 100);
    }
    // All 50 providers should exist, each with 1 sample
    expect(tracker.getStats("provider-0").count).toBe(1);
    expect(tracker.getStats("provider-49").count).toBe(1);

    // Adding a 51st provider should evict the first one (provider-0)
    tracker.record("provider-50", 200);
    expect(tracker.getStats("provider-0").count).toBe(0);
    expect(tracker.getStats("provider-50").count).toBe(1);
    // Other providers should still exist
    expect(tracker.getStats("provider-1").count).toBe(1);
  });

  it("getStats returns cv=0 when samples < 5", () => {
    const tracker = new LatencyTracker(30);
    tracker.record("p1", 10);
    tracker.record("p1", 200);
    const stats = tracker.getStats("p1");
    expect(stats.count).toBe(2);
    expect(stats.cv).toBe(0);
  });

  it("getCV returns 0 when all values are identical (variance is 0)", () => {
    const tracker = new LatencyTracker(30);
    for (let i = 0; i < 5; i++) tracker.record("p1", 100);
    expect(tracker.getCV("p1")).toBe(0);
  });

  it("getCV returns 0 when mean is 0", () => {
    const tracker = new LatencyTracker(30);
    for (let i = 0; i < 5; i++) tracker.record("p1", 0);
    expect(tracker.getCV("p1")).toBe(0);
  });
});

describe("InFlightCounter edge cases", () => {
  it("tracks multiple providers independently", () => {
    const counter = new InFlightCounter();
    counter.increment("p1");
    counter.increment("p1");
    counter.increment("p2");
    counter.increment("p2");
    counter.increment("p2");
    expect(counter.get("p1")).toBe(2);
    expect(counter.get("p2")).toBe(3);
  });

  it("increment returns the new count", () => {
    const counter = new InFlightCounter();
    expect(counter.increment("p1")).toBe(1);
    expect(counter.increment("p1")).toBe(2);
    expect(counter.increment("p1")).toBe(3);
  });
});

describe("computeHedgingCount edge cases", () => {
  const provider: ProviderConfig = {
    name: "hedge-test",
    baseUrl: "https://api.example.com",
    apiKey: "test",
    timeout: 60000,
    concurrentLimit: 4,
  };

  beforeEach(() => {
    latencyTracker.clear("hedge-test");
    while (inFlightCounter.get("hedge-test") > 0) inFlightCounter.decrement("hedge-test");
  });

  it("respects custom cvThreshold", () => {
    // Record 5 samples with moderate variance — CV will be around 0.5-0.6
    latencyTracker.clear("hedge-test");
    for (let i = 0; i < 5; i++) latencyTracker.record("hedge-test", 50 + i * 80);

    // With default threshold 0.5, this should hedge (> 0.5)
    const withDefault = computeHedgingCount(provider);
    expect(withDefault).toBeGreaterThan(1);

    // With a very high threshold, it should NOT hedge
    const withHighThreshold = computeHedgingCount(provider, { cvThreshold: 10 });
    expect(withHighThreshold).toBe(1);
  });

  it("caps result to 1 when available=1 regardless of CV", () => {
    latencyTracker.clear("hedge-test");
    // High variance samples
    for (let i = 0; i < 5; i++) latencyTracker.record("hedge-test", 10 + i * 500);

    // Fill all 4 concurrent slots so available = 1
    inFlightCounter.increment("hedge-test");
    inFlightCounter.increment("hedge-test");
    inFlightCounter.increment("hedge-test");

    // 3 in flight, concurrentLimit=4, available=1 → must return 1
    expect(computeHedgingCount(provider)).toBe(1);

    // Clean up
    while (inFlightCounter.get("hedge-test") > 0) inFlightCounter.decrement("hedge-test");
  });

  it("properly subtracts inFlight from concurrentLimit", () => {
    latencyTracker.clear("hedge-test");
    // Very high variance to get max hedging
    for (let i = 0; i < 5; i++) latencyTracker.record("hedge-test", 10 + i * 2000);

    // No in-flight → full slots available
    const none = computeHedgingCount(provider);
    // 1 in-flight
    inFlightCounter.increment("hedge-test");
    const one = computeHedgingCount(provider);
    // 2 in-flight
    inFlightCounter.increment("hedge-test");
    const two = computeHedgingCount(provider);

    expect(two).toBeLessThanOrEqual(none);
    expect(two).toBeLessThanOrEqual(one);

    // Clean up
    while (inFlightCounter.get("hedge-test") > 0) inFlightCounter.decrement("hedge-test");
  });
});

describe("recordHedgeWin/Loss cumulative edge cases", () => {
  beforeEach(() => {
    clearHedgeStats();
  });

  it("accumulates wins across multiple calls", () => {
    recordHedgeWin("p1");
    recordHedgeWin("p1");
    recordHedgeWin("p1");
    expect(getHedgeStats("p1").hedgeWins).toBe(3);
    expect(getHedgeStats("p1").hedgeLosses).toBe(0);
  });

  it("accumulates losses across multiple calls", () => {
    recordHedgeLosses("p1", 1);
    recordHedgeLosses("p1", 3);
    recordHedgeLosses("p1", 2);
    expect(getHedgeStats("p1").hedgeLosses).toBe(6);
    expect(getHedgeStats("p1").hedgeWins).toBe(0);
  });

  it("tracks multiple providers independently", () => {
    recordHedgeWin("p1");
    recordHedgeLosses("p1", 2);
    recordHedgeWin("p2");
    recordHedgeLosses("p2", 5);
    recordHedgeWin("p1");

    expect(getHedgeStats("p1")).toEqual({ hedgeWins: 2, hedgeLosses: 2 });
    expect(getHedgeStats("p2")).toEqual({ hedgeWins: 1, hedgeLosses: 5 });
  });
});
