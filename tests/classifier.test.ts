import { describe, it, expect } from "vitest";
import { classifyTier, extractLastUserMessage } from "../src/classifier.js";
import type { SmartRoutingConfig, ClassificationRule } from "../src/types.js";

/** Helper to build config with pre-compiled regexes */
function makeConfig(
  rules: Record<number, { pattern: string; score: number }[]>,
  threshold = 2,
): SmartRoutingConfig {
  const patterns: Record<number, ClassificationRule[]> = {};
  for (const [tier, entries] of Object.entries(rules)) {
    patterns[Number(tier)] = entries.map((e) => ({
      pattern: e.pattern,
      score: e.score,
      _compiled: new RegExp(e.pattern, "i"),
    }));
  }
  return { enabled: true, escalationThreshold: threshold, patterns };
}

// ── classifyTier ─────────────────────────────────────────────────────

describe("classifyTier", () => {
  it("returns null when disabled", () => {
    const config = makeConfig({ 1: [{ pattern: "test", score: 3 }] });
    config.enabled = false;
    expect(classifyTier("test debug deploy", config)).toBeNull();
  });

  it("returns null for empty message", () => {
    const config = makeConfig({ 1: [{ pattern: "test", score: 3 }] });
    expect(classifyTier("", config)).toBeNull();
  });

  it("returns null when no patterns match", () => {
    const config = makeConfig(
      { 1: [{ pattern: "architect|design", score: 2 }] },
      2,
    );
    expect(classifyTier("hello world", config)).toBeNull();
  });

  it("returns tier 1 when score meets threshold", () => {
    const config = makeConfig(
      {
        1: [{ pattern: "debug|investigate", score: 3 }],
      },
      3,
    );
    expect(classifyTier("please debug this issue", config)).toBe(1);
  });

  it("returns null when score is below threshold", () => {
    const config = makeConfig(
      {
        1: [{ pattern: "debug", score: 1 }],
      },
      3,
    );
    expect(classifyTier("please debug this", config)).toBeNull();
  });

  it("tier 1 wins over tier 2 when both match", () => {
    const config = makeConfig(
      {
        1: [{ pattern: "architect|design system", score: 3 }],
        2: [{ pattern: "explain|summarize", score: 2 }],
      },
      2,
    );
    // "explain the architecture" matches both — tier 1 checked first, wins
    expect(classifyTier("explain the architecture", config)).toBe(1);
  });

  it("accumulates scores from multiple matching rules", () => {
    const config = makeConfig(
      {
        2: [
          { pattern: "write.*test", score: 1 },
          { pattern: "refactor", score: 1 },
          { pattern: "review", score: 1 },
        ],
      },
      2,
    );
    // Two rules match: "write test" (1) + "review" (1) = 2 >= threshold
    expect(classifyTier("please write test and review this code", config)).toBe(
      2,
    );
  });

  it("handles case-insensitive matching", () => {
    const config = makeConfig(
      { 1: [{ pattern: "DEBUG|INVESTIGATE", score: 3 }] },
      3,
    );
    expect(classifyTier("Please debug this", config)).toBe(1);
  });

  it("skips tiers with no rules", () => {
    const config = makeConfig(
      {
        1: [],
        2: [{ pattern: "explain", score: 3 }],
      },
      3,
    );
    expect(classifyTier("please explain this", config)).toBe(2);
  });

  it("returns null when no tiers defined", () => {
    const config = makeConfig({}, 2);
    expect(classifyTier("debug this", config)).toBeNull();
  });
});

// ── extractLastUserMessage ────────────────────────────────────────────

describe("extractLastUserMessage", () => {
  it("extracts from Anthropic array content format", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Hello there" }],
        },
      ],
    };
    expect(extractLastUserMessage(body)).toBe("Hello there");
  });

  it("extracts from Anthropic string content format", () => {
    const body = {
      messages: [{ role: "user", content: "Hello there" }],
    };
    expect(extractLastUserMessage(body)).toBe("Hello there");
  });

  it("returns empty string when no messages", () => {
    expect(extractLastUserMessage({})).toBe("");
    expect(extractLastUserMessage({ messages: [] })).toBe("");
  });

  it("returns empty string when no user messages", () => {
    const body = {
      messages: [{ role: "assistant", content: "Hi" }],
    };
    expect(extractLastUserMessage(body)).toBe("");
  });

  it("extracts the LAST user message, not the first", () => {
    const body = {
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "Response" },
        { role: "user", content: "Second message" },
      ],
    };
    expect(extractLastUserMessage(body)).toBe("Second message");
  });

  it("concatenates multiple text blocks in a single message", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Part one." },
            { type: "text", text: "Part two." },
          ],
        },
      ],
    };
    expect(extractLastUserMessage(body)).toBe("Part one. Part two.");
  });

  it("ignores non-text content blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { data: "..." } },
            { type: "text", text: "Describe this image" },
          ],
        },
      ],
    };
    expect(extractLastUserMessage(body)).toBe("Describe this image");
  });
});
