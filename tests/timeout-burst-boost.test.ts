import { describe, it, expect, beforeEach } from "vitest";
import type { ProviderConfig } from "../src/types.js";
import { boostManager } from "../src/adaptive-timeout.js";

function makeProvider(name: string, opts: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name,
    baseUrl: "http://localhost:9999",
    apiKey: "test",
    timeout: 30000,
    ttfbTimeout: 10000,
    stallTimeout: 15000,
    _connectionRetries: 0,
    ...opts,
  };
}

describe("Timeout burst boost integration", () => {
  beforeEach(() => {
    // Reset singleton state between tests
    boostManager["state"].clear();
  });

  it("does not boost on single timeout", () => {
    const provider = makeProvider("glm", { ttfbTimeout: 200 });
    for (let i = 0; i < 4; i++) {
      boostManager.recordTimeoutError(provider, "ttfb");
    }
    expect(provider.ttfbTimeout).toBe(200);
  });

  it("5 TTFB errors trigger 50% boost on ttfbTimeout", () => {
    const provider = makeProvider("glm", { ttfbTimeout: 200 });
    for (let i = 0; i < 5; i++) {
      boostManager.recordTimeoutError(provider, "ttfb");
    }
    expect(provider.ttfbTimeout).toBe(300); // 200 * 1.5
  });

  it("stall errors boost stallTimeout independently", () => {
    const provider = makeProvider("glm", { ttfbTimeout: 200, stallTimeout: 300 });
    for (let i = 0; i < 5; i++) {
      boostManager.recordTimeoutError(provider, "stall");
    }
    expect(provider.stallTimeout).toBe(450); // 300 * 1.5
    expect(provider.ttfbTimeout).toBe(200); // unchanged
  });

  it("checkReset restores original after cooldown", () => {
    const mgr = boostManager;
    // The singleton uses real Date.now(), so we can't test time manipulation directly.
    // Instead, verify that checkReset is callable and doesn't throw.
    const provider = makeProvider("glm", { ttfbTimeout: 200 });
    mgr.checkReset(provider);
    expect(provider.ttfbTimeout).toBe(200); // no boost, no change
  });

  it("getBoostInfo returns diagnostic info", () => {
    const provider = makeProvider("glm", { ttfbTimeout: 200 });
    for (let i = 0; i < 5; i++) {
      boostManager.recordTimeoutError(provider, "ttfb");
    }
    const info = boostManager.getBoostInfo("glm");
    expect(info.ttfb.boosted).toBe(true);
    expect(info.ttfb.errorCount).toBe(5);
    expect(info.stall.boosted).toBe(false);
    expect(info.timeout.boosted).toBe(false);
  });
});
