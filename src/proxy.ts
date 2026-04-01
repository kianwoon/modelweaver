// src/proxy.ts
import type { HedgingConfig, ProviderConfig, RequestContext, RoutingEntry, StreamState } from "./types.js";
import { transitionStreamState } from "./types.js";
import { request as undiciRequest } from "undici";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { latencyTracker, inFlightCounter, computeHedgingCount, recordHedgeWin, recordHedgeLosses } from './hedging.js';
import { broadcastStreamEvent } from './ws.js';

// --- Per-provider latency metrics ---
const providerLatencySamples: Map<string, number[]> = new Map();
const LATENCY_SAMPLE_THRESHOLD = 100;

export function recordProviderLatency(providerName: string, latencyMs: number): void {
  let samples = providerLatencySamples.get(providerName);
  if (!samples) {
    samples = [];
    providerLatencySamples.set(providerName, samples);
  }
  samples.push(latencyMs);
  if (samples.length >= LATENCY_SAMPLE_THRESHOLD) {
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const p99 = samples[Math.floor(samples.length * 0.99)];
    console.log(`[metrics] ${providerName} latency (n=${samples.length}): P50=${p50}ms P95=${p95}ms P99=${p99}ms`);
    samples.length = 0; // reset
  }
}

export function pruneProviderLatencySamples(activeProviders: string[]): void {
  const active = new Set(activeProviders);
  for (const name of providerLatencySamples.keys()) {
    if (!active.has(name)) {
      providerLatencySamples.delete(name);
    }
  }
}

/**
 * Shallow-clone a parsed API request body just enough so that
 * cleanOrphanedToolMessages() can safely reassign body.messages
 * without affecting the original parsed object.
 *
 * cleanOrphanedToolMessages either:
 *   - leaves body.messages untouched (no orphans found), or
 *   - replaces body.messages with a new array (via .map())
 * It never mutates individual message objects in-place.
 * Therefore a one-level-deep clone of the messages array is sufficient.
 */
function shallowCloneForMutation(parsed: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...parsed };
  if (Array.isArray(clone.messages)) {
    clone.messages = [...clone.messages];
  }
  return clone;
}

/** Pre-compiled regex for normalizing duplicate slashes in URL paths */
const MULTI_SLASH = /\/+/g;

/** Pre-compiled regex for stripping origin from URLs */
const STRIP_ORIGIN = /^https?:\/\/[^/]+/;

/** Pre-compiled regexes for targeted body replacements (preserve prompt caching) */
const MODEL_KEY_REGEX = /"model"\s*:\s*"([^"]*)"/;
const MODEL_KEY_TEST = /"model"\s*:\s*"([^"]*)"/;
const MAX_TOKENS_REGEX = /"max_tokens"\s*:\s*(\d+)/;

/** Module-level TextEncoder — avoids per-request allocation */
const textEncoder = new TextEncoder();

/** Module-level Set of headers to forward from incoming requests */
const KNOWN_FORWARD_HEADERS = new Set([
  "anthropic-version",
  "anthropic-beta",
  "content-type",
  "accept",
]);

/** Pre-built regex combinations for targeted body replacements */
const REPLACEMENT_REGEX_MODEL = new RegExp(MODEL_KEY_REGEX.source, "g");
const REPLACEMENT_REGEX_MAX_TOKENS = new RegExp(MAX_TOKENS_REGEX.source, "g");
const REPLACEMENT_REGEX_BOTH = new RegExp(MODEL_KEY_REGEX.source + "|" + MAX_TOKENS_REGEX.source, "g");

// --- Pre-built error response helpers ---

const ERR_HEADERS = Object.freeze({ "content-type": "application/json" });

function makeErrorResponse(status: number, type: string, message: string): Response {
  const body = JSON.stringify({ type: "error", error: { type, message } });
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": textEncoder.encode(body).byteLength.toString(),
    },
  });
}

function unknownProviderErr(providerName: string): Response {
  const body = JSON.stringify({
    type: "error",
    error: { type: "api_error", message: `Unknown provider: ${providerName}` },
  });
  return new Response(body, {
    status: 502,
    headers: { ...ERR_HEADERS, "content-length": String(textEncoder.encode(body).byteLength) },
  });
}

function circuitBreakerErr(providerName: string): Response {
  const body = JSON.stringify({
    type: "error",
    error: { type: "api_error", message: `Provider "${providerName}" skipped by circuit breaker` },
  });
  return new Response(body, {
    status: 502,
    headers: { ...ERR_HEADERS, "content-length": String(textEncoder.encode(body).byteLength) },
  });
}

/** Default delay (ms) before starting backup providers in staggered race */
const DEFAULT_SPECULATIVE_DELAY = 1000;

export function isRetriable(status: number): boolean {
  return status === 429 || status >= 500;
}

const CONTEXT_WINDOW_PATTERNS = [
  'context window', 'context_limit', 'token limit',
  'prompt is too long', 'max tokens', 'input too large', 'too many tokens',
];

function isContextWindowError(status: number, body: string): boolean {
  if (status !== 400 && status !== 413) return false;
  const lower = body.toLowerCase();
  return CONTEXT_WINDOW_PATTERNS.some(p => lower.includes(p));
}

function handleContextWindowError(status: number, body: string): Response | null {
  if (!isContextWindowError(status, body)) return null;

  // Fire-and-forget async I/O to avoid blocking the event loop on the hot path.
  // Only triggers on 400/413 context window errors (rare path).
  fs.promises.mkdir(path.join(os.homedir(), '.claude', 'state'), { recursive: true })
    .then(() => fs.promises.writeFile(path.join(os.homedir(), '.claude', 'state', 'context-compact-needed'), Date.now().toString()))
    .catch(() => { /* best-effort */ });

  const enhanced = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Context window limit reached. Run /compact to reduce conversation size, then retry.",
    },
  });
  return new Response(enhanced, {
    status: 413,
    headers: { "content-type": "application/json" },
  });
}

export function buildOutboundUrl(
  baseUrlOrProvider: string | { baseUrl: string; _cachedOrigin?: string; _cachedPathname?: string },
  incomingPath: string,
): string {
  // Extract baseUrl and cached components
  let baseUrl: string;
  let cachedOrigin: string | undefined;
  let cachedPathname: string | undefined;

  if (typeof baseUrlOrProvider === 'object' && baseUrlOrProvider !== null) {
    baseUrl = baseUrlOrProvider.baseUrl;
    cachedOrigin = baseUrlOrProvider._cachedOrigin;
    cachedPathname = baseUrlOrProvider._cachedPathname;
  } else {
    baseUrl = baseUrlOrProvider;
  }

  let basePath = "";
  let origin = baseUrl;

  // Use cached values when available (avoids re-parsing baseUrl on every request)
  if (cachedOrigin && cachedPathname !== undefined) {
    origin = cachedOrigin;
    basePath = cachedPathname;
  } else {
    const slashIndex = baseUrl.indexOf('/', baseUrl.indexOf('//') + 2);
    if (slashIndex !== -1) {
      origin = baseUrl.substring(0, slashIndex);
      basePath = baseUrl.substring(slashIndex);
    }
  }

  let incomingQuery = "";
  let incomingOnly = incomingPath;
  const qIndex = incomingPath.indexOf('?');
  if (qIndex !== -1) {
    incomingOnly = incomingPath.substring(0, qIndex);
    incomingQuery = incomingPath.substring(qIndex);
  }

  // Deduplicate /v1 when base URL path already ends with it and incoming path starts with it.
  // e.g. baseUrl="https://api.fireworks.ai/inference/v1" + path="/v1/chat/completions"
  //      → "/inference/v1/chat/completions" (not "/inference/v1/v1/chat/completions")
  let resolvedPath;
  if (basePath.endsWith('/v1') && incomingOnly.startsWith('/v1')) {
    resolvedPath = basePath + incomingOnly.substring(3);
  } else {
    resolvedPath = basePath + incomingOnly;
  }

  // Normalize duplicate slashes
  resolvedPath = resolvedPath.replace(MULTI_SLASH, "/");

  return origin + resolvedPath + incomingQuery;
}

export function buildOutboundHeaders(
  incomingHeaders: Headers,
  provider: ProviderConfig,
  requestId: string
): Headers {
  const headers = new Headers();

  // Forward known headers and all x-* custom headers
  for (const [name, value] of incomingHeaders.entries()) {
    const lower = name.toLowerCase();
    if (KNOWN_FORWARD_HEADERS.has(lower) || lower.startsWith("x-")) {
      headers.set(name, value);
    }
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
 *
 * Single-pass: collects all IDs, computes orphans, then filters once.
 */
function cleanOrphanedToolMessages(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;

  // Fast exit: count tool blocks — if none exist, skip entirely
  let hasToolBlocks = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" || block.type === "tool_result") {
        hasToolBlocks = true;
        break;
      }
    }
    if (hasToolBlocks) break;
  }
  if (!hasToolBlocks) return;

  // Single collection pass — gather every tool_use and tool_result ID
  const allToolUseIds = new Set<string>();
  const allToolResultIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        allToolUseIds.add(String(block.id));
      } else if (block.type === "tool_result" && block.tool_use_id) {
        allToolResultIds.add(String(block.tool_use_id));
      }
    }
  }

  // Check if any orphans exist before doing filter work
  let hasOrphans = false;
  for (const id of allToolUseIds) {
    if (!allToolResultIds.has(id)) { hasOrphans = true; break; }
  }
  if (!hasOrphans) {
    for (const id of allToolResultIds) {
      if (!allToolUseIds.has(id)) { hasOrphans = true; break; }
    }
  }
  if (!hasOrphans) return;

  // Filter pass — mutate messages in-place instead of creating new array
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;

    let filteredCount = 0;
    for (const block of msg.content) {
      if (block.type === "tool_use" && !allToolResultIds.has(String(block.id))) continue;
      if (block.type === "tool_result" && !allToolUseIds.has(String(block.tool_use_id))) continue;
      msg.content[filteredCount] = block;
      filteredCount++;
    }

    if (filteredCount < msg.content.length) {
      msg.content.length = filteredCount;
    }
  }
}

/**
 * Apply targeted string replacements to rawBody to preserve prompt caching.
 * On the primary attempt (chainIndex === 0), we avoid full JSON.stringify which
 * breaks Anthropic's cache breakpoints (position-sensitive, whitespace/order-sensitive).
 * Falls back to full JSON parse/mutate/stringify when structural changes are needed.
 */
function applyTargetedReplacements(
  rawBody: string,
  entry: RoutingEntry,
  provider: ProviderConfig,
  parsed: Record<string, unknown>,
  needsOrphanClean: boolean,
): string {
  // If orphan cleaning is needed, we must do full JSON parse (structural changes to messages)
  if (needsOrphanClean) {
    // shallow clone: cleanOrphanedToolMessages reassigns body.messages
    const mutable = shallowCloneForMutation(parsed);
    if (entry.model) mutable.model = entry.model;
    cleanOrphanedToolMessages(mutable);
    if (provider.modelLimits) {
      const { maxOutputTokens } = provider.modelLimits;
      const requested = typeof mutable.max_tokens === "number" ? mutable.max_tokens : maxOutputTokens;
      if (mutable.max_tokens === undefined || requested > maxOutputTokens) {
        mutable.max_tokens = Math.min(requested, maxOutputTokens);
      }
    }
    return JSON.stringify(mutable);
  }

  // Targeted replacement path -- only model override and/or max_tokens clamping.
  // Single-pass: build a combined regex with alternation so the entire raw body
  // string is scanned and replaced in one call instead of per-pattern copies.
  const needsModel = !!(entry.model && (parsed.model as string | undefined) !== entry.model);
  let needsMaxTokensClamp = false;
  let needsMaxTokensAdd = false;
  let maxOutputTokens = 0;
  if (provider.modelLimits) {
    maxOutputTokens = provider.modelLimits.maxOutputTokens;
    const m = MAX_TOKENS_REGEX.exec(rawBody);
    if (m) {
      needsMaxTokensClamp = parseInt(m[1], 10) > maxOutputTokens;
    } else if (typeof parsed.max_tokens !== "number") {
      needsMaxTokensAdd = true;
    }
  }

  if (!needsModel && !needsMaxTokensClamp && !needsMaxTokensAdd) return rawBody;

  // max_tokens not in body at all — insert via targeted replacement to preserve prompt cache.
  // Find the last top-level closing brace and insert before it.
  // This avoids JSON.stringify which reorders keys and breaks cache breakpoints.
  if (needsMaxTokensAdd) {
    const insert = `"max_tokens":${maxOutputTokens}`;
    // Check if there's a trailing value before the closing brace to determine comma placement
    const lastBraceIdx = rawBody.lastIndexOf('}');
    if (lastBraceIdx > 0) {
      const beforeBrace = rawBody.substring(0, lastBraceIdx).trimEnd();
      const needsComma = beforeBrace.length > 0 && !beforeBrace.endsWith(',');
      let result = rawBody.substring(0, lastBraceIdx).replace(/\s*$/, '') +
        (needsComma ? ',' : '') + insert + '}';
      // Also apply model replacement if needed
      if (needsModel && entry.model) {
        result = result.replace(MODEL_KEY_REGEX, `"model":"${entry.model}"`);
      }
      return result;
    }
    // Fallback to full stringify if body structure is unexpected
    const mutable = { ...parsed };
    if (entry.model) mutable.model = entry.model;
    mutable.max_tokens = maxOutputTokens;
    return JSON.stringify(mutable);
  }

  // Use pre-built regex for single-pass replacement
  const combinedRegex = needsModel && needsMaxTokensClamp
    ? REPLACEMENT_REGEX_BOTH
    : needsModel
      ? REPLACEMENT_REGEX_MODEL
      : REPLACEMENT_REGEX_MAX_TOKENS;

  // Capture values for the replacer (avoid repeated property access)
  const modelRepl = needsModel ? `"model":"${entry.model}"` : null;
  const tokensRepl = needsMaxTokensClamp ? `"max_tokens":${maxOutputTokens}` : null;
  const origModel = parsed.model as string | undefined;
  let modelLogged = false;

  const result = rawBody.replace(combinedRegex, (match: string) => {
    if (modelRepl && MODEL_KEY_TEST.test(match)) {
      if (!modelLogged && origModel) {
        console.warn(`Routing override: ${origModel} -> ${entry.model} via ${provider.name}`);
        modelLogged = true;
      }
      return modelRepl;
    }
    if (tokensRepl && MAX_TOKENS_REGEX.test(match)) {
      MAX_TOKENS_REGEX.lastIndex = 0;
      return tokensRepl;
    }
    return match;
  });

  return result;
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
  externalSignal?: AbortSignal,
  chainIndex: number = 0,
): Promise<Response> {
  const outgoingPath = incomingRequest.url.replace(STRIP_ORIGIN, "");

  // Set actualModel early so metrics always record the routed model,
  // even if body parsing or the fetch itself fails
  if (entry.model) {
    ctx.actualModel = entry.model;
  }

  // Build outbound URL from provider base URL and request path
  const url = buildOutboundUrl(provider, outgoingPath);

  // Prepare body — prefer raw passthrough to preserve upstream prompt caching.
  // Only parse and re-serialize when a modification is actually required,
  // because Anthropic's cache breakpoints are position-sensitive and
  // JSON.stringify changes whitespace / key order, breaking cache hits.
  let body: string;
  const contentType = incomingRequest.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      const parsed = (ctx as RequestContext & { parsedBody?: Record<string, unknown> }).parsedBody
        ?? JSON.parse(ctx.rawBody);

      // Determine whether any body modification is needed
      let needsModification = false;

      // Check 1: Model override needed?
      if (entry.model && (parsed.model as string | undefined) !== entry.model) {
        needsModification = true;
      }

      // Check 2: Orphan cleaning needed? (only for fallback attempts, not primary)
      // On the primary attempt (index 0), conversation history is intact.
      // Only when falling back (index > 0) do cross-provider orphans appear.
      const needsOrphanClean = chainIndex > 0;
      if (needsOrphanClean) needsModification = true;

      // Check 3: max_tokens clamping needed?
      if (provider.modelLimits) {
        const { maxOutputTokens } = provider.modelLimits;
        const requestedMaxTokens = typeof parsed.max_tokens === "number" ? parsed.max_tokens : maxOutputTokens;
        if (parsed.max_tokens === undefined || requestedMaxTokens > maxOutputTokens) {
          needsModification = true;
        }
      }

      if (needsModification) {
        // On primary attempt (chainIndex === 0) without orphan cleaning, use targeted
        // string replacements to preserve prompt caching. Anthropic's cache breakpoints
        // are position-sensitive -- JSON.stringify changes whitespace/order, breaking hits.
        if (chainIndex === 0 && !needsOrphanClean) {
          body = applyTargetedReplacements(ctx.rawBody, entry, provider, parsed, false);
        } else {
          // Fallback attempts: full JSON parse/mutate/stringify (caching already broken)
          // shallow clone: cleanOrphanedToolMessages reassigns body.messages
          const mutable = shallowCloneForMutation(parsed);

          if (entry.model) {
            const originalModel = mutable.model as string | undefined;
            mutable.model = entry.model;
            if (originalModel && originalModel !== entry.model) {
              console.warn(
                `Routing override: ${originalModel} -> ${entry.model} via ${provider.name}`
              );
            }
          }

          if (needsOrphanClean) {
            cleanOrphanedToolMessages(mutable);
          }

          if (provider.modelLimits) {
            const { maxOutputTokens } = provider.modelLimits;
            const requestedMaxTokens = typeof mutable.max_tokens === "number" ? mutable.max_tokens : maxOutputTokens;
            if (mutable.max_tokens === undefined || requestedMaxTokens > maxOutputTokens) {
              mutable.max_tokens = Math.min(requestedMaxTokens, maxOutputTokens);
            }
          }

          body = JSON.stringify(mutable);
        }
      } else {
        // No modifications needed — passthrough raw body to preserve prompt caching
        body = ctx.rawBody;
      }
    } catch {
      // If body can't be parsed, send it as-is without model override
      body = ctx.rawBody;
    }
  } else {
    body = ctx.rawBody;
  }

  const headers = buildOutboundHeaders(incomingRequest.headers, provider, ctx.requestId);
  headers.set("content-length", Buffer.byteLength(body, 'utf-8').toString());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeout);

  // TTFB timeout: fail if no response headers received within ttfbTimeout ms
  const ttfbTimeout = provider.ttfbTimeout ?? 8000;
  let ttfbTimedOut = false;
  let ttfbTimer: ReturnType<typeof setTimeout> | null = null;

  // TTFB timer: fires after ttfbTimeout ms if no response headers received.
  // The finally block in forwardRequest clears the timer before any async ops resume,
  // so this timeout can only fire between timer creation and first response byte.
  const ttfbPromise = new Promise<never>((_, reject) => {
    ttfbTimer = setTimeout(() => {
      ttfbTimedOut = true;
      ttfbTimer = null; // null out so catch can detect TTFB fired vs pending
      controller.abort();
      reject(new Error(`TTFB timeout after ${ttfbTimeout}ms`));
    }, ttfbTimeout);
  });

  // Listen for external abort (from race cancellation) to abort this request
  let removeAbortListener: (() => void) | undefined;
  let upstreamBody: import("node:stream").Readable | undefined;
  let passThrough: PassThrough | undefined;
  let stallTimerRef: ReturnType<typeof setTimeout> | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      // Already aborted — don't even start the request
      clearTimeout(timeout);
      if (ttfbTimer) clearTimeout(ttfbTimer);
      return makeErrorResponse(502, "overloaded_error", `Provider "${provider.name}" cancelled by race winner`);
    }
    // Increase max listeners to prevent Node.js warning when multiple providers race
    // and all listen to the same sharedController.signal
    const prevMax = (externalSignal as any).getMaxListeners?.() ?? 10;
    (externalSignal as any).setMaxListeners?.(prevMax + 1);
    const onExternalAbort = () => {
      clearTimeout(timeout);
      if (ttfbTimer) clearTimeout(ttfbTimer);
      if (stallTimerRef) clearTimeout(stallTimerRef);
      console.log(`[hedge] Cancelling provider "${provider.name}" — race winner found`);
      // Mark upstream as intentionally closed to prevent undici from
      // propagating "socket closed unexpectedly" during hedge cancellation
      if (upstreamBody && !upstreamBody.destroyed) {
        (upstreamBody as any)._intentionalClose = true;
      }
      // Destroy upstream body and passThrough to free the connection back to the pool.
      // Deferred to avoid throwing inside AbortSignal event dispatch.
      setImmediate(() => {
        if (upstreamBody && !upstreamBody.destroyed && !(upstreamBody as any).readableEnded) {
          try { (upstreamBody.destroy() as any).catch?.(() => {}); } catch { /* already consumed */ }
        }
        if (passThrough && !passThrough.destroyed) {
          passThrough.destroy(new Error("Cancelled"));
        }
      });
    };
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    removeAbortListener = () => {
      externalSignal.removeEventListener("abort", onExternalAbort);
      (externalSignal as any).setMaxListeners?.((externalSignal as any).getMaxListeners?.() - 1);
    };
  }

  try {
    const undiciResponse = await Promise.race([
      undiciRequest(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        dispatcher: provider._agent,
      }),
      ttfbPromise,
    ]);

    // TTFB succeeded — cancel TTFB timer
    if (ttfbTimer) clearTimeout(ttfbTimer);

    // Track upstream body for cleanup on error paths
    upstreamBody = undiciResponse.body;

    // Guard against uncaught error events when the pipe is torn down
    // after passThrough.destroy() fires before upstreamBody.destroy().
    // When _intentionalClose is set (hedge cancel or stall abort), swallow
    // undici's "socket closed unexpectedly" warning — the close is expected.
    upstreamBody.on("error", (err: Error) => {
      if (stallTimerRef) clearTimeout(stallTimerRef);
      if ((upstreamBody as any)._intentionalClose) return; // expected — suppress
      console.warn(`[proxy] Upstream body error on "${provider.name}": ${err.message}`);
    });

    // For error status codes (4xx/5xx), consume body immediately without stall detection.
    // Rate limits (429) and server errors (5xx) return small JSON bodies that arrive instantly.
    if (undiciResponse.statusCode >= 400) {
      clearTimeout(timeout);
      const errBody = await undiciResponse.body.text();
      return new Response(errBody, {
        status: undiciResponse.statusCode,
        statusText: undiciResponse.statusText,
        headers: undiciResponse.headers as unknown as HeadersInit,
      });
    }

    // Non-standard upstream response (e.g., plain text/buffer) — send as-is without stall detection.
    // Check this BEFORE creating passThrough so we avoid the allocation when not needed.
    if (!undiciResponse.body || typeof undiciResponse.body.pipe !== 'function') {
      const fallback = undiciResponse.body
        ? new ReadableStream({ start(controller) { controller.enqueue(textEncoder.encode(String(undiciResponse.body))); controller.close(); } })
        : new ReadableStream({ start(controller) { controller.close(); } });
      return new Response(fallback, {
        status: undiciResponse.statusCode,
        headers: undiciResponse.headers as unknown as HeadersInit,
      });
    }

    // Body stall detection: pipe through PassThrough to monitor for data without
    // interfering with undici's internal stream state (no flowing mode conflict).
    // Uses a single interval that checks a timestamp instead of per-chunk setTimeout/clearTimeout,
    // reducing syscall-level overhead on every data event.
    const stallTimeout = provider.stallTimeout ?? 15000;
    passThrough = new PassThrough();

    const stallMsg = `Body stalled: no data after ${stallTimeout}ms`;
    let lastDataTime = Date.now();

    const handleStall = () => {
      // Guard: bail if already fired or stream is in a terminal state
      if ((ctx as any)._stallFired) return;
      if (ctx._streamState === "error" || ctx._streamState === "complete") return; // fast-path for _stallFired
      (ctx as any)._stallFired = true;
      provider._circuitBreaker?.recordResult(502);
      console.warn(`[stall] Provider "${provider.name}" stalled: no data after ${stallTimeout}ms`);

      // Inject an Anthropic-compatible SSE error event so Claude Code's SDK
      // parses it as a retriable error and fires again automatically.
      // Format: "event: error\ndata: {"type":"error","error":{"type":"api_error","message":"..."}}\n\n"
      const sseError = JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: stallMsg,
        },
      });
      const ssePayload = `event: error\ndata: ${sseError}\n\n`;

      // Mark upstream as intentionally closed to prevent undici from
      // propagating "socket closed unexpectedly" during stall abort
      if (upstreamBody && !upstreamBody.destroyed) {
        (upstreamBody as any)._intentionalClose = true;
      }

      // Unpipe upstream body FIRST so it can't inject data after SSE error write.
      try { undiciResponse.body.unpipe(passThrough!); } catch { /* not piped */ }
      // Mark passThrough as intentional close so safeError delegates to safeClose
      // instead of propagating the destroy error to the ReadableStream.
      (passThrough! as any)._intentionalClose = true;
      // Write SSE error payload, then destroy (not .end()) — destroy() always
      // fires "close" event even when piped source is still active (Node 20/22).
      passThrough!.write(ssePayload);
      passThrough!.destroy();

      // Destroy upstream — after passThrough has flushed the SSE error.
      try { (upstreamBody?.destroy(new Error(stallMsg)) as any).catch?.(() => {}); } catch { /* already consumed */ }

      // Now update stream state — after SSE payload has been written to passThrough.
      ctx._streamState = transitionStreamState(ctx, "error", ctx.requestId);
      broadcastStreamEvent({
        requestId: ctx.requestId,
        model: String(ctx.actualModel ?? entry.model ?? ""),
        tier: "",
        state: ctx._streamState!,
        message: stallMsg,
        timestamp: Date.now(),
      });
    };

    // One-shot stall timer: fires once after stallTimeout ms of no data.
    // Re-schedules itself on each data event (see passThrough "data" handler below).
    const scheduleStallTimer = () => {
      if (stallTimerRef) clearTimeout(stallTimerRef);
      stallTimerRef = setTimeout(() => {
        stallTimerRef = undefined;
        if (Date.now() - lastDataTime >= stallTimeout) {
          handleStall();
        }
      }, stallTimeout);
    };
    scheduleStallTimer();

    // Monitor PassThrough for data events — update timestamp and reschedule one-shot stall timer
    passThrough!.on("data", () => {
      lastDataTime = Date.now();
      scheduleStallTimer();
    });

    passThrough.on("end", () => {
      if (stallTimerRef) { clearTimeout(stallTimerRef); stallTimerRef = undefined; }
    });

    passThrough.on("error", () => {
      if (stallTimerRef) { clearTimeout(stallTimerRef); stallTimerRef = undefined; }
      try { passThrough!.destroy(); } catch { /* already destroyed */ }
    });

    // Pipe undici body → PassThrough. Data flows through without mode conflicts.
    undiciResponse.body.pipe(passThrough);

    // Wrap in a ReadableStream to catch undici's internal double-close bug.
    // When handleStall() destroys passThrough, undici's async GC can fire a
    // second close on the underlying controller, throwing ERR_INVALID_STATE.
    // The guarded controller.* calls below absorb that safely.
    const wrappedStream = new ReadableStream({
      start(controller) {
        if (!passThrough) { controller.close(); return; }
        // Guard against double controller.close() race between 'end' event
        // and cancel handler (undici ERR_INVALID_STATE).
        let controllerClosed = false;
        const safeClose = () => {
          if (controllerClosed) return;
          controllerClosed = true;
          try { controller.close(); } catch { /* already closed — undici bug */ }
        };
        const safeError = (err: Error) => {
          if (controllerClosed) return;
          // When handleStall() intentionally destroys passThrough, don't propagate
          // the error — the SSE payload was already written and "close" will
          // safely complete the ReadableStream via safeClose.
          if ((passThrough as any)._intentionalClose) return;
          controllerClosed = true;
          try { controller.error(err); } catch { /* already closed */ }
        };
        passThrough.on("data", (chunk: Buffer) => {
          // Guard: don't enqueue data if stream is already in a terminal state
          // (this is a pure read guard, no transition — safe as-is)
          if (ctx._streamState === "error" || ctx._streamState === "complete") return;
          try { controller.enqueue(new Uint8Array(chunk)); } catch { /* already closed */ }
        });
        passThrough.on("end", safeClose);
        passThrough.on("error", safeError);
        // Listen for "close" which fires on both end() and destroy(), ensuring
        // the ReadableStream completes even if "end" doesn't fire (e.g. after
        // unpipe + end on Node.js 20/22 where the pipe state prevents end event).
        passThrough.on("close", safeClose);
      },
      cancel() {
        if (passThrough) { try { passThrough.destroy(); } catch { /* already done */ } }
      },
    });

    const response = new Response(wrappedStream, {
      status: undiciResponse.statusCode,
      headers: undiciResponse.headers as unknown as HeadersInit,
    });

    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (ttfbTimer) clearTimeout(ttfbTimer);
    if (stallTimerRef) clearTimeout(stallTimerRef);

    // Network errors / timeouts — return a synthetic 502
    // If TTFB timer was still pending when we hit an AbortError, it means the
    // total timeout fired first but the TTFB timeout hadn't elapsed yet — this
    // is a genuine total timeout, not a TTFB failure.  If the TTFB timer was
    // already cleared (fired), treat it as a TTFB timeout regardless of which
    // rejection won Promise.race.
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    const isTTFB = ttfbTimedOut || (isAbort && ttfbTimer === null);
    const message = isTTFB
      ? `Provider "${provider.name}" timed out waiting for first byte after ${ttfbTimeout}ms`
      : isAbort
        ? `Provider "${provider.name}" timed out after ${provider.timeout}ms`
        : `Provider "${provider.name}" connection failed: ${(error as Error).message}`;

    // Broadcast error so the GUI progress bar doesn't stall on TTFB/total timeout
    setImmediate(() => {
      ctx._streamState = transitionStreamState(ctx, "error", ctx.requestId);
      broadcastStreamEvent({
        requestId: ctx.requestId,
        model: String(ctx.actualModel ?? entry.model ?? ctx.providerChain[0]?.model ?? ""),
        tier: ctx.tier,
        state: ctx._streamState!,
        status: 502,
        message,
        timestamp: Date.now(),
      });
    });

    return makeErrorResponse(502, "overloaded_error", message);
  } finally {
    removeAbortListener?.();
  }
}

/**
 * Forward a request with optional adaptive hedging.
 * When latency variance is high, sends multiple copies and returns the fastest.
 */
async function hedgedForwardRequest(
  provider: ProviderConfig,
  entry: RoutingEntry,
  ctx: RequestContext,
  incomingRequest: Request,
  chainSignal: AbortSignal | undefined,
  index: number,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
  hedging?: HedgingConfig,
): Promise<Response> {
  const count = ctx.hasDistribution ? 1 : computeHedgingCount(provider, hedging);

  if (count <= 1) {
    // No hedging — single request
    inFlightCounter.increment(provider.name);
    const start = Date.now();
    try {
      const r = await forwardRequest(provider, entry, ctx, incomingRequest, chainSignal, index);
      latencyTracker.record(provider.name, Date.now() - start);
      return r;
    } finally {
      inFlightCounter.decrement(provider.name);
    }
  }

  // Hedged path: send multiple copies, race for first success
  logger?.warn("Hedging request", {
    requestId: ctx.requestId,
    provider: provider.name,
    count,
    cv: Math.round(latencyTracker.getCV(provider.name) * 100) / 100,
    inFlight: inFlightCounter.get(provider.name),
    maxConcurrent: provider.concurrentLimit,
  });

  const start = Date.now();
  const launched: Promise<Response>[] = [];
  const hedgeController = new AbortController();

  for (let h = 0; h < count; h++) {
    inFlightCounter.increment(provider.name);
    const hedgeSignal = chainSignal
      ? AbortSignal.any([chainSignal, hedgeController.signal])
      : hedgeController.signal;
    // Reset stream state per hedge copy — each copy races independently
    // and may set _streamState/_stallFired via stall timers or error handlers.
    ctx._streamState = "start";
    (ctx as any)._stallFired = false;
    launched.push(
      forwardRequest(provider, entry, ctx, incomingRequest, hedgeSignal, index)
        .finally(() => inFlightCounter.decrement(provider.name))
    );
  }

  // Race: first successful response wins, cancel the rest
  // Wrap each promise so we can identify which one completed by index
  const wrapped = launched.map((p, i) =>
    p.then(response => ({ response, hedgeIndex: i }))
  );

  const completed = new Set<number>();
  const failures: Response[] = [];

  try {
    while (completed.size < wrapped.length) {
      const pending = wrapped.filter((_, i) => !completed.has(i));
      if (pending.length === 0) break;
      const winner = await Promise.race(pending);
      completed.add(winner.hedgeIndex);

      // Record each hedged copy's result for circuit breaker
      if (provider._circuitBreaker) {
        provider._circuitBreaker.recordResult(winner.response.status);
      }

      if (winner.response.status >= 200 && winner.response.status < 300) {
        latencyTracker.record(provider.name, Date.now() - start);
        recordHedgeWin(provider.name);
        // Record losses for copies that didn't win
        const loserCount = wrapped.length - 1;
        if (loserCount > 0) recordHedgeLosses(provider.name, loserCount);
        // Abort all in-flight hedge copies — triggers onExternalAbort in each
        // which properly destroys their PassThrough streams and clears stall timers
        hedgeController.abort();
        // Cancel remaining — record actual status for each cancelled copy.
        // Use void + .catch() to suppress unhandled rejections from late resolves.
        for (let i = 0; i < wrapped.length; i++) {
          if (!completed.has(i)) {
            void wrapped[i].then(r => {
              // Skip 499 — these are synthetic responses from hedge cancellation
              // (hedgeController.abort()), not real upstream failures. Recording
              // them would inflate circuit breaker failure counts.
              if (r.response.status === 499) return;
              if (provider._circuitBreaker) provider._circuitBreaker.recordResult(r.response.status);
              try { r.response.body?.cancel(); } catch {}
            }).catch(() => {});
          }
        }
        for (const f of failures) { try { f.body?.cancel(); } catch {} }
        return winner.response;
      }

      failures.push(winner.response);
    }

    // All hedged copies returned errors — cancel bodies, return first failure
    hedgeController.abort();
    for (const f of failures) { try { f.body?.cancel(); } catch {} }
    return failures[0] ?? makeErrorResponse(502, "api_error", `Provider "${provider.name}" all hedged requests failed`);
  } catch (err) {
    hedgeController.abort();
    for (const f of failures) { try { f.body?.cancel(); } catch {} }
    // If the error is an AbortError from hedge cancellation (winner found or chain cancelled),
    // return 499 instead of 502 to avoid false circuit breaker trips
    if (err instanceof Error && err.name === 'AbortError') {
      return makeErrorResponse(499, "api_error", `Provider "${provider.name}" hedging aborted`);
    }
    return failures[0] ?? makeErrorResponse(502, "api_error", `Provider "${provider.name}" hedging failed`);
  }
}

/** Result from forwardWithFallback including response and actual model used. */
export interface FallbackResult {
  response: Response;
  actualModel?: string;
  actualProvider?: string;
}

/**
 * Try forwarding through a chain of providers.
 * Returns the first successful response, or 502 if all fail.
 * Also returns the actualModel from the winning entry for accurate metrics.
 */
export async function forwardWithFallback(
  providers: Map<string, ProviderConfig>,
  chain: RoutingEntry[],
  ctx: RequestContext,
  incomingRequest: Request,
  onAttempt?: (provider: string, index: number) => void,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
  hedging?: HedgingConfig,
): Promise<FallbackResult> {
  // Guard: empty chain
  if (chain.length === 0) {
    return {
      response: makeErrorResponse(502, "api_error", "Empty provider chain"),
      actualModel: undefined,
      actualProvider: undefined,
    };
  }

  // Single provider — no racing needed
  if (chain.length <= 1) {
    const entry = chain[0];
    const provider = providers.get(entry.provider);

    if (!provider) {
      return { response: unknownProviderErr(entry.provider), actualModel: entry.model, actualProvider: entry.provider };
    }

    if (provider._circuitBreaker) {
      const cb = provider._circuitBreaker.canProceed();
      if (!cb.allowed) {
        logger?.warn("Provider skipped by circuit breaker", { requestId: ctx.requestId, provider: entry.provider });
        return { response: circuitBreakerErr(entry.provider), actualModel: entry.model, actualProvider: entry.provider };
      }
    }

    onAttempt?.(entry.provider, 0);

    const response = await hedgedForwardRequest(provider, entry, ctx, incomingRequest, undefined, 0, logger, hedging);

    return { response, actualModel: entry.model, actualProvider: entry.provider };
  }

  // Multiple providers
  if (ctx.hasDistribution) {
    // Distribution mode: sequential fallback only (no racing).
    // The selected provider (chain[0]) should handle the request;
    // only fall back to chain[1+] on retriable errors.
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];
      const provider = providers.get(entry.provider);

      if (!provider) {
        const err = unknownProviderErr(entry.provider);
        if (i === chain.length - 1) return { response: err, actualModel: entry.model, actualProvider: entry.provider };
        continue;
      }

      let cbProbeId: number | undefined;
      if (provider._circuitBreaker) {
        const cb = provider._circuitBreaker.canProceed();
        if (!cb.allowed) {
          logger?.warn("Provider skipped by circuit breaker", {
            requestId: ctx.requestId,
            provider: entry.provider,
          });
          if (i === chain.length - 1) return { response: circuitBreakerErr(entry.provider), actualModel: entry.model, actualProvider: entry.provider };
          continue;
        }
        cbProbeId = cb.probeId;
      }

      onAttempt?.(entry.provider, i);

      // Reset stream state for fallback — previous provider may have set
      // _streamState to "error" and _stallFired to true, causing the next
      // provider's TTFB/streaming/stall callbacks to hit invalid transitions.
      ctx._streamState = "start";
      (ctx as any)._stallFired = false;

      try {
        const response = await hedgedForwardRequest(
          provider, entry, ctx, incomingRequest, undefined, i, logger, hedging,
        );

        if (provider._circuitBreaker) provider._circuitBreaker.recordResult(response.status, cbProbeId);

        if (response.status >= 200 && response.status < 300) {
          return { response, actualModel: entry.model, actualProvider: entry.provider };
        }

        if (!isRetriable(response.status)) {
          // Non-retriable error — return immediately
          if ((response.status === 400 || response.status === 413) && response.body) {
            try {
              const errBody = await response.text();
              const handled = handleContextWindowError(response.status, errBody);
              if (handled) return { response: handled, actualModel: entry.model, actualProvider: entry.provider };
              return {
                response: new Response(errBody, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                }),
                actualModel: entry.model,
                actualProvider: entry.provider,
              };
            } catch {
              return { response, actualModel: entry.model, actualProvider: entry.provider };
            }
          }
          return { response, actualModel: entry.model, actualProvider: entry.provider };
        }

        // Retriable error — continue to next provider
        logger?.warn("Provider failed with retriable status, falling back", {
          requestId: ctx.requestId,
          provider: entry.provider,
          status: response.status,
          index: i,
        });
        // continue loop
      } catch {
        if (provider._circuitBreaker) provider._circuitBreaker.recordResult(502, cbProbeId);
        logger?.warn("Provider failed with exception, falling back", {
          requestId: ctx.requestId,
          provider: entry.provider,
          index: i,
        });
        // continue loop
      }
    }

    // All providers failed
    return {
      response: makeErrorResponse(502, "api_error", "All providers failed"),
      actualModel: chain[chain.length - 1]?.model,
      actualProvider: chain[chain.length - 1]?.provider,
    };
  }

  // Non-distribution: staggered race
  const sharedController = new AbortController();
  const completed = new Set<number>();
  const failures: { response: Response; index: number }[] = [];

  async function attemptProvider(
    index: number,
  ): Promise<{ response: Response; index: number }> {
    const entry = chain[index];
    const provider = providers.get(entry.provider);

    if (!provider) {
      return { response: unknownProviderErr(entry.provider), index };
    }

    let cbProbeId: number | undefined;
    if (provider._circuitBreaker) {
      const cb = provider._circuitBreaker.canProceed();
      if (!cb.allowed) {
        logger?.warn("Provider skipped by circuit breaker", {
          requestId: ctx.requestId,
          provider: entry.provider,
        });
        return { response: circuitBreakerErr(entry.provider), index };
      }
      cbProbeId = cb.probeId;
    }

    onAttempt?.(entry.provider, index);

    // Reset stream state for each racing provider — previous attempt may have
    // set _streamState to "error" and _stallFired to true.
    ctx._streamState = "start";
    (ctx as any)._stallFired = false;

    try {
      const response = await hedgedForwardRequest(
        provider,
        entry,
        ctx,
        incomingRequest,
        sharedController.signal,
        index,
        logger,
        hedging,
      );
      return { response, index };
    } catch {
      if (provider._circuitBreaker) provider._circuitBreaker.recordResult(502, cbProbeId);
      return {
        response: makeErrorResponse(502, "api_error", `Provider "${entry.provider}" failed`),
        index,
      };
    }
  }

  // Build staggered race promises:
  //   Provider 0 starts immediately
  //   Provider 1+ start after SPECULATIVE_DELAY (if race not already won)
  const races: Promise<{ response: Response; index: number }>[] = [];

  for (let i = 0; i < chain.length; i++) {
    if (i === 0) {
      races.push(attemptProvider(0));
    } else {
      races.push(
        new Promise<{ response: Response; index: number }>((resolve) => {
          setTimeout(() => {
            if (sharedController.signal.aborted) {
              // Race already won — resolve with a cancelled placeholder
              resolve({
                response: makeErrorResponse(502, "api_error", "Cancelled by race winner"),
                index: i,
              });
              return;
            }
            attemptProvider(i).then(resolve);
          }, hedging?.speculativeDelay ?? DEFAULT_SPECULATIVE_DELAY);
        }),
      );
    }
  }

  // Pick winner — same logic as raceProviders
  try {
    while (completed.size < races.length) {
      const pending = races.filter((_, idx) => !completed.has(idx));
      if (pending.length === 0) break;
      const winner = await Promise.race(pending);
      completed.add(winner.index);

      if (winner.response.status >= 200 && winner.response.status < 300) {
        sharedController.abort();
        // Record winner's result for circuit breaker (mirrors distribution path pattern)
        const winningEntry = chain[winner.index];
        const winningProvider = winningEntry ? providers.get(winningEntry.provider) : undefined;
        if (winningProvider?._circuitBreaker) {
          winningProvider._circuitBreaker.recordResult(winner.response.status);
        }
        for (const f of failures) {
          void f.response.body?.cancel?.().catch(() => {});
        }
        return { response: winner.response, actualModel: winningEntry?.model, actualProvider: winningEntry?.provider };
      }

      if (!isRetriable(winner.response.status)) {
        sharedController.abort();
        const winnerEntry = chain[winner.index];
        if ((winner.response.status === 400 || winner.response.status === 413) && winner.response.body) {
          try {
            const errBody = await winner.response.text();
            const handled = handleContextWindowError(winner.response.status, errBody);
            if (handled) return { response: handled, actualModel: winnerEntry?.model, actualProvider: winnerEntry?.provider };
            return {
              response: new Response(errBody, {
                status: winner.response.status,
                statusText: winner.response.statusText,
                headers: winner.response.headers,
              }),
              actualModel: winnerEntry?.model,
              actualProvider: winnerEntry?.provider,
            };
          } catch {
            return { response: winner.response, actualModel: winnerEntry?.model, actualProvider: winnerEntry?.provider };
          }
        }
        return { response: winner.response, actualModel: winnerEntry?.model, actualProvider: winnerEntry?.provider };
      }

      failures.push(winner);
    }

    sharedController.abort();
    if (failures.length > 0) {
      const failedEntry = chain[failures[0].index];
      return { response: failures[0].response, actualModel: failedEntry?.model, actualProvider: failedEntry?.provider };
    }

    return {
      response: makeErrorResponse(502, "overloaded_error", "All providers failed"),
      actualModel: undefined,
    };
  } catch {
    sharedController.abort();
    return {
      response: makeErrorResponse(502, "overloaded_error", "All providers failed"),
      actualModel: undefined,
    };
  }
}
