// tests/circuit-breaker.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      windowSeconds: 60,
      cooldownSeconds: 1, // Short for tests
    });
  });

  describe("closed state", () => {
    it("starts in closed state", () => {
      expect(breaker.getState()).toBe("closed");
    });

    it("allows requests in closed state", () => {
      expect(breaker.canProceed().allowed).toBe(true);
    });

    it("stays closed on 2xx response", () => {
      breaker.recordResult(200);
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getStatus().failures).toBe(0);
    });

    it("stays closed on non-retriable error (401)", () => {
      breaker.recordResult(401);
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getStatus().failures).toBe(0);
    });

    it("tracks retriable failures (429, 5xx) but stays closed under threshold", () => {
      breaker.recordResult(429);
      breaker.recordResult(500);
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getStatus().failures).toBe(2);
    });
  });

  describe("open state", () => {
    it("opens after threshold failures", () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");
    });

    it("blocks requests in open state", () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      expect(breaker.canProceed().allowed).toBe(false);
    });

    it("does not record result for skipped (non-attempted) requests", () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      // Don't call recordResult — provider was skipped
      expect(breaker.getStatus().failures).toBe(3);
    });
  });

  describe("half-open state", () => {
    it("transitions to half-open after cooldown", async () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");

      // Wait for cooldown (1 second in test config)
      await new Promise((r) => setTimeout(r, 1100));

      expect(breaker.canProceed().allowed).toBe(true);
      expect(breaker.getState()).toBe("half-open");
    });

    it("closes on success in half-open", async () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      await new Promise((r) => setTimeout(r, 1100));
      breaker.canProceed(); // triggers half-open

      breaker.recordResult(200);
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getStatus().failures).toBe(0);
    });

    it("reopens on failure in half-open", async () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      await new Promise((r) => setTimeout(r, 1100));
      breaker.canProceed(); // triggers half-open

      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");
    });
  });

  describe("custom config", () => {
    it("uses default thresholds when none provided", () => {
      const defaultBreaker = new CircuitBreaker();
      // Default: 3 failures in 60s
      defaultBreaker.recordResult(429);
      defaultBreaker.recordResult(429);
      defaultBreaker.recordResult(429);
      expect(defaultBreaker.getState()).toBe("open");
    });

    it("respects custom failure threshold", () => {
      const custom = new CircuitBreaker({ failureThreshold: 5, windowSeconds: 60, cooldownSeconds: 30 });
      custom.recordResult(429);
      custom.recordResult(429);
      custom.recordResult(429);
      expect(custom.getState()).toBe("closed");
      custom.recordResult(429);
      custom.recordResult(429);
      expect(custom.getState()).toBe("open");
    });
  });

  describe("getStatus", () => {
    it("returns lastFailure timestamp", () => {
      breaker.recordResult(429);
      const status = breaker.getStatus();
      expect(status.lastFailure).not.toBeNull();
      expect(status.failures).toBe(1);
    });

    it("returns null lastFailure when no failures", () => {
      const status = breaker.getStatus();
      expect(status.lastFailure).toBeNull();
      expect(status.failures).toBe(0);
    });
  });
});
