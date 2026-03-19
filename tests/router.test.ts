// tests/router.test.ts
import { describe, it, expect } from "vitest";
import { matchTier, buildRoutingChain } from "../src/router.js";
import type { RoutingEntry } from "../src/types.js";

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
