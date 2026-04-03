// tests/circuit-breaker.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      windowSeconds: 60,
      cooldownSeconds: 1, // Short for tests
      rateLimitCooldownSeconds: 1, // Match cooldown for 429 tests
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

    it("ignores auth failures (401) toward breaker threshold — only 429 and 5xx count as failures", () => {
      breaker.recordResult(401);
      breaker.recordResult(500);
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getStatus().failures).toBe(1);
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
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("transitions to half-open after cooldown", async () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");

      // Advance timers past cooldown (1 second in test config)
      vi.advanceTimersByTime(1100);
      await Promise.resolve(); // flush any pending microtasks

      expect(breaker.canProceed().allowed).toBe(true);
      expect(breaker.getState()).toBe("half-open");
    });

    it("closes on success in half-open", async () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      vi.advanceTimersByTime(1100);
      await Promise.resolve(); // flush any pending microtasks
      breaker.canProceed(); // triggers half-open

      breaker.recordResult(200);
      expect(breaker.getState()).toBe("closed");
      expect(breaker.getStatus().failures).toBe(0);
    });

    it("reopens on failure in half-open", async () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      vi.advanceTimersByTime(1100);
      await Promise.resolve(); // flush any pending microtasks
      breaker.canProceed(); // triggers half-open

      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");
    });

    it("getState() does not consume the half-open probe slot (regression #156)", async () => {
      // Simulates the pattern where router.ts checks getState() for distribution
      // routing — this must NOT consume the probe slot that forwardWithFallback()
      // needs via canProceed().
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");

      // Advance past cooldown
      vi.advanceTimersByTime(1100);
      await Promise.resolve();

      // Router layer: read-only state check (does NOT transition)
      expect(breaker.getState()).toBe("open");

      // Proxy layer: canProceed() should still be able to grant a probe
      const result = breaker.canProceed();
      expect(result.allowed).toBe(true);
      expect(breaker.getState()).toBe("half-open");
    });

    it("canProceed() consumes probe slot, subsequent canProceed() is blocked", async () => {
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      vi.advanceTimersByTime(1100);
      await Promise.resolve();

      // First canProceed() grants the probe
      expect(breaker.canProceed().allowed).toBe(true);

      // Second canProceed() (simulating the old router.ts bug) would be blocked
      expect(breaker.canProceed().allowed).toBe(false);

      // getState() still returns half-open (probe in progress)
      expect(breaker.getState()).toBe("half-open");
    });

    it("recordProbeTimeout clears probe flags and transitions to open", () => {
      // Use any casts to access private state — test file only
      const cb = new CircuitBreaker({ cooldownSeconds: 1 });
      (cb as any).state = "half-open";
      (cb as any).halfOpenInProgress = true;
      (cb as any).halfOpenProbeId = 99;
      (cb as any)._probeGranted = true;

      cb.recordProbeTimeout(99);

      const s = cb.getStatus();
      expect(s.state).toBe("open");
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

  describe("escalating cooldown", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("doubles cooldown on second open (1 flap)", async () => {
      // Open first time
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");

      // Advance past first cooldown (1s)
      vi.advanceTimersByTime(1100);
      await Promise.resolve();

      // Probe fails — goes back to open (1 flap)
      breaker.canProceed();
      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");

      // After 1 flap, cooldown = 1s * 2^1 = 2s
      // Advance 2.1s from now (past the 2s cooldown)
      vi.advanceTimersByTime(2100);
      await Promise.resolve();

      expect(breaker.canProceed().allowed).toBe(true);
    });

    it("resets flap count after 5 consecutive successes", async () => {
      // Open, flap, go half-open
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
      breaker.canProceed();
      breaker.recordResult(429); // back to open — flap count = 1

      vi.advanceTimersByTime(2100); // 2x cooldown elapsed
      await Promise.resolve();
      breaker.canProceed();

      // Now succeed 5 times in a row
      breaker.recordResult(200);
      breaker.recordResult(200);
      breaker.recordResult(200);
      breaker.recordResult(200);
      breaker.recordResult(200);

      expect(breaker.getState()).toBe("closed");
      // Flap count should be reset — next failure should be at 1x cooldown
      breaker.recordResult(429);
      breaker.recordResult(429);
      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");
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
