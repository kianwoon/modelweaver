// tests/health-score.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { recordHealthEvent, getHealthScore, getAllHealthScores, pruneHealthScores, clearHealthScores } from "../src/health-score.js";

describe("health score basics", () => {
  beforeEach(() => {
    clearHealthScores();
  });

  afterEach(() => {
    clearHealthScores();
  });

  it("returns 1 (healthy) when no data exists", () => {
    expect(getHealthScore("unknown")).toBe(1);
  });

  it("returns 1 (healthy) when fewer than 5 events recorded", () => {
    for (let i = 0; i < 4; i++) {
      recordHealthEvent("provider-a", true, 500);
    }
    expect(getHealthScore("provider-a")).toBe(1);
  });

  it("returns near-1 for perfect success with fast responses", () => {
    for (let i = 0; i < 20; i++) {
      recordHealthEvent("fast-good", true, 300);
    }
    // successRate = 1.0, p99 ≈ 300, latencyScore = 1 - 300/30000 = 0.99
    expect(getHealthScore("fast-good")).toBeCloseTo(0.99, 1);
  });

  it("halves the score when success rate is 50%", () => {
    for (let i = 0; i < 20; i++) {
      recordHealthEvent("half-fail", i % 2 === 0, 300);
    }
    // successRate = 0.5, latencyScore ≈ 0.99 → score ≈ 0.495
    expect(getHealthScore("half-fail")).toBeCloseTo(0.495, 1);
  });

  it("penalizes slow p99 latency", () => {
    // 100% success but p99 = 15s (15000ms)
    for (let i = 0; i < 20; i++) {
      recordHealthEvent("slow", true, i < 19 ? 100 : 15000);
    }
    // successRate = 1.0, latencyScore = 1 - 15000/30000 = 0.5
    expect(getHealthScore("slow")).toBeCloseTo(0.5, 1);
  });

  it("returns 0 when all requests fail at max latency", () => {
    for (let i = 0; i < 20; i++) {
      recordHealthEvent("dead", false, 30000);
    }
    // successRate = 0, latencyScore = 0
    expect(getHealthScore("dead")).toBe(0);
  });

  it("caps events at MAX_EVENTS (100)", () => {
    for (let i = 0; i < 150; i++) {
      recordHealthEvent("capped", i % 2 === 0, 500);
    }
    const score = getHealthScore("capped");
    // Should reflect ~50% success rate of the last 100 events
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.6);
  });
});

describe("getAllHealthScores", () => {
  beforeEach(() => clearHealthScores());
  afterEach(() => clearHealthScores());

  it("returns Map with score for each requested provider", () => {
    for (let i = 0; i < 10; i++) {
      recordHealthEvent("p1", true, 200);
      recordHealthEvent("p2", false, 500);
    }
    const scores = getAllHealthScores(["p1", "p2", "unknown"]);
    expect(scores.size).toBe(3);
    expect(scores.get("p1")).toBeGreaterThan(0.9);
    expect(scores.get("p2")).toBeLessThan(0.5);
    expect(scores.get("unknown")).toBe(1); // no data → healthy
  });
});

describe("pruneHealthScores", () => {
  beforeEach(() => clearHealthScores());
  afterEach(() => clearHealthScores());

  it("removes providers not in active list", () => {
    for (let i = 0; i < 10; i++) {
      recordHealthEvent("active", true, 200);
      recordHealthEvent("stale", true, 200);
    }
    pruneHealthScores(["active"]);
    expect(getHealthScore("active")).toBeGreaterThan(0.5);
    expect(getHealthScore("stale")).toBe(1); // pruned → no data → 1
  });

  it("keeps active providers intact", () => {
    for (let i = 0; i < 10; i++) {
      recordHealthEvent("keep", true, 200);
    }
    pruneHealthScores(["keep"]);
    expect(getHealthScore("keep")).toBeGreaterThan(0.5);
  });
});
