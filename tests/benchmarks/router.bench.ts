import { describe, bench } from "vitest";
import { matchTier, resolveRequest } from "../../src/router.js";
import type { AppConfig } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixture data: a realistic AppConfig with multiple tiers and patterns
// ---------------------------------------------------------------------------

const tierPatterns = new Map<string, string[]>([
  ["premium", ["claude-opus", "gpt-4o"]],
  ["standard", ["claude-sonnet", "gpt-4", "gemini-pro"]],
  ["fast", ["claude-haiku", "gpt-3.5", "gemini-flash"]],
  ["vision", ["claude-vision", "gpt-4-vision", "gpt-4o-vision"]],
]);

const routing = new Map<string, { provider: string; model?: string }[]>([
  ["premium", [{ provider: "anthropic-primary" }, { provider: "openai-fallback" }]],
  ["standard", [{ provider: "anthropic-primary" }, { provider: "openai-fallback" }, { provider: "google-fallback" }]],
  ["fast", [{ provider: "anthropic-primary" }, { provider: "openai-fallback" }]],
  ["vision", [{ provider: "openai-primary" }, { provider: "anthropic-fallback" }]],
]);

const providers = new Map<string, unknown>();
const modelRouting = new Map<string, { provider: string; model?: string }[]>([
  ["claude-3-5-sonnet-20241022", [{ provider: "anthropic-primary", model: "claude-3-5-sonnet-20241022" }]],
  ["gpt-4o-mini", [{ provider: "openai-primary", model: "gpt-4o-mini" }]],
]);

const config: AppConfig = {
  server: { port: 3456, host: "localhost" },
  providers,
  routing,
  tierPatterns,
  modelRouting,
};

const rawBody = JSON.stringify({ model: "test", messages: [{ role: "user", content: "Hello" }] });
const requestId = "bench-request-id";

// Model names for benchmarking
const premiumModel = "claude-opus-4-20250514";
const standardModel = "claude-sonnet-4-20250514";
const fastModel = "claude-haiku-3-20250307";
const visionModel = "gpt-4o-vision-20241120";
const exactRouteModel = "claude-3-5-sonnet-20241022";
const noMatchModel = "llama-3-70b";

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe("Router benchmarks", () => {
  // --- matchTier ---

  describe("matchTier", () => {
    bench("first tier match (premium)", () => {
      matchTier(premiumModel, tierPatterns);
    });

    bench("middle tier match (standard)", () => {
      matchTier(standardModel, tierPatterns);
    });

    bench("last tier match (fast)", () => {
      matchTier(fastModel, tierPatterns);
    });

    bench("no match (returns null)", () => {
      matchTier(noMatchModel, tierPatterns);
    });

    bench("repeated calls with cache hit model (premium)", () => {
      matchTier(premiumModel, tierPatterns);
      matchTier(premiumModel, tierPatterns);
      matchTier(premiumModel, tierPatterns);
      matchTier(premiumModel, tierPatterns);
      matchTier(premiumModel, tierPatterns);
    });
  });

  // --- resolveRequest ---

  describe("resolveRequest", () => {
    bench("tier pattern match (standard)", () => {
      resolveRequest(standardModel, requestId, config, rawBody);
    });

    bench("exact model routing match", () => {
      resolveRequest(exactRouteModel, requestId, config, rawBody);
    });

    bench("no match (returns null)", () => {
      resolveRequest(noMatchModel, requestId, config, rawBody);
    });

    bench("repeated tier match (simulates cache hit pattern)", () => {
      resolveRequest(premiumModel, requestId, config, rawBody);
      resolveRequest(premiumModel, requestId, config, rawBody);
      resolveRequest(premiumModel, requestId, config, rawBody);
      resolveRequest(premiumModel, requestId, config, rawBody);
      resolveRequest(premiumModel, requestId, config, rawBody);
    });
  });

  // --- Scaling with tier count ---

  describe("matchTier scaling with tier count", () => {
    const smallTierPatterns = new Map<string, string[]>([
      ["tier1", ["claude-opus"]],
      ["tier2", ["claude-sonnet"]],
    ]);

    const largeTierPatterns = new Map<string, string[]>();
    for (let i = 0; i < 50; i++) {
      largeTierPatterns.set(`tier-${i}`, [`model-pattern-${i}`]);
    }
    // Target is in the last tier
    largeTierPatterns.set("tier-target", ["model-pattern-target"]);

    bench("2 tiers (small config)", () => {
      matchTier("claude-opus-4-20250514", smallTierPatterns);
    });

    bench("51 tiers (large config, match in last tier)", () => {
      matchTier("model-pattern-target-variant", largeTierPatterns);
    });

    bench("51 tiers (large config, no match)", () => {
      matchTier("nonexistent-model", largeTierPatterns);
    });
  });
});
