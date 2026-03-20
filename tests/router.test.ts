// tests/router.test.ts
import { describe, it, expect } from "vitest";
import { matchTier, buildRoutingChain, resolveRequest } from "../src/router.js";
import type { RoutingEntry, AppConfig } from "../src/types.js";

describe("matchTier", () => {
  const patterns = new Map<string, string[]>([
    ["sonnet", ["sonnet", "3-5-sonnet", "3.5-sonnet"]],
    ["opus", ["opus", "3-opus", "3.5-opus"]],
    ["haiku", ["haiku", "3-haiku", "3.5-haiku"]],
  ]);

  it("matches claude-sonnet-4-20250514 to sonnet tier", () => {
    expect(matchTier("claude-sonnet-4-20250514", patterns)).toBe("sonnet");
  });

  it("matches claude-opus-4-20250514 to opus tier", () => {
    expect(matchTier("claude-opus-4-20250514", patterns)).toBe("opus");
  });

  it("matches claude-haiku-4-5-20251001 to haiku tier", () => {
    expect(matchTier("claude-haiku-4-5-20251001", patterns)).toBe("haiku");
  });

  it("matches 3-5-sonnet variant to sonnet tier", () => {
    expect(matchTier("claude-3-5-sonnet-20241022", patterns)).toBe("sonnet");
  });

  it("returns null when no pattern matches", () => {
    expect(matchTier("gpt-4o", patterns)).toBeNull();
  });

  it("is case-sensitive", () => {
    expect(matchTier("Claude-Sonnet-4", patterns)).toBeNull();
  });

  it("first matching tier wins (config order matters)", () => {
    const ambiguous = new Map<string, string[]>([
      ["sonnet", ["sonnet"]],
      ["custom", ["sonnet"]],
    ]);
    expect(matchTier("claude-sonnet-4", ambiguous)).toBe("sonnet");
  });
});

describe("buildRoutingChain", () => {
  const routing = new Map<string, RoutingEntry[]>([
    ["sonnet", [
      { provider: "anthro", model: "claude-sonnet-4" },
      { provider: "or", model: "anthropic/claude-sonnet-4" },
    ]],
  ]);

  it("returns the routing entries for a given tier", () => {
    const chain = buildRoutingChain("sonnet", routing);
    expect(chain).toHaveLength(2);
    expect(chain[0].provider).toBe("anthro");
    expect(chain[1].provider).toBe("or");
  });

  it("returns empty array for unknown tier", () => {
    expect(buildRoutingChain("unknown", routing)).toEqual([]);
  });
});

describe("resolveRequest", () => {
  const baseConfig: AppConfig = {
    server: { port: 13000, host: "localhost" },
    providers: new Map(),
    routing: new Map([
      ["sonnet", [{ provider: "anthro" }]],
    ]),
    tierPatterns: new Map([
      ["sonnet", ["sonnet"]],
    ]),
    modelRouting: new Map(),
  };

  it("returns null when no route matches", () => {
    expect(resolveRequest("unknown-model", "req-1", baseConfig, "{}")).toBeNull();
  });

  it("exact modelRouting match returns correct chain with (modelRouting) tier", () => {
    const config: AppConfig = {
      ...baseConfig,
      modelRouting: new Map([
        ["glm-5-turbo", [{ provider: "glm" }]],
      ]),
    };
    const ctx = resolveRequest("glm-5-turbo", "req-1", config, '{"test":true}');
    expect(ctx).not.toBeNull();
    expect(ctx!.tier).toBe("(modelRouting)");
    expect(ctx!.providerChain).toEqual([{ provider: "glm" }]);
    expect(ctx!.model).toBe("glm-5-turbo");
    expect(ctx!.rawBody).toBe('{"test":true}');
  });

  it("modelRouting with multiple entries returns full chain", () => {
    const config: AppConfig = {
      ...baseConfig,
      modelRouting: new Map([
        ["custom-model", [
          { provider: "primary" },
          { provider: "fallback" },
        ]],
      ]),
    };
    const ctx = resolveRequest("custom-model", "req-2", config, "{}");
    expect(ctx!.providerChain).toHaveLength(2);
    expect(ctx!.providerChain[0].provider).toBe("primary");
    expect(ctx!.providerChain[1].provider).toBe("fallback");
  });

  it("modelRouting takes priority over tier pattern matching", () => {
    const config: AppConfig = {
      ...baseConfig,
      modelRouting: new Map([
        ["claude-sonnet-4", [{ provider: "custom-provider" }]],
      ]),
    };
    // "claude-sonnet-4" contains "sonnet" so would match tier pattern,
    // but modelRouting should win
    const ctx = resolveRequest("claude-sonnet-4", "req-3", config, "{}");
    expect(ctx!.tier).toBe("(modelRouting)");
    expect(ctx!.providerChain[0].provider).toBe("custom-provider");
  });

  it("falls back to tier patterns when no modelRouting match", () => {
    const ctx = resolveRequest("claude-sonnet-4", "req-4", baseConfig, "{}");
    expect(ctx).not.toBeNull();
    expect(ctx!.tier).toBe("sonnet");
    expect(ctx!.providerChain).toEqual([{ provider: "anthro" }]);
  });

  it("empty modelRouting map falls through to tier patterns", () => {
    expect(baseConfig.modelRouting.size).toBe(0);
    const ctx = resolveRequest("claude-sonnet-4", "req-5", baseConfig, "{}");
    expect(ctx!.tier).toBe("sonnet");
  });

  it("modelRouting with empty chain falls through to tier patterns", () => {
    const config: AppConfig = {
      ...baseConfig,
      modelRouting: new Map([
        ["glm-5-turbo", []],
      ]),
    };
    // Empty chain should be skipped, fall through to tier pattern
    const ctx = resolveRequest("claude-sonnet-4", "req-6", config, "{}");
    expect(ctx!.tier).toBe("sonnet");
  });
});
