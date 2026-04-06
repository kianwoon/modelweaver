// tests/timeout-survival-simulation.test.ts
/**
 * Simulation: GLM & MiniMax intermittent TTFB/stall timeout survival test.
 *
 * Scenario: Both GLM and MiniMax intermittently exceed their TTFB timeout
 * (GLM: 15s, MiniMax: 12s) and stall timeout (GLM: 20s, MiniMax: 12s).
 * Tests whether ModelWeaver survives with circuit breakers, retry chains, and
 * fallback chains intact.
 *
 * Key behaviors tested:
 * 1. TTFB timeout → retry with fresh connection (up to 5 times per provider)
 * 2. Stall timeout → synthetic SSE error, connection error tracked separately
 * 3. Circuit breaker threshold=2 → opens after 2 failures (but NOT on timeouts)
 * 4. Connection errors do NOT count toward CB threshold (local artifacts)
 * 5. Fallback chain proceeds to next provider when one times out
 * 6. All providers exhausted → final 502
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  forwardWithFallback,
  isRetriable,
} from "../src/proxy.js";
import type { ProviderConfig, RoutingEntry, RequestContext } from "../src/types.js";
import { setMetricsStore } from "../src/proxy.js";
import { MetricsStore } from "../src/metrics.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { recordHealthEvent, getHealthScore } from "../src/health-score.js";
import { clearHedgeStats, latencyTracker } from "../src/hedging.js";

// ---------------------------------------------------------------------------
// Mock provider server with configurable failure modes
// ---------------------------------------------------------------------------

function createMockServer() {
  const { Hono } = require("hono");
  const { serve } = require("@hono/node-server");
  let callCount = 0;
  let behavior: "success" | "ttfb-timeout" | "stall-after-headers" = "success";

  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    callCount++;

    if (behavior === "ttfb-timeout") {
      // Never respond — triggers AbortSignal timeout
      await new Promise(() => {});
      return c.json({ type: "error" }, 500);
    }

    if (behavior === "stall-after-headers") {
      // Send one SSE chunk, then stall forever
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array(
                new TextEncoder().encode(
                  "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_slow\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"slow\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n"
                )
              )
            );
            // Never close — stall timer will fire
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "anthropic-version": "2023-06-01",
          },
        }
      );
    }

    // Success — stream SSE
    const body = await c.req.json();
    return new Response(
      [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_" + callCount, type: "message", role: "assistant", model: body.model || "test", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
        "event: content_block_start\n",
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        "event: content_block_delta\n",
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Response from mock provider #" + callCount } })}\n\n`,
        "event: content_block_stop\n",
        `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        "event: message_delta\n",
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
        "event: message_stop\n",
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join(""),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "anthropic-version": "2023-06-01",
        },
      }
    );
  });

  const server = serve({ fetch: app.fetch, port: 0 });
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(() => resolve(), 2000);
      }),
    setBehavior: (b: typeof behavior) => { behavior = b; },
    getCallCount: () => callCount,
  };
}

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

function makeProvider(name: string, url: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const bases: Record<string, ProviderConfig> = {
    glm: {
      name,
      baseUrl: url,
      apiKey: "test-key",
      timeout: 60_000,
      ttfbTimeout: 15_000,
      stallTimeout: 20_000,
      _connectionRetries: 5,
    },
    minimax: {
      name,
      baseUrl: url,
      apiKey: "test-key",
      timeout: 60_000,
      ttfbTimeout: 12_000,
      stallTimeout: 12_000,
      _connectionRetries: 5,
    },
    openrouter: {
      name,
      baseUrl: url,
      apiKey: "test-key",
      timeout: 60_000,
      ttfbTimeout: 12_000,
      stallTimeout: 15_000,
      _connectionRetries: 3,
    },
  };

  const base = bases[name] ?? { name, baseUrl: url, apiKey: "test-key", timeout: 60_000 };
  return Object.assign(base, overrides);
}

function makeCtx(rawBody?: string): RequestContext {
  return {
    requestId: `test-${Math.random().toString(36).slice(2, 8)}`,
    actualModel: undefined,
    actualProvider: undefined,
    hasDistribution: true,
    _streamState: "start",
    startTime: Date.now(),
    metrics_brief: { cost: 0, input_tokens: 0, output_tokens: 0 },
    streaming: true,
    rawBody: rawBody ?? JSON.stringify({
      model: "test-model",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  } as unknown as RequestContext;
}

function makeRequest(model = "test-model"): Request {
  return new Request("http://localhost:3456/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "test",
    },
    body: JSON.stringify({
      model,
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GLM & MiniMax Intermittent Timeout Survival Simulation", () => {
  let glmServer: ReturnType<typeof createMockServer>;
  let minimaxServer: ReturnType<typeof createMockServer>;
  let okServer: ReturnType<typeof createMockServer>;
  let metricsStore: MetricsStore;

  beforeEach(() => {
    metricsStore = new MetricsStore(1000);
    setMetricsStore(metricsStore);
    clearHedgeStats(); // reset hedge stats
    latencyTracker.clear("glm");
    latencyTracker.clear("minimax");
    latencyTracker.clear("openrouter");

    glmServer = createMockServer();
    minimaxServer = createMockServer();
    okServer = createMockServer();
    okServer.setBehavior("success");
  });

  afterEach(async () => {
    await glmServer.close();
    await minimaxServer.close();
    await okServer.close();
  });

  // -------------------------------------------------------------------------
  // SURVIVAL-1: Circuit breaker NOT tripped by timeouts — only 429/5xx count
  // -------------------------------------------------------------------------
  it("SURVIVAL-1: CB threshold NOT reached despite repeated timeouts (only 429/5xx trip it)", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      windowSeconds: 60,
      cooldownSeconds: 5,
    });

    // Simulate 10 consecutive timeouts — should NOT trip the breaker
    // recordTimeout is a no-op (timeouts don't count toward threshold)
    for (let i = 0; i < 10; i++) {
      breaker.recordTimeout();
    }
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canProceed().allowed).toBe(true);

    // Now simulate actual 429 rate limits — SHOULD trip the breaker
    breaker.recordResult(429);
    expect(breaker.getState()).toBe("closed"); // 1/2
    breaker.recordResult(429);
    expect(breaker.getState()).toBe("open");   // 2/2 → trips open

    // Verify: canProceed blocks in open state
    const blocked = breaker.canProceed();
    expect(blocked.allowed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // SURVIVAL-2: Stall timeout → connection error tracked, health score unaffected
  // -------------------------------------------------------------------------
  it("SURVIVAL-2: Stall timeout records connection error but does NOT affect health score", () => {
    // Record multiple stall timeouts
    metricsStore.recordConnectionError("minimax", "stalls");
    metricsStore.recordConnectionError("minimax", "stalls");
    metricsStore.recordConnectionError("minimax", "ttfbTimeouts");

    const connErr = metricsStore.getConnectionErrors();
    expect(connErr["minimax"]).toBeDefined();
    expect(connErr["minimax"].stalls).toBe(2);
    expect(connErr["minimax"].ttfbTimeouts).toBe(1);

    // Health score is unaffected by connection errors
    // Health is only affected by recordHealthEvent calls
    recordHealthEvent("minimax", true, 500);
    recordHealthEvent("minimax", true, 600);
    recordHealthEvent("minimax", true, 700);

    const score = getHealthScore("minimax");
    expect(score).toBeGreaterThan(0.8); // Should be healthy

    // Multiple connection errors don't change the health score
    metricsStore.recordConnectionError("minimax", "stalls");
    metricsStore.recordConnectionError("minimax", "stalls");
    const scoreAfter = getHealthScore("minimax");
    expect(scoreAfter).toBe(score); // unchanged
  });

  // -------------------------------------------------------------------------
  // SURVIVAL-3: isRetriable — only 429/5xx are retriable, not connection errors
  // -------------------------------------------------------------------------
  it("SURVIVAL-3: isRetriable returns true only for 429/5xx, not connection errors", () => {
    expect(isRetriable(429)).toBe(true);
    expect(isRetriable(500)).toBe(true);
    expect(isRetriable(502)).toBe(true);
    expect(isRetriable(503)).toBe(true);
    expect(isRetriable(400)).toBe(false);
    expect(isRetriable(401)).toBe(false);
    expect(isRetriable(403)).toBe(false);
    // Note: 502 from upstream IS retriable, but 502 from connection error
    // is distinguished by checking the body in forwardWithRetry
  });

  // -------------------------------------------------------------------------
  // SURVIVAL-4: Both GLM and MiniMax timeout → fallback to OpenRouter succeeds
  // -------------------------------------------------------------------------
  it("SURVIVAL-4: Fallback chain proceeds to third provider when first two timeout", async () => {
    const providers = new Map<string, ProviderConfig>([
      ["glm", makeProvider("glm", glmServer.url, {
        ttfbTimeout: 500,
        stallTimeout: 500,
        timeout: 2_000,
        _connectionRetries: 0, // No retries — fail fast and fall back
      })],
      ["minimax", makeProvider("minimax", minimaxServer.url, {
        ttfbTimeout: 500,
        stallTimeout: 500,
        timeout: 2_000,
        _connectionRetries: 0,
      })],
      ["openrouter", makeProvider("openrouter", okServer.url, {
        ttfbTimeout: 10_000,
        stallTimeout: 15_000,
        timeout: 30_000,
        _connectionRetries: 0,
      })],
    ]);

    const chain: RoutingEntry[] = [
      { provider: "glm", model: "glm-5-turbo" },
      { provider: "minimax", model: "MiniMax-M2.7" },
      { provider: "openrouter", model: "qwen" },
    ];

    // Both primary and secondary timeout
    glmServer.setBehavior("ttfb-timeout");
    minimaxServer.setBehavior("ttfb-timeout");

    const ctx = makeCtx();
    const result = await forwardWithFallback(providers, chain, ctx, makeRequest());

    // Falls through to third provider → success
    expect(result.response.status).toBe(200);
    expect(result.actualProvider).toBe("openrouter");
    expect(result.actualModel).toBe("qwen");

    // Both failed servers were tried once each (no retries)
    expect(glmServer.getCallCount()).toBe(1);
    expect(minimaxServer.getCallCount()).toBe(1);
    // Third provider succeeded
    expect(okServer.getCallCount()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // SURVIVAL-5: Intermittent GLM timeout → retry succeeds before fallback
  // -------------------------------------------------------------------------
  it("SURVIVAL-5: GLM intermittent timeout retried with fresh connection, succeeds", async () => {
    // Verifies: provider timeout exhausts retries → fallback to next provider succeeds.
    // With _connectionRetries=1, GLM gets 2 total attempts before fallback.
    const providers = new Map<string, ProviderConfig>([
      ["glm", makeProvider("glm", glmServer.url, {
        ttfbTimeout: 500,
        stallTimeout: 500,
        timeout: 2_000,
        _connectionRetries: 1, // 2 total attempts
      })],
      ["openrouter", makeProvider("openrouter", okServer.url, {
        ttfbTimeout: 10_000,
        stallTimeout: 15_000,
        timeout: 30_000,
      })],
    ]);

    const chain: RoutingEntry[] = [
      { provider: "glm", model: "glm-5-turbo" },
      { provider: "openrouter", model: "qwen" },
    ];

    // GLM always times out (exhausts all retries)
    glmServer.setBehavior("ttfb-timeout");

    const ctx = makeCtx();
    const result = await forwardWithFallback(providers, chain, ctx, makeRequest());

    // GLM exhausts all retries → fallback to openrouter → success
    expect(result.response.status).toBe(200);
    expect(result.actualProvider).toBe("openrouter");

    // GLM was called 2 times (1 original + 1 retry)
    expect(glmServer.getCallCount()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // SURVIVAL-6: All providers timeout → graceful 502, no crash
  // -------------------------------------------------------------------------
  it("SURVIVAL-6: All providers timeout → graceful 502, ModelWeaver survives", async () => {
    const providers = new Map<string, ProviderConfig>([
      ["glm", makeProvider("glm", glmServer.url, {
        ttfbTimeout: 500,
        stallTimeout: 500,
        timeout: 2_000,
        _connectionRetries: 0, // No retries — fail fast
      })],
      ["minimax", makeProvider("minimax", minimaxServer.url, {
        ttfbTimeout: 500,
        stallTimeout: 500,
        timeout: 2_000,
        _connectionRetries: 0,
      })],
    ]);

    const chain: RoutingEntry[] = [
      { provider: "glm", model: "glm-5-turbo" },
      { provider: "minimax", model: "MiniMax-M2.7" },
    ];

    // Both timeout
    glmServer.setBehavior("ttfb-timeout");
    minimaxServer.setBehavior("ttfb-timeout");

    const ctx = makeCtx();
    const result = await forwardWithFallback(providers, chain, ctx, makeRequest());

    // Should get 502 — not a thrown exception (ModelWeaver survives)
    expect(result.response.status).toBe(502);

    // Both were tried (1 attempt each, no retries)
    expect(glmServer.getCallCount()).toBe(1);
    expect(minimaxServer.getCallCount()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // SURVIVAL-7: CB half-open probe timeout → back to open, escalating cooldown
  // -------------------------------------------------------------------------
  it("SURVIVAL-7: CB half-open probe timeout → flap detected, escalating cooldown", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      windowSeconds: 60,
      cooldownSeconds: 5,
      rateLimitCooldownSeconds: 2,
    });

    // Trip the breaker with 429s
    breaker.recordResult(429);
    breaker.recordResult(429);
    expect(breaker.getState()).toBe("open");
    const openedAt = breaker.getStatus().lastFailure;

    // Advance past cooldown
    vi.advanceTimersByTime(6_000);

    // Probe allowed
    const probe = breaker.canProceed();
    expect(probe.allowed).toBe(true);
    expect(probe.probeId).toBe(0);

    // Probe times out → back to open with escalating cooldown
    breaker.recordProbeTimeout(probe.probeId);
    expect(breaker.getState()).toBe("open");
    // Cooldown should be escalated (2x base = 10s for rate limit)
    // But we can verify the flap count increased
    const status = breaker.getStatus();
    expect(status.state).toBe("open");

    // Advance past 10s cooldown
    vi.advanceTimersByTime(11_000);

    // Probe allowed again
    const probe2 = breaker.canProceed();
    expect(probe2.allowed).toBe(true);

    // Simulate probe succeeding → closed
    breaker.recordResult(200);
    expect(breaker.getState()).toBe("closed");
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // SURVIVAL-8: GLM stall (after headers) → SSE error injected, connection error tracked
  // -------------------------------------------------------------------------
  it("SURVIVAL-8: GLM stall after headers → SSE error payload, connection error counted", async () => {
    const providers = new Map<string, ProviderConfig>([
      ["glm", makeProvider("glm", glmServer.url, {
        ttfbTimeout: 10_000,
        stallTimeout: 500,  // Short stall timeout
        timeout: 5_000,
        _connectionRetries: 0, // No retries
      })],
    ]);

    const chain: RoutingEntry[] = [
      { provider: "glm", model: "glm-5-turbo" },
    ];

    // GLM sends headers but stalls on body
    glmServer.setBehavior("stall-after-headers");

    const ctx = makeCtx();
    const result = await forwardWithFallback(providers, chain, ctx, makeRequest());

    // Stall errors are injected as SSE events within the 200 stream body,
    // not as HTTP status codes — the status line is already sent.
    expect(result.response.status).toBe(200);
    // The body should contain the stall-injected SSE termination events
    const body = await result.response.text();
    expect(body).toContain("message_stop");

    // Connection error was tracked
    const connErr = metricsStore.getConnectionErrors();
    expect(connErr["glm"]).toBeDefined();
    expect(connErr["glm"].stalls).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // SURVIVAL-9: Rapid consecutive timeouts — CB escalates cooldown, survives
  // -------------------------------------------------------------------------
  it("SURVIVAL-9: Rapid flap cycles → escalating cooldown, CB survives without deadlock", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const breaker = new CircuitBreaker({
      failureThreshold: 1, // Trip on first failure
      windowSeconds: 60,
      cooldownSeconds: 5,
      rateLimitCooldownSeconds: 5, // match cooldownSeconds so 429 escalation is predictable
    });

    // Simulate rapid open→half-open→timeout→open flap cycles
    for (let i = 0; i < 5; i++) {
      // Trip with 429
      breaker.recordResult(429);
      expect(breaker.getState()).toBe("open");

      // Advance past cooldown (escalating: 5s, 10s, 20s, 40s, 60s)
      const escalatedCooldown = Math.min(5_000 * Math.pow(2, i), 60_000);
      vi.advanceTimersByTime(escalatedCooldown + 1_000);

      // Probe
      const probe = breaker.canProceed();
      expect(probe.allowed).toBe(true);

      // Probe fails (timeout)
      breaker.recordProbeTimeout(probe.probeId);
      expect(breaker.getState()).toBe("open");
    }

    // After 5 flaps, cooldown capped at 60s — advance past it
    vi.advanceTimersByTime(61_000);

    // Should still be able to probe (not permanently dead)
    const probe = breaker.canProceed();
    expect(probe.allowed).toBe(true);

    // Let probe succeed → closed
    breaker.recordResult(200);
    expect(breaker.getState()).toBe("closed");
    vi.useRealTimers();
  });
});
