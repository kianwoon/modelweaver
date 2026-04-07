import type { SmartRoutingConfig } from "./types.js";

/**
 * Classify the last user message into a tier based on keyword scoring.
 * Checks tier patterns in ascending order (1 = best, 2 = good).
 * Returns the tier number if its cumulative score >= threshold, else null.
 */
export function classifyTier(
  lastMessage: string,
  config: SmartRoutingConfig,
): number | null {
  if (!config.enabled || !lastMessage) return null;

  // Check tiers in ascending order (1 before 2) — lower tier number wins on ties
  const tierKeys = Object.keys(config.patterns)
    .map(Number)
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);

  for (const tierNum of tierKeys) {
    const rules = config.patterns[tierNum];
    if (!rules || rules.length === 0) continue;

    let score = 0;
    for (const rule of rules) {
      const re = rule._compiled;
      if (!re) continue;
      if (re.test(lastMessage)) {
        score += rule.score;
      }
    }

    if (score >= config.escalationThreshold) {
      return tierNum;
    }
  }

  return null;
}

/**
 * Extract the text content of the last user message from a request body.
 * Handles both Anthropic and OpenAI message formats:
 *   - Anthropic: { messages: [{ role: "user", content: [{ type: "text", text: "..." }] }] }
 *   - Anthropic (string content): { messages: [{ role: "user", content: "..." }] }
 * Falls back to concatenating all text content blocks.
 */
export function extractLastUserMessage(
  body: Record<string, unknown>,
): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) return "";

  // Walk backwards to find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const rec = msg as Record<string, unknown>;
    if (rec.role !== "user") continue;

    const content = rec.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          texts.push((block as Record<string, unknown>).text as string);
        }
      }
      return texts.join(" ");
    }
  }

  return "";
}
