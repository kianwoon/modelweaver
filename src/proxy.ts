// src/proxy.ts
import type { ProviderConfig, RoutingEntry, RequestContext } from "./types.js";
import { request as undiciRequest } from "undici";

/** Headers forwarded as-is to upstream */
const FORWARD_HEADERS = new Set([
  "anthropic-version",
  "anthropic-beta",
  "content-type",
  "accept",
]);

/** Pre-compiled regex for normalizing duplicate slashes in URL paths */
const MULTI_SLASH = /\/+/g;

/** Module-level TextEncoder — avoids per-request allocation */
const textEncoder = new TextEncoder();

export function isRetriable(status: number): boolean {
  return status === 429 || status >= 500;
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

  const resolvedPath = dedupedPath.replace(MULTI_SLASH, "/");
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

  // Set host to provider hostname (use cached components when available)
  const cachedHost = provider._cachedHost;
  if (cachedHost) {
    headers.set("host", cachedHost);
  } else {
    try {
      const url = new URL(provider.baseUrl);
      headers.set("host", url.host);
    } catch {
      // If baseUrl is not a valid URL, skip host rewrite
    }
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

  // Pass 1: Collect tool_use IDs and tool_result IDs in a single pass,
  // and record which message indices have orphaned blocks
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  const needsFiltering = new Map<number, "user" | "assistant">();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;

    if (msg.role === "assistant") {
      let hasOrphan = false;
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          toolUseIds.add(String(block.id));
          if (!toolResultIds.has(String(block.id))) hasOrphan = true;
        }
      }
      // Note: toolResultIds may not be fully populated yet, so we defer judgment
      // on assistant orphans to after the full pass.
    } else if (msg.role === "user") {
      let hasOrphan = false;
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          toolResultIds.add(String(block.tool_use_id));
          if (!toolUseIds.has(String(block.tool_use_id))) hasOrphan = true;
        }
      }
      if (hasOrphan) needsFiltering.set(i, "user");
    }
  }

  // Check assistant messages for orphans now that toolResultIds is complete
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const hasOrphan = msg.content.some(
        (block: Record<string, unknown>) => block.type === "tool_use" && !toolResultIds.has(String(block.id))
      );
      if (hasOrphan) needsFiltering.set(i, "assistant");
    }
  }

  if (needsFiltering.size === 0) return;

  // Pass 2: Filter out orphaned tool references from content arrays
  body.messages = messages.map((msg: Record<string, unknown>, i: number) => {
    const filterType = needsFiltering.get(i);
    if (filterType && Array.isArray(msg.content)) {
      const filtered = msg.content.filter((block: Record<string, unknown>) => {
        if (filterType === "user") {
          return !(block.type === "tool_result" && !toolUseIds.has(String(block.tool_use_id)));
        }
        return !(block.type === "tool_use" && !toolResultIds.has(String(block.id)));
      });
      if (filtered.length === msg.content.length) return msg; // nothing was actually filtered
      return { ...msg, content: filtered };
    }
    return msg;
  });

  // Pass 3: Re-check user messages after assistant cleanup.
  // After Pass 2 removed orphaned tool_use blocks from assistant messages, some
  // user tool_result blocks may now reference tool_use IDs that no longer exist.
  // Rebuild valid IDs from the cleaned messages and strip dangling user tool_results.
  const validToolUseIds = new Set<string>();
  for (const msg of body.messages as Record<string, unknown>[]) {
    if (!Array.isArray(msg.content)) continue;
    if (msg.role === "assistant") {
      for (const block of msg.content as Record<string, unknown>[]) {
        if (block.type === "tool_use" && block.id) validToolUseIds.add(String(block.id));
      }
    }
  }

  body.messages = (body.messages as Record<string, unknown>[]).map((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const filtered = msg.content.filter(
        (block: Record<string, unknown>) =>
          !(block.type === "tool_result" && !validToolUseIds.has(String(block.tool_use_id)))
      );
      if (filtered.length === msg.content.length) return msg;
      return { ...msg, content: filtered };
    }
    return msg;
  });
}

/**
 * Forward a request to a single provider.
 * Uses ctx.parsedBody when available (avoids re-parsing); falls back to ctx.rawBody.
 * incomingRequest is used for metadata only (url, headers).
 * Returns the Response object — caller decides fallback logic.
 */
export async function forwardRequest(
  provider: ProviderConfig,
  entry: RoutingEntry,
  ctx: RequestContext,
  incomingRequest: Request,
  externalSignal?: AbortSignal
): Promise<Response> {
  const outgoingPath = incomingRequest.url.replace(/^https?:\/\/[^/]+/, "");

  // Set actualModel early so metrics always record the routed model,
  // even if body parsing or the fetch itself fails
  if (entry.model) {
    ctx.actualModel = entry.model;
  }

  // Use cached URL components when available (avoids per-request URL parsing)
  const cachedBaseUrl = provider._cachedBaseUrl;
  const url = buildOutboundUrl(cachedBaseUrl ?? provider.baseUrl, outgoingPath);

  // Prepare body — prefer pre-parsed object to avoid double JSON.parse
  let body: string;
  const contentType = incomingRequest.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      const parsed = (ctx as RequestContext & { parsedBody?: Record<string, unknown> }).parsedBody
        ?? JSON.parse(ctx.rawBody);

      // Deep clone so mutations from this attempt don't affect the next fallback attempt
      const mutable = structuredClone(parsed);

      // Model override in the request body
      if (entry.model) {
        const originalModel = mutable.model as string | undefined;
        mutable.model = entry.model;
        if (originalModel && originalModel !== entry.model) {
          console.warn(
            `Routing override: ${originalModel} → ${entry.model} via ${provider.name}`
          );
        }
      }

      // Clean orphaned tool references from cross-provider conversation history
      cleanOrphanedToolMessages(mutable);

      // Clamp max_tokens to provider's advertised output limit (let upstream handle input context checks)
      if (provider.modelLimits) {
        const { maxOutputTokens } = provider.modelLimits;
        const requestedMaxTokens = typeof mutable.max_tokens === "number" ? mutable.max_tokens : maxOutputTokens;
        if (mutable.max_tokens === undefined || requestedMaxTokens > maxOutputTokens) {
          mutable.max_tokens = Math.min(requestedMaxTokens, maxOutputTokens);
        }
      }

      body = JSON.stringify(mutable);
    } catch {
      // If body can't be parsed, send it as-is without model override
      body = ctx.rawBody;
    }
  } else {
    body = ctx.rawBody;
  }

  const headers = buildOutboundHeaders(incomingRequest.headers, provider, ctx.requestId);
  headers.set("content-length", textEncoder.encode(body).byteLength.toString());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeout);

  // Listen for external abort (from race cancellation) to abort this request
  if (externalSignal) {
    if (externalSignal.aborted) {
      // Already aborted — don't even start the request
      clearTimeout(timeout);
      const body = JSON.stringify({
          type: "error",
          error: { type: "overloaded_error", message: `Provider "${provider.name}" cancelled by race winner` },
        });
      return new Response(body, {
        status: 502,
        headers: {
          "content-type": "application/json",
          "content-length": textEncoder.encode(body).byteLength.toString(),
        },
      });
    }
    const onExternalAbort = () => {
      clearTimeout(timeout);
    };
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const undiciResponse = await undiciRequest(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      dispatcher: provider._agent,
    });

    // Wrap undici response as a standard Web Response for downstream compatibility
    const response = new Response(
      undiciResponse.body as unknown as BodyInit,
      {
        status: undiciResponse.statusCode,
        headers: undiciResponse.headers as unknown as HeadersInit,
      }
    );

    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    // Network errors / timeouts — return a synthetic 502
    const message = error instanceof DOMException && error.name === "AbortError"
      ? `Provider "${provider.name}" timed out after ${provider.timeout}ms`
      : `Provider "${provider.name}" connection failed: ${(error as Error).message}`;

    const body = JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message },
      });
    return new Response(body, {
      status: 502,
      headers: {
        "content-type": "application/json",
        "content-length": textEncoder.encode(body).byteLength.toString(),
      },
    });
  }
}

/**
 * Race multiple providers simultaneously. Returns the first successful response.
 * Aborts all remaining requests once a winner is found.
 */
async function raceProviders(
  chain: RoutingEntry[],
  providers: Map<string, ProviderConfig>,
  ctx: RequestContext,
  incomingRequest: Request,
  onAttempt?: (provider: string, index: number) => void,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
): Promise<Response> {
  const sharedController = new AbortController();

  const races = chain.map(async (entry, index): Promise<{ response: Response; index: number }> => {
    const provider = providers.get(entry.provider);
    if (!provider) {
      const errBody = JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `Unknown provider: ${entry.provider}` },
        });
      return {
        response: new Response(errBody, {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
        index,
      };
    }

    // Check circuit breaker
    if (provider._circuitBreaker && !provider._circuitBreaker.canProceed()) {
      const errBody = JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `Provider "${entry.provider}" skipped by circuit breaker` },
        });
      return {
        response: new Response(errBody, {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
        index,
      };
    }

    onAttempt?.(entry.provider, index);

    try {
      const response = await forwardRequest(provider, entry, ctx, incomingRequest, sharedController.signal);
      // Record for circuit breaker
      if (provider._circuitBreaker) {
        provider._circuitBreaker.recordResult(response.status);
      }
      return { response, index };
    } catch {
      if (provider._circuitBreaker) {
        provider._circuitBreaker.recordResult(502);
      }
      const errBody = JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `Provider "${entry.provider}" failed` },
        });
      return {
        response: new Response(errBody, {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
        index,
      };
    }
  });

  // Track completed promises to avoid double-processing
  const completed = new Set<Promise<{ response: Response; index: number }>>();
  const failures: { response: Response; index: number }[] = [];

  try {
    while (completed.size < races.length) {
      const pending = races.filter(r => !completed.has(r));
      if (pending.length === 0) break;

      const winner = await Promise.race(pending);
      completed.add(races[winner.index] ?? races[0]);

      if (winner.response.status >= 200 && winner.response.status < 300) {
        sharedController.abort();
        return winner.response;
      }

      // Non-retriable error — propagate immediately
      if (!isRetriable(winner.response.status)) {
        sharedController.abort();
        return winner.response;
      }

      // Retriable but not success — record and continue waiting
      failures.push(winner);
    }

    // All providers returned retriable errors — return the first failure
    sharedController.abort();
    if (failures.length > 0) {
      return failures[0].response;
    }

    const errBody = JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "All providers in race failed" },
      });
    return new Response(errBody, {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  } catch {
    sharedController.abort();
    const errBody = JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "All providers in race failed" },
      });
    return new Response(errBody, {
      status: 502,
      headers: { "content-type": "application/json" },
    });
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
  onAttempt?: (provider: string, index: number) => void,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const provider = providers.get(entry.provider);

    if (!provider) {
      const errBody = JSON.stringify({
          type: "error",
          error: { type: "api_error", message: `Unknown provider: ${entry.provider}` },
        });
      lastResponse = new Response(errBody, {
        status: 502,
        headers: {
          "content-type": "application/json",
          "content-length": textEncoder.encode(errBody).byteLength.toString(),
        },
      });
      continue;
    }

    // Check circuit breaker before attempting provider
    if (provider._circuitBreaker && !provider._circuitBreaker.canProceed()) {
      logger?.warn("Provider skipped by circuit breaker", { requestId: ctx.requestId, provider: entry.provider });
      continue;
    }

    onAttempt?.(entry.provider, i);

    // forwardRequest uses ctx.rawBody, so body can be re-read on each attempt
    const response = await forwardRequest(provider, entry, ctx, incomingRequest);
    lastResponse = response;

    // Record result for circuit breaker
    if (provider._circuitBreaker) {
      provider._circuitBreaker.recordResult(response.status);
    }

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

      // On 429: race remaining providers simultaneously
      if (response.status === 429 && i + 1 < chain.length) {
        ctx.fallbackMode = "race";
        const remaining = chain.slice(i + 1);
        return raceProviders(remaining, providers, ctx, incomingRequest, onAttempt, logger);
      }
      continue;
    }
    // Last provider in chain — return the error as-is (body still readable)
    return response;
  }

  // All providers exhausted — return the last real error response if available
  if (lastResponse) {
    return lastResponse;
  }

  const fallbackBody = JSON.stringify({
    type: "error",
    error: { type: "overloaded_error", message: "All providers exhausted" },
  });
  return new Response(fallbackBody, {
    status: 502,
    headers: {
      "content-type": "application/json",
      "content-length": textEncoder.encode(fallbackBody).byteLength.toString(),
    },
  });
}
