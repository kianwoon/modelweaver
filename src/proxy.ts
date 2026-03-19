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

export function buildOutboundUrl(baseUrl: string, incomingPath: string): string {
  const base = new URL(baseUrl);
  // new URL("/v1/messages", base) replaces base's path entirely (URL spec).
  // We need to append instead: base.path + incomingPath, normalizing slashes.
  const basePath = base.pathname.replace(/\/+$/, "");
  // Split off query string before path join to avoid encoding issues
  const [pathOnly, queryString] = incomingPath.split("?", 2);
  const resolvedPath = (basePath + pathOnly).replace(/\/+/g, "/");
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

  // Prepare body from ctx.rawBody (with optional model override)
  let body: string = ctx.rawBody;
  const contentType = incomingRequest.headers.get("content-type") || "";

  if (contentType.includes("application/json") && entry.model) {
    try {
      const parsed = JSON.parse(ctx.rawBody);
      parsed.model = entry.model;
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

    // Retriable error — drain body to prevent connection leak, then try next provider
    await response.body?.cancel();
    continue;
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
