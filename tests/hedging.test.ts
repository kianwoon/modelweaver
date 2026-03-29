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
