// src/proxy.ts
import type { ProviderConfig, RoutingEntry, RequestContext } from "./types.js";

/** Headers forwarded as-is to upstream */
const FORWARD_HEADERS = new Set([
  "anthropic-version",
  "anthropic-beta",
  "content-type",
  "accept",
]);

export function isRetriable(status: number): boolean {
  return status === 429 || status >= 500;
}

const CHARS_PER_TOKEN_ESTIMATE = 2; // LLM tokenizers are more efficient than 4 chars/token
const SAFETY_MARGIN_TOKENS = 2000;  // Reserve for tool schemas, overhead, etc.

/**
 * Estimate token count from a JSON string using character-based heuristic.
 * Conservative: assumes ~4 chars per token (worst case for mixed content with code).
 */
function estimateTokens(value: string | Record<string, unknown>): number {
  const jsonBody = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(jsonBody.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function buildOutboundUrl(baseUrl: string, incomingPath: string): string {
  const base = new URL(baseUrl);
  // new URL("/v1/messages", base) replaces base's path entirely (URL spec).
  // We need to append instead: base.path + incomingPath, normalizing slashes.
  const basePath = base.pathname.replace(/\/+$/, "");
  // Split off query string before path join to avoid encoding issues
  const [pathOnly, queryString] = incomingPath.split("?", 2);

  // Deduplicate /v1 when base URL path already ends with it and incoming path starts with it.
  // e.g. baseUrl="https://api.fireworks.ai/inference/v1" + path="/v1/chat/completions"
  //      → "/inference/v1/chat/completions" (not "/inference/v1/v1/chat/completions")
  const dedupedPath = basePath.endsWith("/v1") && pathOnly.startsWith("/v1")
    ? basePath + pathOnly.slice(3)
    : basePath + pathOnly;

  const resolvedPath = dedupedPath.replace(/\/+/g, "/");
  base.pathname = resolvedPath;
  if (queryString) base.search = "?" + queryString;
  return base.toString();
}

export function buildOutboundHeaders(
  incomingHeaders: Headers,
  provider: ProviderConfig,
  requestId: string
): Headers {
  const headers = new Headers();

  // Forward select headers as-is
  for (const name of FORWARD_HEADERS) {
    const value = incomingHeaders.get(name);
    if (value) headers.set(name, value);
  }

  // Rewrite auth headers based on provider authType
  if (provider.authType === "bearer") {
    headers.set("Authorization", `Bearer ${provider.apiKey}`);
  } else {
    headers.set("x-api-key", provider.apiKey);
  }
  headers.set("x-request-id", requestId);

  // Set host to provider hostname
  try {
    const url = new URL(provider.baseUrl);
    headers.set("host", url.host);
  } catch {
    // If baseUrl is not a valid URL, skip host rewrite
  }

  return headers;
}

/**
 * Remove orphaned tool_use/tool_result pairs from the messages array.
 *
 * In Anthropic's format:
 *   - tool_use blocks live inside assistant message content: { role: "assistant", content: [{ type: "tool_use", id: "call_xxx", ... }] }
 *   - tool_result blocks live inside user message content: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_xxx", ... }] }
 *
 * A tool_result is orphaned if its tool_use_id references a tool_use not in any assistant content block.
 * A tool_use is orphaned if its id has no matching tool_result in any user content block.
 */
function cleanOrphanedToolMessages(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;

  // Collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          toolUseIds.add(String(block.id));
        }
      }
    }
  }

  // Collect all tool_result IDs from user messages
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          toolResultIds.add(String(block.tool_use_id));
        }
      }
    }
  }

  // Find orphaned tool_results and their parent user messages (filter content arrays)
  const orphanedUserIndices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const hasOrphan = msg.content.some(
        (block: Record<string, unknown>) => block.type === "tool_result" && !toolUseIds.has(String(block.tool_use_id))
      );
      if (hasOrphan) orphanedUserIndices.add(i);
    }
  }

  // Find orphaned tool_uses and their parent assistant messages
  const orphanedAssistantIndices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const hasOrphan = msg.content.some(
        (block: Record<string, unknown>) => block.type === "tool_use" && !toolResultIds.has(String(block.id))
      );
      if (hasOrphan) orphanedAssistantIndices.add(i);
    }
  }

  if (orphanedUserIndices.size === 0 && orphanedAssistantIndices.size === 0) return;

  // Filter out orphaned tool references from content arrays
  body.messages = messages.map((msg: Record<string, unknown>, i: number) => {
    if (orphanedUserIndices.has(i) && Array.isArray(msg.content)) {
      return { ...msg, content: msg.content.filter(
        (block: Record<string, unknown>) => !(block.type === "tool_result" && !toolUseIds.has(String(block.tool_use_id)))
      )};
    }
    if (orphanedAssistantIndices.has(i) && Array.isArray(msg.content)) {
      return { ...msg, content: msg.content.filter(
        (block: Record<string, unknown>) => !(block.type === "tool_use" && !toolResultIds.has(String(block.id)))
      )};
    }
    return msg;
  });
}

/**
 * Forward a request to a single provider.
 * Uses ctx.rawBody as the body source; incomingRequest is used for metadata only (url, headers).
 * Returns the Response object — caller decides fallback logic.
 */
export async function forwardRequest(
  provider: ProviderConfig,
  entry: RoutingEntry,
  ctx: RequestContext,
  incomingRequest: Request
): Promise<Response> {
  const outgoingPath = incomingRequest.url.replace(/^https?:\/\/[^/]+/, "");
  const url = buildOutboundUrl(provider.baseUrl, outgoingPath);

  // Prepare body from ctx.rawBody (with optional model override + context guard)
  let body: string = ctx.rawBody;
  const contentType = incomingRequest.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(ctx.rawBody);

      // Model override
      if (entry.model) {
        parsed.model = entry.model;
        ctx.actualModel = entry.model;
      }

      // Clean orphaned tool references from cross-provider conversation history
      cleanOrphanedToolMessages(parsed);

      // Context window guard — check limits and clamp max_tokens
      if (provider.modelLimits) {
        const estimatedInput = estimateTokens(parsed);
        const { maxInputTokens, maxOutputTokens } = provider.modelLimits;

        const requestedMaxTokens = typeof parsed.max_tokens === "number" ? parsed.max_tokens : maxOutputTokens;
        const effectiveOutput = Math.min(requestedMaxTokens, maxOutputTokens);
        const safeInputLimit = Math.max(0, maxInputTokens - effectiveOutput - SAFETY_MARGIN_TOKENS);

        if (estimatedInput > safeInputLimit) {
          return new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "context_window_exceeded",
                message: `Estimated input (~${estimatedInput} tokens) exceeds safe limit (${safeInputLimit} tokens) for provider "${provider.name}" after reserving ${effectiveOutput} output tokens. Consider using /compact or /clear in Claude Code to reduce context.`,
              },
            }),
            {
              status: 400,
              headers: {
                "content-type": "application/json",
                "x-request-id": ctx.requestId,
              },
            }
          );
        }

        // Always set max_tokens to ensure output reservation matches our safety calculation
        if (parsed.max_tokens === undefined || requestedMaxTokens > maxOutputTokens) {
          parsed.max_tokens = effectiveOutput;
        }
      }

      body = JSON.stringify(parsed);
    } catch {
      // If body can't be parsed, send it as-is without model override
    }
  }

  const headers = buildOutboundHeaders(incomingRequest.headers, provider, ctx.requestId);
  headers.set("content-length", new TextEncoder().encode(body).byteLength.toString());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeout);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    // Network errors / timeouts — return a synthetic 502
    const message = error instanceof DOMException && error.name === "AbortError"
      ? `Provider "${provider.name}" timed out after ${provider.timeout}ms`
      : `Provider "${provider.name}" connection failed: ${(error as Error).message}`;

    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message },
      }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }
}

/**
 * Try forwarding through a chain of providers.
 * Returns the first successful response, or 502 if all fail.
 */
export async function forwardWithFallback(
  providers: Map<string, ProviderConfig>,
  chain: RoutingEntry[],
  ctx: RequestContext,
  incomingRequest: Request,
  onAttempt?: (provider: string, index: number) => void
): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const provider = providers.get(entry.provider);

    if (!provider) {
      lastResponse = new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `Unknown provider: ${entry.provider}` },
        }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
      continue;
    }

    onAttempt?.(entry.provider, i);

    // forwardRequest uses ctx.rawBody, so body can be re-read on each attempt
    const response = await forwardRequest(provider, entry, ctx, incomingRequest);
    lastResponse = response;

    // Success — return immediately
    if (response.status >= 200 && response.status < 300) {
      return response;
    }

    // Non-retriable error — fail immediately
    if (!isRetriable(response.status)) {
      return response;
    }

    // Retriable error — if there are more providers, drain body and try next
    if (i < chain.length - 1) {
      await response.body?.cancel();
      continue;
    }
    // Last provider in chain — return the error as-is (body still readable)
    return response;
  }

  // All providers exhausted — return the last real error response if available
  if (lastResponse) {
    return lastResponse;
  }

  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "overloaded_error", message: "All providers exhausted" },
    }),
    { status: 502, headers: { "content-type": "application/json" } }
  );
}
