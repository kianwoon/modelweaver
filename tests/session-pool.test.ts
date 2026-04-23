// tests/session-pool.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionAgentPool } from "../src/session-pool.js";

describe("SessionAgentPool", () => {
  let pool: SessionAgentPool;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await pool?.destroy();
  });

  describe("idle TTL", () => {
    it("uses default 10-minute TTL", () => {
      pool = new SessionAgentPool();
      pool.get("sess-1", "claude-sonnet-4-6", "anthropic");
      // Advance past one sweep (60s) — session still well within 10min TTL
      vi.advanceTimersByTime(60_000);
      expect(pool.sessionCount).toBe(1);
      // Advance to 600s total — sweep fires, idle = 600s = 10min, NOT yet > TTL
      vi.advanceTimersByTime(540_000); // total: 600_000ms
      expect(pool.sessionCount).toBe(1);
      // Advance to 660s total — next sweep fires, idle = 660s > 10min TTL, swept
      vi.advanceTimersByTime(60_000); // total: 660_000ms
      expect(pool.sessionCount).toBe(0);
    });

    it("accepts custom TTL via constructor", () => {
      pool = new SessionAgentPool(30_000);
      pool.get("sess-1", "claude-sonnet-4-6", "anthropic");
      // Advance past first sweep (60s) — idle 60s > 30s TTL, session swept
      vi.advanceTimersByTime(60_000);
      expect(pool.sessionCount).toBe(0);
    });
  });

  describe("getStats()", () => {
    it("returns empty array for no sessions", () => {
      pool = new SessionAgentPool();
      expect(pool.getStats()).toEqual([]);
    });

    it("returns per-session stats with models", () => {
      pool = new SessionAgentPool();
      pool.get("sess-1", "claude-sonnet-4-6", "anthropic");
      pool.get("sess-1", "glm-5.1", "glm");
      const stats = pool.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].modelCount).toBe(2);
      expect(stats[0].models).toEqual(["claude-sonnet-4-6", "glm-5.1"]);
    });

    it("tracks idle time", () => {
      pool = new SessionAgentPool();
      pool.get("sess-1", "claude-sonnet-4-6", "anthropic");
      vi.advanceTimersByTime(60_000);
      const stats = pool.getStats();
      expect(stats[0].idleMs).toBe(60_000);
    });

    it("separates connections for same model across providers", () => {
      pool = new SessionAgentPool();
      pool.get("sess-1", "glm-5.1", "glm");
      pool.get("sess-1", "glm-5.1", "glm_openai");
      const stats = pool.getStats();
      expect(stats[0].modelCount).toBe(2);
      // Both entries show the same model name (provider prefix stripped for display)
      expect(stats[0].models).toEqual(["glm-5.1", "glm-5.1"]);
    });
  });

  describe("evict", () => {
    it("removes specific session+model+provider agent", () => {
      pool = new SessionAgentPool();
      pool.get("sess-1", "glm-5.1", "glm");
      pool.get("sess-1", "glm-5.1", "glm_openai");
      expect(pool.sessionCount).toBe(1);

      pool.evict("sess-1", "glm-5.1", "glm");
      expect(pool.sessionCount).toBe(1);
      const stats = pool.getStats();
      expect(stats[0].models).toEqual(["glm-5.1"]);
    });

    it("removes session when last provider is evicted", () => {
      pool = new SessionAgentPool();
      pool.get("sess-1", "glm-5.1", "glm");
      pool.evict("sess-1", "glm-5.1", "glm");
      expect(pool.sessionCount).toBe(0);
    });
  });

  describe("get() without sessionId", () => {
    it("returns null when no sessionId", () => {
      pool = new SessionAgentPool();
      expect(pool.get(undefined, "glm-5.1", "glm")).toBeNull();
      expect(pool.sessionCount).toBe(0);
    });
  });
});
