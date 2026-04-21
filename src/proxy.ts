// src/proxy.ts
import type { HedgingConfig, ProviderConfig, RequestContext, RoutingEntry } from "./types.js";
import { transitionStreamState } from "./types.js";
import { request as undiciRequest } from "undici";
import { PassThrough } from "node:stream";
import { TextEncoder } from "node:util";
import { getOrCreateAgent } from "./pool.js";
import { boostManager } from "./adaptive-timeout.js";
import { getAdapter } from "./adapters/registry.js";

/**
 * Generate Anthropic-compatible SSE closing events as Uint8Array[].
 * Inspects the SSE state to emit only the missing events, avoiding duplicates.
 *
 * @param sawMessageStart     Whether message_start was forwarded to the client.
 * @param sawContentBlockStart Whether any content_block_start was forwarded.
 */
const _textEncoder = new TextEncoder();
function buildMissingSSEEvents(sawMessageStart: boolean, sawContentBlockStart: boolean, sawContentBlockStop: boolean): Uint8Array[] {
  const events: string[] = ["\n"];

  if (!sawMessageStart) {
    // No upstream SSE data reached the client. Emit a complete synthetic message.
    const msgId = `msg_proxy_${Date.now()}`;
    events.push(
      `event: message_start\ndata: {"type":"message_start","message":{"id":"${msgId}","type":"message","role":"assistant","model":"proxy","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}\n\n`,
    );
  } else if (!sawContentBlockStart) {
    // message_start was sent but no content block was opened — open one now
    // so content_block_stop references a valid index.
    events.push(
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}\n\n`,
    );
  }

  // Only emit content_block_stop if upstream didn't already send one.
  if (!sawContentBlockStop) {
    events.push(
      "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    );
  }

  // Always close with message_delta + message_stop.
  events.push(
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":0}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
  );
  return events.map(evt => _textEncoder.encode(evt));
}

/** Write SSE closing events into a PassThrough stream (used by stall/error handlers). */
function writeSSEGracefulTermination(passThrough: PassThrough, sawMessageStart: boolean, sawContentBlockStart: boolean, sawContentBlockStop: boolean): void {
  for (const evt of buildMissingSSEEvents(sawMessageStart, sawContentBlockStart, sawContentBlockStop)) {
    passThrough.write(evt);
  }
}
import type { SessionAgentPool } from "./session-pool.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { latencyTracker, inFlightCounter, computeHedgingCount, recordHedgeWin, recordHedgeLosses } from './hedging.js';
import { warmupProvider } from './pool.js';
import { resolveAdaptiveTTFB } from './adaptive-timeout.js';
import { recordHealthEvent } from './health-score.js';
import { broadcastStreamEvent } from './ws.js';
import { SSEBuffer } from "./stream-buffer.js";
import type { MetricsStore } from "./metrics.js";

// --- Module-level MetricsStore reference for connection error tracking ---
let _metricsStore: MetricsStore | null = null;

/** Set the MetricsStore instance. Called by server.ts at startup. */
export function setMetricsStore(store: MetricsStore): void {
  _metricsStore = store;
}

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
  "user-agent",  // GLM-5.1 validates this for coding plan auth
]);

/** Pre-built regex combinations for targeted body replacements */
const REPLACEMENT_REGEX_MODEL = new RegExp(MODEL_KEY_REGEX.source, "g");
const REPLACEMENT_REGEX_MAX_TOKENS = new RegExp(MAX_TOKENS_REGEX.source, "g");
const REPLACEMENT_REGEX_BOTH = new RegExp(MODEL_KEY_REGEX.source + "|" + MAX_TOKENS_REGEX.source, "g");

// --- Pre-built error response helpers ---

const ERR_HEADERS = Object.freeze({ "content-type": "application/json" });

/** Keywords that indicate a synthetic 502 from a local failure (not an upstream 502). */
const CONNECTION_ERROR_KEYWORDS = ["timed out", "connection failed", "stalled", "ReadableStream is locked"];

/**
 * Check if a 502 response is a connection-level error (stale pool, timeout, stall)
 * vs an actual upstream 502. Connection errors should NOT tank the provider's
 * health score because they're local artifacts, not provider failures.
 */

/** Check if a 502 response body indicates a connection-level error. */
function isConnectionError502FromBody(body: string): boolean {
  return CONNECTION_ERROR_KEYWORDS.some(kw => body.includes(kw));
}

/** Async: clone a response and check if its body indicates a connection-level error. */
async function isConnectionErrorBody(response: Response): Promise<boolean> {
  if (response.status !== 502) return false;
  try {
    // If the stream is already locked (e.g., from a prior tee/clone), treat as connection
    // error so we retry with a fresh pool rather than failing with "ReadableStream locked".
    if (response.body?.locked) return true;
    const body = await response.clone().text();
    return isConnectionError502FromBody(body);
  } catch {
    return false;
  }
}

function makeErrorResponse(status: number, type: string, message: string, tagConnError: boolean = false): Response {
  const body = JSON.stringify({ type: "error", error: { type, message } });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": textEncoder.encode(body).byteLength.toString(),
  };
  if (tagConnError) headers[CONN_ERROR_HEADER] = CONN_ERROR_VALUE;
  return new Response(body, { status, headers });
}

/** Strip transfer-encoding from a Headers object (used when converting streaming body to static). */
function stripTransferEncoding(headers: Headers): Headers {
  const h = new Headers(headers);
  h.delete("transfer-encoding");
  return h;
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

/** Header added to synthetic circuit-breaker-skip responses so recordResult() knows not to count them. */
const CB_SKIP_HEADER = "x-cb-skipped";
const CB_SKIP_VALUE = "1";
/** Header added to synthetic 502 responses from connection errors (TTFB timeout,
 * stall, ECONNRESET). These are local artifacts, not upstream failures, and
 * should NOT count toward the circuit breaker failure threshold. */
const CONN_ERROR_HEADER = "x-conn-error";
const CONN_ERROR_VALUE = "1";

function circuitBreakerErr(providerName: string): Response {
  const body = JSON.stringify({
    type: "error",
    error: { type: "api_error", message: `Provider "${providerName}" skipped by circuit breaker` },
  });
  return new Response(body, {
    status: 502,
    headers: { ...ERR_HEADERS, "content-length": String(textEncoder.encode(body).byteLength), [CB_SKIP_HEADER]: CB_SKIP_VALUE },
  });
}

/** Returns true if this response was generated by circuitBreakerErr() — a synthetic 502
 * from a locally-applied circuit breaker skip, NOT an upstream failure. */
function isCircuitBreakerSkipResponse(response: Response): boolean {
  return response.headers.get(CB_SKIP_HEADER) === CB_SKIP_VALUE;
}

/** Returns true if this response is a synthetic 502 from a local connection error
 * (TTFB timeout, stall, ECONNRESET). These are local artifacts, not upstream
 * failures, and should NOT count toward the circuit breaker failure threshold.
 * They are distinguished from real upstream 502s by the CONN_ERROR_HEADER. */
function isConnectionErrorResponse(response: Response): boolean {
  return response.headers.get(CONN_ERROR_HEADER) === CONN_ERROR_VALUE;
}

/** Default delay (ms) before starting backup providers in staggered race */
const DEFAULT_SPECULATIVE_DELAY = 1000;

export function isRetriable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Default patterns that indicate a transient/server-side error, even when
 * the HTTP status is 400 or 413 (non-standard but common among some providers).
 * These trigger fallback to the next provider in the chain.
 */
const TRANSIENT_BODY_PATTERNS = [
  'network error',
  'internal error',
  'server error',
  'overloaded',
  'service unavailable',
  'temporarily unavailable',
  'upstream error',
  'downstream error',
  'gateway error',
  'connect error',
  'connection error',
  'connection refused',
  'timeout',
  'rate limit',
  'too many requests',
  'system error',
];

/**
 * Checks if a 4xx response body indicates a transient error that should
 * trigger fallback to the next provider. Used for providers that return
 * 400 with non-standard error messages for what are actually server-side
 * or network issues (e.g. "Network error, error id: xxx").
 */
export function isTransientBodyError(_status: number, body: string, customPatterns?: string[]): boolean {
  // No status gate — check patterns for any error code
  const lower = body.toLowerCase();
  const patterns = customPatterns && customPatterns.length > 0
    ? [...TRANSIENT_BODY_PATTERNS, ...customPatterns.map(p => p.toLowerCase())]
    : TRANSIENT_BODY_PATTERNS;
  return patterns.some(p => lower.includes(p));
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
    headers.delete("x-api-key"); // Prevent adapter from converting stale x-api-key to auth
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
  needsThinkingStrip = false,
): string {
  // If orphan cleaning or thinking stripping is needed, fall back to full JSON
  // (orphan clean requires structural changes; thinking requires nested-brace handling)
  if (needsOrphanClean || needsThinkingStrip) {
    // shallow clone: cleanOrphanedToolMessages reassigns body.messages
    const mutable = shallowCloneForMutation(parsed);
    if (entry.model) mutable.model = entry.model;
    if (needsOrphanClean) cleanOrphanedToolMessages(mutable);
    if (provider.modelLimits) {
      const { maxOutputTokens } = provider.modelLimits;
      const requested = typeof mutable.max_tokens === "number" ? mutable.max_tokens : maxOutputTokens;
      if (mutable.max_tokens === undefined || requested > maxOutputTokens) {
        mutable.max_tokens = Math.min(requested, maxOutputTokens);
      }
    }
    if (needsThinkingStrip) delete mutable.thinking;
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
  probeId?: number,
  sessionPool?: SessionAgentPool,
): Promise<Response> {
  const outgoingPath = incomingRequest.url.replace(STRIP_ORIGIN, "");

  // Set actualModel early so metrics always record the routed model,
  // even if body parsing or the fetch itself fails
  if (entry.model) {
    ctx.actualModel = entry.model;
  }

  // Build outbound URL from provider base URL and request path
  const adapter = getAdapter(provider.apiFormat);
  const url = adapter.format === "anthropic"
    ? buildOutboundUrl(provider, outgoingPath)
    : adapter.buildUpstreamUrl(provider.baseUrl, outgoingPath, ctx.actualModel ?? ctx.model);

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

      // Check 4: Thinking block stripping?
      // Strips the `thinking` field from the request so upstream never generates
      // thinking blocks in the SSE response. This reduces response size by 10-50KB+
      // per request and speeds up Claude Code rendering.
      const needsThinkingStrip = !!(provider._serverConfig?.disableThinking && parsed.thinking !== undefined);
      if (needsThinkingStrip) needsModification = true;

      if (needsModification) {
        // On primary attempt (chainIndex === 0) without orphan cleaning, use targeted
        // string replacements to preserve prompt caching. Anthropic's cache breakpoints
        // are position-sensitive -- JSON.stringify changes whitespace/order, breaking hits.
        if (chainIndex === 0 && !needsOrphanClean) {
          body = applyTargetedReplacements(ctx.rawBody, entry, provider, parsed, false, needsThinkingStrip);
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

          if (needsThinkingStrip) {
            delete mutable.thinking;
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

  // Apply adapter transformation for non-Anthropic formats
  let requestHeaders: Headers;
  let requestBody = body;
  if (adapter.format !== "anthropic") {
    const headersObj: Record<string, string> = {};
    headers.forEach((v, k) => { headersObj[k] = v; });
    const transformed = adapter.transformRequest(body, headersObj);
    requestBody = transformed.body;
    requestHeaders = new Headers(Object.entries(transformed.headers));
    // DEBUG: log outbound auth and URL
    console.warn(`[adapter-debug] auth=${requestHeaders.get("authorization")?.slice(0, 20)}... model=${JSON.parse(requestBody).model} url=${adapter.buildUpstreamUrl(provider.baseUrl, incomingRequest.url, ctx.actualModel ?? ctx.model)}`);

    // Apply model override to the request body (routing may map e.g. glm-5-turbo → glm-5)
    if (ctx.actualModel) {
      try {
        const parsed = JSON.parse(requestBody);
        if (parsed.model !== ctx.actualModel) {
          parsed.model = ctx.actualModel;
          requestBody = JSON.stringify(parsed);
        }
      } catch { /* keep as-is */ }
    }
  } else {
    requestHeaders = headers;
  }
  requestHeaders.set("content-length", Buffer.byteLength(requestBody, 'utf-8').toString());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeout);

  // TTFB timeout: fail if no response headers received within ttfbTimeout ms
  const ttfbTimeout = resolveAdaptiveTTFB(provider, latencyTracker);
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
  // Suppress unhandled rejection if undiciRequest wins the race before the TTFB timer fires.
  // When undiciRequest resolves first, Promise.race discards ttfbPromise — but if the
  // timer fires in the tiny window between race resolution and clearTimeout, the reject()
  // would create an unhandled promise rejection. This .catch() absorbs it.
  ttfbPromise.catch(() => {});

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
          // Mark as intentional close so safeError() in the ReadableStream wrapper
          // suppresses the error instead of propagating "socket closed unexpectedly"
          // to the client. Matches the stall handler's pattern (see handleStall).
          (passThrough as any)._intentionalClose = true;
          passThrough.destroy(new Error("Cancelled"));
        }
      });
    };
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    removeAbortListener = () => {
      externalSignal.removeEventListener("abort", onExternalAbort);
      const current = (externalSignal as any).getMaxListeners?.() ?? 10;
      (externalSignal as any).setMaxListeners?.(Math.max(0, current - 1));
    };
  }

  // Key by actualModel (the model the upstream provider uses) for true per-model isolation.
  // Hoisted from try block so the finally clause can access it for sessionPool.release().
  const poolModel = ctx.actualModel ?? ctx.model;
  // Hoisted so both start()/cancel() AND the finally clause can access it.
  // start() and cancel() are sibling functions in the ReadableStream object literal
  // and don't share inner scope. finally needs it to guard against double-release.
  let controllerClosed = false;
  // Track whether the ReadableStream wrapper was created. If yes, safeClose/cancel()
  // owns the release. If no (4xx/5xx, non-standard body, catch), finally owns it.
  // Without this, finally releases on the normal streaming path → count drops to 0
  // while the stream is still being consumed → sweep() could close the agent mid-stream.
  let streamCreated = false;

  try {
    // Use session-scoped agent when available (per-session, per-model connection isolation),
    const dispatcher = sessionPool?.get(ctx.sessionId, poolModel) ?? getOrCreateAgent(provider, poolModel);
    const undiciResponse = await Promise.race([
      undiciRequest(url, {
        method: "POST",
        headers: requestHeaders,
        body: requestBody,
        signal: controller.signal,
        dispatcher,
      }),
      ttfbPromise,
    ]);

    // TTFB succeeded — cancel TTFB timer
    if (ttfbTimer) clearTimeout(ttfbTimer);

    // Track upstream body for cleanup on error paths
    upstreamBody = undiciResponse.body;

    // Flag: if upstream errors before passThrough is created (lines 788+),
    // we need to inject the SSE error payload after passThrough exists.
    let earlyUpstreamError: Error | undefined;

    // Guard against uncaught error events when the pipe is torn down
    // after passThrough.destroy() fires before upstreamBody.destroy().
    // When _intentionalClose is set (hedge cancel or stall abort), swallow
    // undici's "socket closed unexpectedly" warning — the close is expected.
    upstreamBody.on("error", (err: Error) => {
      if (stallTimerRef) clearTimeout(stallTimerRef);
      if ((upstreamBody as any)._intentionalClose) return; // expected — suppress
      console.warn(`[proxy] Upstream body error on "${provider.name}": ${err.message}`);

      // When the upstream provider closes the socket mid-stream (e.g. GLM dropping
      // connection), Node.js pipe does NOT forward the error to passThrough — it
      // just breaks the pipe silently.  The passThrough stream hangs with no events.
      // ALL upstream body errors (socket, HTTP parse, timeout, etc.) leave passThrough
      // hanging. Always write an SSE error payload so the client receives a proper
      // retriable error instead of a raw socket failure.
      const code = (err as any).code;
      const isSocketError = code === 'ECONNRESET' || code === 'ECONNREFUSED' ||
          code === 'EPIPE' || code === 'ETIMEDOUT' || code === 'ECONNABORTED' ||
          code === 'UND_ERR_SOCKET' || code === 'UND_ERR_SOCKET_CLOSED' ||
          code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' ||
          code === 'UND_ERR_HEADERS_TIMEOUT' ||
          code?.startsWith('HPE_') ||
          (err.message && /socket closed unexpectedly/i.test(err.message));
      const errMsg = isSocketError
        ? `Provider connection lost: ${err.message}`
        : `Provider error: ${err.message}`;

      if (passThrough && !passThrough.destroyed) {
        // Mark upstream as intentionally closed to suppress undici warnings
        (upstreamBody as any)._intentionalClose = true;
        // Unpipe upstream body FIRST so it can't inject data after error
        try { undiciResponse.body.unpipe(passThrough) } catch { /* not piped */ }
        // Mark passThrough as intentional close so safeError delegates to safeClose
        (passThrough as any)._intentionalClose = true;
        // Write Anthropic-compatible SSE closing events before ending the stream.
        // Without this, the stream is truncated mid-event and the SDK crashes with
        // "null is not an object (evaluating Y8.content)".
        try { writeSSEGracefulTermination(passThrough, sawMessageStart, sawContentBlockStart, sawContentBlockStop); } catch { /* passThrough already closed */ }
        passThrough.end();

        // Wait for passThrough to finish before destroying upstream body.
        // Destroying immediately can close the HTTP/2 stream before the stream
        // closure propagates, causing "socket closed unexpectedly" on the client.
        passThrough.once("finish", () => {
          if (upstreamBody && !upstreamBody.destroyed) {
            try { (upstreamBody.destroy(err) as any).catch?.(() => {}); } catch { /* already done */ }
          }
        });

        // Update stream state
        ctx._streamState = transitionStreamState(ctx, "error", ctx.requestId);
        broadcastStreamEvent({
          requestId: ctx.requestId,
          model: String(ctx.actualModel ?? entry.model ?? ""),
          tier: "",
          state: ctx._streamState!,
          message: errMsg,
          timestamp: Date.now(),
        });
      } else if (!passThrough) {
        // Upstream errored before passThrough was created (between TTFB and
        // PassThrough instantiation). Stash the error so we can inject the
        // SSE payload after passThrough is created and piped.
        earlyUpstreamError = err;
        (upstreamBody as any)._intentionalClose = true;
        console.warn(`[proxy] Early upstream error on "${provider.name}" (before passThrough): ${err.message}`);
      }
    });

    // For error status codes (4xx/5xx), consume body immediately without stall detection.
    // Rate limits (429) and server errors (5xx) return small JSON bodies that arrive instantly.
    // Safety: race body read against a short timeout — if the body doesn't arrive within
    // ERROR_BODY_TIMEOUT_MS (e.g., due to a degraded HTTP/2 connection where headers arrive
    // but DATA frames are severely delayed), abort and throw so the caller falls back to
    // the next provider. Hanging for tens of seconds on a body we don't need is pointless
    // when the status line already tells us the request failed.
    if (undiciResponse.statusCode >= 400) {
      clearTimeout(timeout);
      const ERROR_BODY_TIMEOUT_MS = 3000;
      let errBody: string;
      try {
        errBody = await Promise.race([
          undiciResponse.body.text(),
          new Promise<never>((_, reject) =>
            setTimeout(() => {
              // Destroy the upstream body to free the HTTP/2 stream back to the pool
              try { (undiciResponse.body as any).destroy(); } catch { /* already done */ }
              reject(new Error(`error body read timed out after ${ERROR_BODY_TIMEOUT_MS}ms`));
            }, ERROR_BODY_TIMEOUT_MS)
          ),
        ]);
      } catch (err) {
        // Body read failed or timed out. The status line already told us this is an error —
        // no point waiting longer. Destroy and re-throw so the fallback loop tries the next provider.
        try { (undiciResponse.body as any).destroy(); } catch { /* already done */ }
        throw err;
      }
      // Explicitly destroy the upstream body — prevents undici from holding the
      // HTTP/2 connection open until GC collects the Readable.
      try { (undiciResponse.body as any).destroy(); } catch { /* already done */ }
      // Filter out transfer-encoding — we consumed the body to a static string,
      // so chunked encoding no longer applies. Forwarding it would violate
      // HTTP framing and cause "socket closed unexpectedly" on the client.
      const errHeaders = new Headers(undiciResponse.headers as unknown as HeadersInit);
      errHeaders.delete("transfer-encoding");

      // Propagate Retry-After from 429/503 responses so the fallback chain
      // can back off instead of hammering rate-limited providers.
      // Without this, a burst of 429s compounds into a 6+ minute stall
      // because the chain retries immediately on every attempt.
      if (undiciResponse.statusCode === 429 || undiciResponse.statusCode === 503) {
        const retryAfterRaw = undiciResponse.headers["retry-after"];
        if (retryAfterRaw) {
          const retryAfterSec = Number(retryAfterRaw);
          // Both seconds (numeric) and HTTP-date formats are valid;
          // numeric is the common case for API rate limits.
          if (!isNaN(retryAfterSec) && retryAfterSec > 0) {
            ctx._retryAfterMs = retryAfterSec * 1000;
          } else {
            // Default: use provider-level backoff when Retry-After is non-numeric
            const providerBackoff = provider._rateLimitBackoffMs ?? 1000;
            ctx._retryAfterMs ??= providerBackoff;
          }
          console.warn(`[proxy] Provider "${provider.name}" returned ${undiciResponse.statusCode}, Retry-After: ${retryAfterRaw}s`);
        } else {
          // No Retry-After header — use provider-level configured backoff
          const providerBackoff = provider._rateLimitBackoffMs ?? 1000;
          ctx._retryAfterMs ??= providerBackoff;
        }
      }

      // Normalize error body to Anthropic format for non-Anthropic adapters
      const normalizedErrBody = adapter.format !== "anthropic"
        ? (() => {
            try {
              const { type, message } = adapter.transformError(undiciResponse.statusCode, errBody);
              return JSON.stringify({ type: "error", error: { type, message } });
            } catch { return errBody; }
          })()
        : errBody;

      return new Response(normalizedErrBody, {
        status: undiciResponse.statusCode,
        statusText: undiciResponse.statusText,
        headers: errHeaders,
      });
    }

    // Non-standard upstream response (e.g., plain text/buffer) — send as-is without stall detection.
    // Check this BEFORE creating passThrough so we avoid the allocation when not needed.
    if (!undiciResponse.body || typeof undiciResponse.body.pipe !== 'function') {
      const fallback = undiciResponse.body
        ? new ReadableStream({ start(controller) { controller.enqueue(textEncoder.encode(String(undiciResponse.body))); controller.close(); } })
        : new ReadableStream({ start(controller) { controller.close(); } });
      // Explicitly destroy the upstream body to prevent HTTP/2 connection leaks.
      if (undiciResponse.body) {
        try { (undiciResponse.body as any).destroy(); } catch { /* already done */ }
      }
      // Strip transfer-encoding AND content-length — we've re-wrapped the body
      // in a new ReadableStream, so upstream framing no longer applies.
      // Keeping content-length could cause client-side framing errors if the
      // new body size differs from the original upstream content-length.
      const fallbackHeaders = new Headers(undiciResponse.headers as unknown as HeadersInit);
      fallbackHeaders.delete("transfer-encoding");
      fallbackHeaders.delete("content-length");
      return new Response(fallback, {
        status: undiciResponse.statusCode,
        headers: fallbackHeaders,
      });
    }

    // Upstream returned a non-streaming JSON response (e.g., MiniMax non-stream mode).
    // Consume the body and return it directly — do NOT wrap in a ReadableStream
    // or inject SSE events, which would cause "Failed to parse JSON" in the SDK.
    const upstreamContentType = undiciResponse.headers["content-type"] as string ?? "";
    if (upstreamContentType.includes("application/json") && !upstreamContentType.includes("text/event-stream")) {
      const jsonBody = await undiciResponse.body.text();
      try { (undiciResponse.body as any).destroy(); } catch { /* already done */ }
      clearTimeout(timeout);
      if (ttfbTimer) clearTimeout(ttfbTimer);

      // For non-anthropic adapters, transform the JSON response to Anthropic SSE format
      if (adapter.format !== "anthropic" && adapter.transformNonStreamingResponse) {
        const sseBody = adapter.transformNonStreamingResponse(jsonBody);
        return new Response(sseBody, {
          status: undiciResponse.statusCode,
          statusText: undiciResponse.statusText,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }

      const jsonHeaders = new Headers(undiciResponse.headers as unknown as HeadersInit);
      jsonHeaders.delete("transfer-encoding");
      return new Response(jsonBody, {
        status: undiciResponse.statusCode,
        statusText: undiciResponse.statusText,
        headers: jsonHeaders,
      });
    }

    // Body stall detection: pipe through PassThrough to monitor for data without
    // interfering with undici's internal stream state (no flowing mode conflict).
    // Uses a single interval that checks a timestamp instead of per-chunk setTimeout/clearTimeout,
    // reducing syscall-level overhead on every data event.
    const stallTimeout = provider.stallTimeout ?? 15000;
    passThrough = new PassThrough();
    // Track how many bytes were forwarded to the client — used by
    // writeSSEGracefulTermination to decide whether to emit a full
    // synthetic message (no data sent) or just closing events.
    (passThrough as any)._bytesForwarded = 0;

    // SSE state tracking — hoisted to outer scope so error handler (line ~837)
    // and stall handler (line ~983) can reference them when writing closing events.
    let sawMessageStart = false;
    let sawContentBlockStart = false;
    let sawContentBlockStop = false;
    let sawMessageStop = false;
    let _rollingTail = "";
    passThrough.on("data", (chunk: Buffer) => {
      // Lightweight SSE state tracking via rolling tail buffer.
      // Accumulate last ~500 bytes across chunks to detect event types
      // that may span chunk boundaries.
      (passThrough as any)._bytesForwarded = ((passThrough as any)._bytesForwarded || 0) + chunk.length;
      if (!sawMessageStop) {
        _rollingTail = (_rollingTail + chunk.toString("utf8")).slice(-500);
        if (!sawMessageStart && _rollingTail.includes('"message_start"')) sawMessageStart = true;
        if (!sawContentBlockStart && _rollingTail.includes('"content_block_start"')) sawContentBlockStart = true;
        if (!sawContentBlockStop && _rollingTail.includes('"content_block_stop"')) sawContentBlockStop = true;
        if (_rollingTail.includes('"message_stop"')) sawMessageStop = true;
      }
      // Debug: dump first chunk to see actual SSE content
      if (((passThrough as any)._bytesForwarded ?? 0) <= chunk.length) {
        console.warn(`[tracking] First chunk (${chunk.length}b): ${chunk.toString("utf8").slice(0, 400)}`);
      }
      // Debug: dump ALL chunks for non-anthropic adapters to compare format
      if (adapter.format !== "anthropic") {
        console.warn(`[openai-out] ${chunk.toString("utf8")}`);
      }
    });

    // If upstream errored before passThrough was created (earlyUpstreamError),
    // end the passThrough now and abort the pipe setup.
    // Do NOT write SSE "event: error" — the Anthropic SDK doesn't handle that
    // event type and crashes with "null is not an object (evaluating Y8.content)".
    if (earlyUpstreamError) {
      const errMsg = `Provider connection lost: ${earlyUpstreamError.message}`;
      (passThrough as any)._intentionalClose = true;
      (upstreamBody as any)._intentionalClose = true;
      passThrough.end();
      // Destroy upstream body after passThrough finishes — without this, the
      // undici response body leaks and could cause "socket closed unexpectedly"
      // when undici later tries to read from a half-closed HTTP/2 stream.
      passThrough.once("finish", () => {
        if (upstreamBody && !upstreamBody.destroyed) {
          try { (upstreamBody.destroy(earlyUpstreamError) as any).catch?.(() => {}); } catch { /* already done */ }
        }
      });
      ctx._streamState = transitionStreamState(ctx, "error", ctx.requestId);
      broadcastStreamEvent({
        requestId: ctx.requestId,
        model: String(ctx.actualModel ?? entry.model ?? ""),
        tier: "",
        state: ctx._streamState!,
        message: errMsg,
        timestamp: Date.now(),
      });
    }

    const stallMsg = `Body stalled: no data after ${stallTimeout}ms`;
    let lastDataTime = Date.now();

    const handleStall = () => {
      // Guard: bail if already fired, stream is in a terminal state, or
      // the upstream error handler already closed this stream.
      if ((ctx as any)._stallFired) return;
      if (ctx._streamState === "error" || ctx._streamState === "complete") return;
      if ((passThrough as any)?._intentionalClose) return;
      (ctx as any)._stallFired = true;
      if (probeId !== undefined) {
        provider._circuitBreaker?.recordProbeTimeout(probeId);
      } else {
        provider._circuitBreaker?.recordTimeout();
      }
      _metricsStore?.recordConnectionError(provider.name, "stalls");
      boostManager.recordTimeoutError(provider, "stall");
      console.warn(`[stall] Provider "${provider.name}" stalled: no data after ${stallTimeout}ms`);

      // Mark upstream as intentionally closed to prevent undici from
      // propagating "socket closed unexpectedly" during stall abort
      if (upstreamBody && !upstreamBody.destroyed) {
        (upstreamBody as any)._intentionalClose = true;
      }

      // Unpipe upstream body FIRST so it can't inject data.
      try { undiciResponse.body.unpipe(passThrough!); } catch { /* not piped */ }
      // Mark passThrough as intentional close so safeError delegates to safeClose
      // instead of propagating the destroy error to the ReadableStream.
      (passThrough! as any)._intentionalClose = true;
      // Write Anthropic-compatible SSE closing events before ending the stream.
      // Without this, the stream is truncated mid-event and the SDK crashes with
      // "null is not an object (evaluating Y8.content)".
      try { writeSSEGracefulTermination(passThrough!, sawMessageStart, sawContentBlockStart, sawContentBlockStop); } catch { /* passThrough already closed */ }
      passThrough!.end();

      // Wait for passThrough to finish before destroying upstream body.
      // Destroying immediately can close the HTTP/2 stream before the stream
      // closure propagates, causing "socket closed unexpectedly" on the client.
      passThrough!.once("finish", () => {
        if (upstreamBody && !upstreamBody.destroyed) {
          try { (upstreamBody.destroy(new Error(stallMsg)) as any).catch?.(() => {}); } catch { /* already consumed */ }
        }
      });

      // Now update stream state.
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
      // Mark intentional close BEFORE destroy so safeError() in the
      // ReadableStream wrapper suppresses the raw error instead of
      // propagating "socket closed unexpectedly" to the client.
      (passThrough as any)._intentionalClose = true;
      try { passThrough!.destroy(); } catch { /* already destroyed */ }
    });

    // If upstream errored before passThrough, the passThrough already has the SSE
    // error payload written — skip the pipe setup to avoid redundant data flow.
    // NOTE: Pipe setup is deferred to AFTER the ReadableStream's start() callback
    // registers its data handler, to prevent early chunks from being lost.

    // Wrap in a ReadableStream to catch undici's internal double-close bug.
    // When handleStall() destroys passThrough, undici's async GC can fire a
    // second close on the underlying controller, throwing ERR_INVALID_STATE.
    // The guarded controller.* calls below absorb that safely.
    // controllerClosed is declared in the outer forwardRequest scope so
    // start(), cancel(), AND the finally clause can all access it.
    streamCreated = true;
    const wrappedStream = new ReadableStream({
      start(controller) {
        if (!passThrough) { controller.close(); return; }
        // Guard against double controller.close() race between 'end' event
        // and cancel handler (undici ERR_INVALID_STATE).
        const safeClose = () => {
          if (controllerClosed) return;
          controllerClosed = true;
          // If the upstream ended without sending message_stop, the stream is incomplete.
          // Inject the missing Anthropic SSE events to prevent Y8.content crash.
          if (!sawMessageStop && ((passThrough as any)._bytesForwarded ?? 0) > 0) {
            console.warn(`[safeClose] Injecting closing events: bytes=${(passThrough as any)._bytesForwarded} start=${sawMessageStart} blockStart=${sawContentBlockStart} blockStop=${sawContentBlockStop} msgStop=${sawMessageStop}`);
            // Upstream ended without sending message_stop — stream is incomplete.
            // Inject only the missing events to prevent Y8.content crash.
            const missing = buildMissingSSEEvents(sawMessageStart, sawContentBlockStart, sawContentBlockStop);
            for (const evt of missing) {
              try { controller.enqueue(evt); } catch { /* already closed */ }
            }
          }
          // Decrement in-flight count so the stale refresh knows this stream is done.
          // This is safe to call multiple times since release() is idempotent.
          if (sessionPool && ctx.sessionId) {
            sessionPool.release(ctx.sessionId, ctx.actualModel ?? ctx.model);
          }
          // Transition stream state to "complete" and broadcast for GUI.
          // Only fire for normal stream completion (state was "streaming"),
          // NOT for error/stall cases (state already "error" or other).
          if (ctx._streamState === "streaming" || ctx._streamState === "ttfb") {
            const latencyMs = Date.now() - ctx.startTime;
            ctx._streamState = transitionStreamState(ctx, "complete", ctx.requestId);
            if (ctx._streamState === "complete") {
              broadcastStreamEvent({
                requestId: ctx.requestId,
                model: String(ctx.actualModel ?? entry.model ?? ""),
                tier: "",
                state: "complete",
                status: undiciResponse.statusCode,
                latencyMs,
                outputTokens: 0,
                timestamp: Date.now(),
              });
            }
          }
          try { controller.close(); } catch { /* already closed — undici bug */ }
        };
        const safeError = (_err: Error) => {
          if (controllerClosed) return;
          // When handleStall() intentionally destroys passThrough, don't propagate
          // the error — safeClose() will cleanly end the stream.
          if ((passThrough as any)._intentionalClose) return;
          controllerClosed = true;
          // Just close the ReadableStream cleanly. Do NOT write an SSE error event
          // ("event: error") — the Anthropic SDK doesn't handle that event type
          // and crashes with "null is not an object (evaluating Y8.content)".
          // Closing the stream without message_stop causes the SDK to detect an
          // incomplete stream and throw a retryable streaming error instead.
          try { controller.close(); } catch { /* already closed */ }
        };
        // Check if streaming buffer is enabled via server config
        const serverConfig = (provider as any)._serverConfig;
        const bufferMs = serverConfig?.streamBufferMs ?? 0;
        const bufferBytes = serverConfig?.streamBufferBytes ?? 0;
        const bufferingEnabled = bufferMs > 0 || bufferBytes > 0;

        let sseBuffer: SSEBuffer | undefined;
        if (bufferingEnabled) {
          sseBuffer = new SSEBuffer(
            (chunk: Uint8Array) => {
              if (ctx._streamState === "error" || ctx._streamState === "complete") return;
              try { controller.enqueue(chunk); } catch { /* already closed */ }
            },
            { bufferBytes, bufferMs },
          );
        }

        passThrough.on("data", (chunk: Buffer) => {
          // Guard: don't enqueue data if stream is already in a terminal state
          if (ctx._streamState === "error" || ctx._streamState === "complete") return;

          // Pure passthrough — forward bytes without modification.
          const outChunk = new Uint8Array(chunk);

          if (sseBuffer) {
            sseBuffer.write(outChunk);
          } else {
            try { controller.enqueue(outChunk); } catch { /* already closed */ }
          }
        });
        passThrough.on("end", () => {
          if (sseBuffer) sseBuffer.end();
          safeClose();
        });
        passThrough.on("error", (err: Error) => {
          if (sseBuffer) sseBuffer.end();
          safeError(err);
        });
        passThrough.on("close", safeClose);

        // Pipe upstream into passThrough AFTER all listeners are registered.
        // If we pipe before start() sets up the data handler, early chunks
        // from eager adapters (e.g. openai-chat) are lost before
        // controller.enqueue() can forward them to the HTTP client.
        if (!earlyUpstreamError) {
          if (adapter.format !== "anthropic") {
            adapter.transformResponse(undiciResponse.body).pipe(passThrough);
          } else {
            undiciResponse.body.pipe(passThrough);
          }
        }
      },
      cancel() {
        // Mark both streams as intentionally closed so upstream error handler
        // and safeError() suppress the raw error instead of propagating it.
        if (upstreamBody && !upstreamBody.destroyed) {
          (upstreamBody as any)._intentionalClose = true;
        }
        if (passThrough) {
          (passThrough as any)._intentionalClose = true;
          try { passThrough.destroy(); } catch { /* already done */ }
        }
        // Release the session agent so the stale refresh knows this stream is done.
        // Guard against double-release: safeClose() (from passThrough "close" event)
        // may have already released if cancel() fires after the stream ended.
        if (sessionPool && ctx.sessionId && !controllerClosed) {
          sessionPool.release(ctx.sessionId, ctx.actualModel ?? ctx.model);
        }
      },
    });

    const response = new Response(wrappedStream, {
      status: undiciResponse.statusCode,
      headers: undiciResponse.headers as unknown as HeadersInit,
    });

    clearTimeout(timeout);
    boostManager.checkReset(provider);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (ttfbTimer) clearTimeout(ttfbTimer);
    if (stallTimerRef) clearTimeout(stallTimerRef);

    // Clean up upstream body if it was assigned before the error.
    // If undiciRequest resolved (setting upstreamBody at line ~724) but the TTFB
    // promise rejection won Promise.race, the code enters catch with upstreamBody
    // set to the actual response body. Without explicit destroy, undici holds the
    // HTTP/2 connection open until GC collects the Readable.
    if (upstreamBody && !upstreamBody.destroyed) {
      try { (upstreamBody as any).destroy(); } catch { /* already done */ }
    }

    // Network errors / timeouts — return a synthetic 502
    // If TTFB timer was still pending when we hit an AbortError, it means the
    // total timeout fired first but the TTFB timeout hadn't elapsed yet — this
    // is a genuine total timeout, not a TTFB failure.  If the TTFB timer was
    // already cleared (fired), treat it as a TTFB timeout regardless of which
    // rejection won Promise.race.
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    const isTTFB = ttfbTimedOut || (isAbort && ttfbTimer === null);

    // Diagnostic: log the error type for "ReadableStream is locked" to help identify
    // whether it comes from undici internals, Web Streams API, or our wrapper code.
    const errMsg = (error as Error).message ?? String(error);
    if (errMsg.includes("locked") || errMsg.includes("ReadableStream")) {
      console.warn(`[proxy] Stream lock error on "${provider.name}": ${errMsg}`, {
        errorType: (error as Error).constructor?.name,
        hasUpstreamBody: !!upstreamBody,
        upstreamDestroyed: upstreamBody?.destroyed,
        hasPassThrough: !!passThrough,
        passThroughDestroyed: passThrough?.destroyed,
      });
    }

    const message = isTTFB
      ? `Provider "${provider.name}" timed out waiting for first byte after ${ttfbTimeout}ms`
      : isAbort
        ? `Provider "${provider.name}" timed out after ${provider.timeout}ms`
        : `Provider "${provider.name}" connection failed: ${errMsg}`;

    if (isTTFB) boostManager.recordTimeoutError(provider, "ttfb");
    else if (isAbort) boostManager.recordTimeoutError(provider, "timeout");

    console.warn(`[proxy] ${message}`);

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

    // Tag TTFB/total-timeout/connection-failure 502s with CONN_ERROR_HEADER so that
    // recordResult() call sites can distinguish them from real upstream 502s.
    // Race-cancellation 502s ("cancelled by race winner") are NOT tagged — they
    // should not count toward the circuit breaker threshold either way.
    const isConnError = isTTFB || !isAbort;
    const response = makeErrorResponse(502, "overloaded_error", message, isConnError);
    return response;
  } finally {
    removeAbortListener?.();
    // Release session pool in-flight count ONLY for early-return paths where
    // safeClose/cancel() will NOT be called (4xx/5xx, non-standard body, catch).
    // On the normal streaming path, streamCreated=true and safeClose/cancel() owns
    // the release — finally does NOT release there (would cause count=0 while stream
    // is still active → sweep() could close the agent mid-stream).
    if (sessionPool && ctx.sessionId && !streamCreated) {
      sessionPool.release(ctx.sessionId, poolModel);
    }
  }
}

/** Maximum retries for connection errors (stale pool, timeout, stall). */
const CONNECTION_RETRY_MAX = 3;
/** Base delay (ms) between connection retry attempts. */
const CONNECTION_RETRY_BASE_MS = 500;
/**
 * TTFB timeouts get fewer retries than other connection errors.
 * If a provider hasn't responded in ttfbTimeout ms, it's genuinely slow/overloaded —
 * retrying many times wastes time. Socket errors (ECONNRESET etc.) get the full
 * connectionRetries budget because those are transient/stale-connection issues.
 */
const TTFB_RETRY_CAP = 2;

/**
 * Forward a request to a single provider with automatic retry on timeout/connection error.
 * On the first attempt, uses the provider's pooled connection agent.
 * If the request times out or hits a connection error, retries up to CONNECTION_RETRY_MAX
 * times with a fresh connection pool and exponential backoff.
 *
 * TTFB timeouts are capped at TTFB_RETRY_CAP retries — if the provider is slow, fewer
 * retries before escalating to the fallback chain.
 *
 * Connection errors (stale pool, timeout, stall) are local artifacts — the client
 * should never see a 502 from them. Only actual upstream 5xx responses escape
 * this function as 502.
 */
async function forwardWithRetry(
  provider: ProviderConfig,
  entry: RoutingEntry,
  ctx: RequestContext,
  incomingRequest: Request,
  chainSignal: AbortSignal | undefined,
  index: number,
  probeId?: number,
  sessionPool?: SessionAgentPool,
): Promise<Response> {
  let lastResult: Response | undefined;

  const maxRetries = provider._connectionRetries ?? CONNECTION_RETRY_MAX;
  let ttfbFailures = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await forwardRequest(provider, entry, ctx, incomingRequest, chainSignal, index, probeId, sessionPool);

    // Non-502/504 responses pass through immediately (success or upstream error)
    if (result.status !== 502 && result.status !== 504) return result;

    // Check if this is a connection error vs an actual upstream 502/504
    const body = await result.text().catch(() => "");
    const isConnectionError = body.includes("timed out") || body.includes("connection failed") || body.includes("stalled");

    if (!isConnectionError) {
      // Actual 502/504 from upstream — return as-is, let caller handle fallback
      return new Response(body, {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    }

    // Connection error — retry with fresh pool. Tag with CONN_ERROR_HEADER so
    // recordResult() knows NOT to count this toward the circuit breaker threshold.
    lastResult = new Response(body, {
      status: 502,
      headers: { "content-type": "application/json", [CONN_ERROR_HEADER]: CONN_ERROR_VALUE },
    });

    // TTFB-specific retry cap: if the provider is slow (not just a stale connection),
    // don't waste time retrying — escalate to fallback sooner.
    const isTtfbTimeout = body.includes("timed out");
    if (isTtfbTimeout) {
      ttfbFailures++;
      if (ttfbFailures > TTFB_RETRY_CAP) {
        console.warn(`[proxy] TTFB cap reached (${ttfbFailures}) for "${provider.name}" — escalating to fallback`);
        break; // Exit retry loop, let fallback chain try next provider
      }
    }

    if (attempt < maxRetries) {
      // Only evict the session-scoped agent — do NOT close/destroy the provider's
      // shared agent, Closing it shared agent would kill all concurrent requests
      // to this provider. The session pool eviction gives the retry a fresh
      // session-scoped connection while leaving the shared pool intact.
      if (sessionPool && ctx.sessionId) {
        sessionPool.evict(ctx.sessionId, ctx.actualModel ?? ctx.model);
      }

      const delay = CONNECTION_RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(`[proxy] Connection error on "${provider.name}" (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms: ${body.slice(0, 200)}`);

      // Reset stream state for retry
      ctx._streamState = "start";
      (ctx as any)._stallFired = false;

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted — return the last connection error as 502.
  // Caller (fallback chain) will try the next provider.
  // Record connection-level error once per request (not per attempt) for accurate GUI counters.
  const lastBody = await lastResult!.text().catch(() => "");
  if (lastBody.includes("timed out")) {
    _metricsStore?.recordConnectionError(provider.name, "ttfbTimeouts");
  } else if (lastBody.includes("connection failed")) {
    _metricsStore?.recordConnectionError(provider.name, "connectionErrors");
  }
  // Stall errors are recorded in handleStall() (per-request, no retry amplification).

  console.warn(`[proxy] All ${maxRetries + 1} attempts failed for "${provider.name}" — escalating to fallback`);
  return lastResult!;
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
  probeId?: number,
  sessionPool?: SessionAgentPool,
  chainLength?: number,
): Promise<Response> {
  const count = ctx.hasDistribution ? 1 : computeHedgingCount(provider, hedging, chainLength);

  if (count <= 1) {
    // No hedging — single request (with automatic retry on timeout)
    inFlightCounter.increment(provider.name);
    const start = Date.now();
    try {
      const r = await forwardWithRetry(provider, entry, ctx, incomingRequest, chainSignal, index, probeId, sessionPool);
      latencyTracker.record(provider.name, Date.now() - start);
      // Record circuit breaker result here — but only for race (non-distribution) mode.
      // Distribution mode records in forwardWithFallback() to include re-warm logic.
      // Skip connection-error 502s — local artifacts that shouldn't count toward threshold.
      // But MUST release the probe slot if one was granted, otherwise the breaker
      // gets permanently stuck in half-open with halfOpenInProgress=true.
      if (provider._circuitBreaker && !ctx.hasDistribution) {
        if (!isCircuitBreakerSkipResponse(r) && !isConnectionErrorResponse(r)) {
          provider._circuitBreaker.recordResult(r.status, probeId);
        } else if (isConnectionErrorResponse(r) && probeId !== undefined) {
          provider._circuitBreaker.recordProbeTimeout(probeId);
        }
      }
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
  // Track per-copy start times for accurate TTFB measurement.
  // Using Date.now() at launch captures the speculative delay for staggered copies.
  const hedgeStarts: number[] = [];

  for (let h = 0; h < count; h++) {
    inFlightCounter.increment(provider.name);
    const hedgeSignal = chainSignal
      ? AbortSignal.any([chainSignal, hedgeController.signal])
      : hedgeController.signal;
    // Isolate stream state per hedge copy — each copy races independently
    // and may set _streamState/_stallFired via stall timers or error handlers.
    // Shallow clone ensures mutations don't leak to sibling copies or the parent ctx.
    const hedgeCtx: typeof ctx = { ...ctx, _streamState: "start" };
    (hedgeCtx as any)._stallFired = false;
    hedgeStarts.push(Date.now());
    launched.push(
      forwardRequest(provider, entry, hedgeCtx, incomingRequest, hedgeSignal, index, undefined, sessionPool)
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

      // Record each hedged copy's result for circuit breaker — but skip responses
      // from circuitBreakerErr() (synthetic 502s from locally-applied CB skips)
      // and connection-error 502s (TTFB timeout, stale pool — local artifacts).
      if (provider._circuitBreaker && !isCircuitBreakerSkipResponse(winner.response) && !isConnectionErrorResponse(winner.response)) {
        provider._circuitBreaker.recordResult(winner.response.status);
      }

      if (winner.response.status >= 200 && winner.response.status < 300) {
        // Record the winning copy's actual TTFB (from its launch to resolution),
        // not the overall hedge wall-clock time. This prevents speculative delay
        // from inflating latency measurements and CV calculations.
        const hedgeLatency = Date.now() - (hedgeStarts[winner.hedgeIndex] ?? start);
        latencyTracker.record(provider.name, hedgeLatency);
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
              // Skip circuit-breaker-skip synthetic 502s — they are not upstream failures
              if (isCircuitBreakerSkipResponse(r.response)) return;
              // Skip connection-error 502s (TTFB timeout, stale pool) — local artifacts
              if (isConnectionErrorResponse(r.response)) return;
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

    // All hedged copies returned errors — cancel bodies (skip [0] since we return it)
    hedgeController.abort();
    for (let fi = 1; fi < failures.length; fi++) { try { failures[fi].body?.cancel(); } catch {} }
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
  sessionPool?: SessionAgentPool,
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

    let singleProbeId: number | undefined;
    if (provider._circuitBreaker) {
      const cb = provider._circuitBreaker.canProceed();
      if (!cb.allowed) {
        logger?.warn("Provider skipped by circuit breaker", { requestId: ctx.requestId, provider: entry.provider });
        return { response: circuitBreakerErr(entry.provider), actualModel: entry.model, actualProvider: entry.provider };
      }
      singleProbeId = cb.probeId;
    }

    onAttempt?.(entry.provider, 0);

    const singleStart = Date.now();
    let response = await hedgedForwardRequest(provider, entry, ctx, incomingRequest, undefined, 0, logger, hedging, singleProbeId, sessionPool, chain.length);
    const success = response.status >= 200 && response.status < 300;
    const isConnErr = response.status === 502 && await isConnectionErrorBody(response);
    if (!isConnErr) {
      recordHealthEvent(provider.name, success, Date.now() - singleStart);
    }

    // Single-provider transient body error retry: if the provider returned any error
    // with a transient body pattern (e.g., "Network error", "Operation failed"),
    // retry with a fresh connection pool instead of returning the error to the client.
    if (!success && !isConnErr) {
      try {
        const errBody = await response.text();
        if (isTransientBodyError(response.status, errBody, provider.retryableErrorPatterns)) {
          console.warn(`[proxy] Single-provider chain detected transient body error on "${provider.name}" (HTTP ${response.status}): ${errBody.slice(0, 300)} — retrying with fresh pool`);
          // Evict session agent to force a new connection on retry
          if (sessionPool && ctx.sessionId) {
            sessionPool.evict(ctx.sessionId, ctx.actualModel ?? ctx.model);
            ctx.sessionId = undefined;
          }
          // Retry once with fresh pool
          response = await hedgedForwardRequest(provider, entry, ctx, incomingRequest, undefined, 0, logger, hedging, singleProbeId, sessionPool, chain.length);
          const retrySuccess = response.status >= 200 && response.status < 300;
          recordHealthEvent(provider.name, retrySuccess, Date.now() - singleStart);
        }
      } catch {
        // Body read failed — proceed with original response
      }
    }

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

      const attemptStart = Date.now();
      try {
        const response = await hedgedForwardRequest(
          provider, entry, ctx, incomingRequest, undefined, i, logger, hedging,
          cbProbeId, sessionPool, chain.length,
        );

        const attemptLatency = Date.now() - attemptStart;
        const success = response.status >= 200 && response.status < 300;

        // Don't tank health score for connection errors (stale pool, timeout, stall).
        // These are local artifacts, not provider failures — recording them false
        // cascades into global backoff and health-based deprioritization.
        const isConnErr = response.status === 502 && await isConnectionErrorBody(response);
        if (!isConnErr) {
          recordHealthEvent(provider.name, success, attemptLatency);
        }

        if (provider._circuitBreaker) {
          const prevCB = provider._circuitBreaker.getState();
          // Skip connection-error 502s — these are local artifacts (stale pool,
          // TTFB timeout), not upstream failures.  But MUST release the probe
          // slot if one was granted, otherwise the breaker gets permanently stuck.
          if (!isConnectionErrorResponse(response)) {
            provider._circuitBreaker.recordResult(response.status, cbProbeId);
          } else if (cbProbeId !== undefined) {
            provider._circuitBreaker.recordProbeTimeout(cbProbeId);
          }
          // Re-warm pool on circuit breaker recovery (half-open → closed)
          if (prevCB === "half-open" && provider._circuitBreaker.getState() === "closed") {
            warmupProvider(provider).catch(() => {});
          }
        }

        if (response.status >= 200 && response.status < 300) {
          return { response, actualModel: entry.model, actualProvider: entry.provider };
        }

        if (!isRetriable(response.status)) {
          // Non-retriable error — check body for transient patterns regardless of status code
          if (response.body) {
            try {
              const errBody = await response.text();

              // Check: does the body match a transient error pattern?
              // Any status code can carry a transient error — providers return
              // server-side failures as 400, 403, 422, etc.
              if (isTransientBodyError(response.status, errBody, provider.retryableErrorPatterns)) {
                console.warn(`[proxy] Transient body error on "${provider.name}" (HTTP ${response.status}): ${errBody.slice(0, 300)} — treating as retriable`);
                // Fall through to retriable path below — trigger fallback to next provider
              } else {
                // Not transient — check for context window error (400/413 only)
                const handled = handleContextWindowError(response.status, errBody);
                if (handled) return { response: handled, actualModel: entry.model, actualProvider: entry.provider };
                return {
                  response: new Response(errBody, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: stripTransferEncoding(response.headers),
                  }),
                  actualModel: entry.model,
                  actualProvider: entry.provider,
                };
              }
            } catch {
              return { response, actualModel: entry.model, actualProvider: entry.provider };
            }
          } else {
            return { response, actualModel: entry.model, actualProvider: entry.provider };
          }
        }

        // Retriable error — back off before the next attempt.
        // If a Retry-After header was present on the 429/503, respect it so we
        // don't hammer a still-rate-limited provider and extend the outage.
        const backoffMs = ctx._retryAfterMs ?? 0;
        if (backoffMs > 0) {
          logger?.warn("Provider failed with retriable status, backing off before retry", {
            requestId: ctx.requestId,
            provider: entry.provider,
            status: response.status,
            backoffMs,
          });
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          // Consume the value so it's only applied once per provider attempt.
          // The _retryAfterMs set by the 429 handler was for that specific
          // provider; clear it so the next provider in the chain starts fresh.
          ctx._retryAfterMs = 0;
        } else {
          logger?.warn("Provider failed with retriable status, falling back", {
            requestId: ctx.requestId,
            provider: entry.provider,
            status: response.status,
            index: i,
          });
        }
        // continue loop
      } catch {
        // Connection errors/exceptions should NOT tank health score
        // (they're local pool artifacts, not provider failures)
        if (provider._circuitBreaker) {
          if (cbProbeId !== undefined) provider._circuitBreaker.recordProbeTimeout(cbProbeId);
          else provider._circuitBreaker.recordTimeout();
        }
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

    // Isolate stream state for each racing provider — previous attempt may have
    // set _streamState to "error" and _stallFired to true. Shallow clone prevents
    // concurrent providers from corrupting each other's stream state machine.
    const raceCtx: typeof ctx = { ...ctx, _streamState: "start" };
    (raceCtx as any)._stallFired = false;

    const attemptStart = Date.now();
    try {
      const response = await hedgedForwardRequest(
        provider,
        entry,
        raceCtx,
        incomingRequest,
        sharedController.signal,
        index,
        logger,
        hedging,
        cbProbeId,
        sessionPool,
        chain.length,
      );
      const attemptLatency = Date.now() - attemptStart;
      const success = response.status >= 200 && response.status < 300;
      const isConnErr = response.status === 502 && await isConnectionErrorBody(response);
      if (!isConnErr) {
        recordHealthEvent(provider.name, success, attemptLatency);
      }
      return { response, index };
    } catch {
      if (provider._circuitBreaker) {
        if (cbProbeId !== undefined) provider._circuitBreaker.recordProbeTimeout(cbProbeId);
        else provider._circuitBreaker.recordTimeout();
      }
      // Connection errors should NOT tank health score
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
        // Circuit breaker recording is handled inside hedgedForwardRequest()
        // (both single-copy and multi-copy paths record via recordResult).
        // Skip recording here to avoid double-recording in race+hedge mode.
        const winningEntry = chain[winner.index];
        const winningProvider = winningEntry ? providers.get(winningEntry.provider) : undefined;
        // Re-warm pool on circuit breaker recovery (half-open → closed).
        // hedgedForwardRequest may have already called recordResult internally,
        // transitioning half-open → closed. Warmup is idempotent.
        if (winningProvider?._circuitBreaker?.getState() === "closed") {
          warmupProvider(winningProvider).catch(() => {});
        }
        for (const f of failures) {
          void f.response.body?.cancel?.().catch(() => {});
        }
        return { response: winner.response, actualModel: winningEntry?.model, actualProvider: winningEntry?.provider };
      }

      if (!isRetriable(winner.response.status)) {
        sharedController.abort();
        const winnerEntry = chain[winner.index];
        if (winner.response.body) {
          try {
            const errBody = await winner.response.text();
            // Check transient body patterns for any status code
            const winningProvider = providers.get(winnerEntry?.provider ?? '');
            if (isTransientBodyError(winner.response.status, errBody, winningProvider?.retryableErrorPatterns)) {
              console.warn(`[proxy] Race winner transient body error on "${winnerEntry?.provider}" (HTTP ${winner.response.status}): ${errBody.slice(0, 300)} — treating as retriable`);
              // Fall through to failure path — push to failures and continue racing
            } else {
              const handled = handleContextWindowError(winner.response.status, errBody);
              if (handled) return { response: handled, actualModel: winnerEntry?.model, actualProvider: winnerEntry?.provider };
              return {
                response: new Response(errBody, {
                  status: winner.response.status,
                  statusText: winner.response.statusText,
                  headers: stripTransferEncoding(winner.response.headers),
                }),
                actualModel: winnerEntry?.model,
                actualProvider: winnerEntry?.provider,
              };
            }
          } catch {
            return { response: winner.response, actualModel: winnerEntry?.model, actualProvider: winnerEntry?.provider };
          }
        } else {
          return { response: winner.response, actualModel: winnerEntry?.model, actualProvider: winnerEntry?.provider };
        }
      }

      failures.push(winner);

      // Circuit breaker recording for losing providers is handled inside
      // hedgedForwardRequest() — skip here to avoid double-recording.
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
