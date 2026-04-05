// src/server.ts
import { Hono } from "hono";
import { resolveRequest, clearRoutingCache } from "./router.js";
import { forwardWithFallback, setMetricsStore as setProxyMetricsStore, type FallbackResult, recordProviderLatency } from "./proxy.js";
import { SessionAgentPool } from "./session-pool.js";
import { createLogger, type LogLevel } from "./logger.js";
import type { AppConfig, ProviderConfig, RequestContext, StreamState } from "./types.js";
import { transitionStreamState } from "./types.js";
import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

import type { MetricsStore } from "./metrics.js";
import { latencyTracker, inFlightCounter, getHedgeStats, clearHedgeStats } from "./hedging.js";
import { getPoolStats } from "./pool.js";
import { getAllHealthScores } from "./health-score.js";
import { broadcastStreamEvent, broadcastProviderHealth, buildProviderHealth } from "./ws.js";
import { ActiveProbeManager } from "./health-probe.js";

const gzipAsync = promisify(gzip);

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-haiku-4-5-20251001': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-3-5-haiku': 200000,
  'glm-4.7': 128000,
  'glm-5-turbo': 128000,
};

// Pre-built prefix lookup sorted longest-first for correct specificity
const CONTEXT_WINDOW_PREFIXES: [string, number][] = Object.entries(MODEL_CONTEXT_WINDOWS)
  .sort((a, b) => b[0].length - a[0].length);

function getContextWindow(model: string): number {
  // Exact match first, then prefix match (longest prefix first)
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  for (const [key, size] of CONTEXT_WINDOW_PREFIXES) {
    if (model.startsWith(key)) return size;
  }
  return 0;
}

function computeCacheHitRate(cacheRead: number, cacheCreation: number, input: number): number {
  const totalInput = input + cacheRead + cacheCreation;
  if (totalInput <= 0) return 0;
  return Math.round((cacheRead / totalInput) * 1000) / 10;
}

function computeContextPercent(input: number, cacheRead: number, cacheCreation: number, output: number, contextWindow: number): number {
  if (contextWindow <= 0) return 0;
  const total = input + cacheRead + cacheCreation + output;
  return Math.round((total / contextWindow) * 1000) / 10;
}

function anthropicError(type: string, message: string, requestId: string): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status: 502,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
    }
  );
}

/**
 * Parse token counts from an SSE data line's JSON payload.
 * Supports both Anthropic (input_tokens/output_tokens) and OpenAI (prompt_tokens/completion_tokens) formats.
 */
function parseUsageFromData(data: Record<string, unknown>): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } {
  const usage = (data.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined
    ?? data.usage as Record<string, unknown> | undefined;
  if (!usage) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

  const inp = (usage.input_tokens as number | undefined) ?? (usage.prompt_tokens as number | undefined) ?? 0;
  const out = (usage.output_tokens as number | undefined) ?? (usage.completion_tokens as number | undefined) ?? 0;
  const cacheRead = (usage.cache_read_input_tokens as number | undefined) ?? 0;
  const cacheCreation = (usage.cache_creation_input_tokens as number | undefined) ?? 0;

  return { inputTokens: inp, outputTokens: out, cacheReadTokens: cacheRead, cacheCreationTokens: cacheCreation };
}

/**
 * Sanitize upstream provider responses that return null where Claude Code
 * expects an object. Without this, Claude Code crashes with:
 * "null is not an object (evaluating 'X.content')"
 *
 * Replaces:
 *   "message":null        → message object with essential fields
 *   "content_block":null  → content_block object with essential fields
 *   "delta":null          → delta object with essential fields
 *   "content":null        → empty array (safe for Anthropic content field)
 */
const NULL_SANITIZE_RE = /"(message|content_block|delta|content|thinking|thinking_bytes|thinking_control|signature|text|partial_json|name|input)"\s*:\s*null(?!["\w])/g;
// Pre-compiled regex for token fields (used in scanWindow — hoisted to module level to avoid per-chunk recompilation)
const TOKEN_FIELDS_RE = /"(input_tokens|prompt_tokens|cache_read_input_tokens|cache_creation_input_tokens|output_tokens|completion_tokens)"\s*:\s*(\d+)/g;
const NULL_REPLACEMENTS: Record<string, string> = {
  message:        '"message":{"id":"","type":"message","role":"assistant","content":[]}',
  content_block:  '"content_block":{"type":"text","text":""}',
  delta:          '"delta":{"type":"text_delta","text":""}',
  content:        '"content":[]',
  thinking:       '"thinking":""',
  thinking_bytes: '"thinking_bytes":""',
  thinking_control: '"thinking_control":""',
  signature:      '"signature":""',
  text:          '"text":""',
  partial_json: '"partial_json":""',
  name:          '"name":""',
  input:          '"input":{}',
};
function sanitizeNullObjects(text: string): string {
  if (!text.includes("null")) return text;
  // Critical: replace bare "data: null" SSE lines
  // sometimes send these, and the Anthropic SDK crashes with "null is not an object
  // (evaluating 'Y8.content')" when it tries to parse and access properties on null.
  // This is the server.ts defense-in-depth layer — proxy.ts also handles this per-chunk,
  // but this catches any cases where TCP chunk boundaries split the line.
  let result = text.replace(/^data:\s*null\s*$/gm, 'data: {}');
  result = result.replace(NULL_SANITIZE_RE, (_, key: string) => NULL_REPLACEMENTS[key] ?? _);
  return result;
}

/**
 * Check if an SSE event text contains only null content fields in its delta.
 * Used to drop spurious spacer deltas that crash the Anthropic SDK (v2.1.88+).
 */
function isNullOnlyDelta(eventText: string): boolean {
  if (!eventText.includes("content_block_delta")) return false;
  if (!/"(thinking|text|partial_json)"\s*:\s*null(?=[\s,}\]])/.test(eventText)) return false;
  // Has at least one non-null content field? Then it's a real delta, keep it.
  if (/"(thinking|text|partial_json)"\s*:\s*"[^"]+"/.test(eventText)) return false;
  return true;
}

/**
 * Check if an SSE event is a content_block_start for a thinking block.
 * Returns the block index if it is, or -1 if not.
 */
function getThinkingBlockIndex(eventText: string): number {
  if (!eventText.includes("content_block_start")) return -1;
  if (!/"type"\s*:\s*"thinking"/.test(eventText)) return -1;
  const m = eventText.match(/"index"\s*:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * Check if an SSE event references a block index in the omitted set.
 */
function isForOmittedIndex(eventText: string, omittedIndices: Set<number>): boolean {
  if (!eventText.includes("content_block_delta") && !eventText.includes("content_block_stop")) return false;
  for (const idx of omittedIndices) {
    if (eventText.includes(`"index":${idx}`) || eventText.match(new RegExp(`"index"\\s*:\\s*${idx}\\b`))) {
      return true;
    }
  }
  return false;
}

/**
 * Lightweight TransformStream that only sanitizes null objects — used when
 * there is no MetricsStore (i.e. no metrics collection needed).
 * Buffers complete SSE events (delimited by \n\n) before sanitizing to avoid
 * null patterns split across TCP chunk boundaries.
 *
 * Defense layers:
 * 1. Omit thinking blocks entirely — prevents Y8.content crash from null thinking data
 * 2. Drop null-only delta events — catches spacer deltas from any provider
 * 3. message_start pre-flight — ensures SDK state is initialized before content
 */
function createSanitizeTransform(): TransformStream<Uint8Array, Uint8Array> {
  // Pure passthrough — forward bytes without modification.
  // Direct upstream connections work fine, so the proxy must be invisible.
  // Any stream modification (null sanitization, thinking block filtering,
  // SSE event rewriting) introduces crash paths in the Anthropic SDK.
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
  });
}

/**
 * Creates a TransformStream that sanitizes null objects AND extracts
 * token counts for metrics inline (no tee() or separate reader needed).
 * For SSE responses, extracts token counts from usage events incrementally.
 * For non-streaming JSON responses, uses a bounded sliding-window regex scan.
 */
function createMetricsTransform(
  ctx: { requestId: string; model: string; actualModel?: string; tier: string; startTime: number; fallbackMode?: "sequential" | "race"; sessionId?: string; _streamState?: StreamState },
  provider: string,
  targetProvider: string,
  metricsStore: MetricsStore,
  config: AppConfig,
  status: number,
  contentType: string,
): TransformStream<Uint8Array, Uint8Array> {
  const td = new TextDecoder();
  const te = new TextEncoder();

  // --- SSE state ---
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let lineBuf = "";
  let eventBuf = "";

  // --- JSON state ---
  const WINDOW_SIZE = 4096;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let windowBuf = "";

  // Detection: resolved after the first chunk arrives
  let isSSE: boolean | null = null;

  // Stream event throttling (~4 Hz)
  const STREAM_THROTTLE_MS = 250;
  let lastStreamEmit = 0;
  let firstChunk = true;

  // Response text preview (last 100 chars for progress bar tooltip)
  let responsePreview = "";
  const PREVIEW_MAX = 100;

  const drainEvents = (eventText: string) => {
    for (const event of eventText.split("\n\n")) {
      if (!event) continue;
      const dataLine = event.split("\n").find(l => l.startsWith("data:"));
      if (!dataLine) continue;

      // Fast path: skip JSON.parse entirely if the event has nothing we need.
      // Only ~5-10 of ~100-500 SSE events contain usage/preview data.
      const hasUsage = dataLine.indexOf('"usage"') !== -1;
      const hasDelta = dataLine.indexOf('"delta"') !== -1;
      const hasChoices = dataLine.indexOf('"choices"') !== -1;
      if (!hasUsage && !hasDelta && !hasChoices) continue;

      try {
        const data = JSON.parse(dataLine.slice(5)) as Record<string, unknown>;

        // Extract usage (token counts)
        if (hasUsage) {
          const usage = parseUsageFromData(data);
          if (usage.inputTokens > tokens.input) tokens.input = usage.inputTokens;
          if (usage.outputTokens > tokens.output) tokens.output = usage.outputTokens;
          if (usage.cacheReadTokens > tokens.cacheRead) tokens.cacheRead = usage.cacheReadTokens;
          if (usage.cacheCreationTokens > tokens.cacheCreation) tokens.cacheCreation = usage.cacheCreationTokens;
        }

        // Extract text content for preview
        // Anthropic format: content_block_delta with delta.text
        if (hasDelta) {
          const delta = data.delta as Record<string, unknown> | undefined;
          if (delta && typeof delta.text === "string") {
            responsePreview += delta.text;
            if (responsePreview.length > PREVIEW_MAX) {
              responsePreview = responsePreview.slice(-PREVIEW_MAX);
            }
          }
        }
        // OpenAI format: choices[0].delta.content
        if (hasChoices) {
          const choices = data.choices as Array<Record<string, unknown>> | undefined;
          if (choices?.[0]) {
            const choiceDelta = choices[0].delta as Record<string, unknown> | undefined;
            if (choiceDelta && typeof choiceDelta.content === "string") {
              responsePreview += choiceDelta.content;
              if (responsePreview.length > PREVIEW_MAX) {
                responsePreview = responsePreview.slice(-PREVIEW_MAX);
              }
            }
          }
        }
      } catch {
        // JSON parse failed — malformed data from upstream (e.g. truncated SSE,
        // partial JSON). Skip silently to avoid crashing the metrics pipeline.
      }
    }
  };

  const scanWindow = (text: string) => {
    // Fast bailout: most chunks don't contain usage data
    const hasUsage = text.includes('"usage"');

    // Use module-level pre-compiled regex — reset lastIndex for global flag
    if (hasUsage) {
      TOKEN_FIELDS_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TOKEN_FIELDS_RE.exec(text)) !== null) {
        const val = parseInt(m[2], 10);
        const field = m[1];
        if (field === "input_tokens" || field === "prompt_tokens") {
          if (val > inputTokens) inputTokens = val;
        } else if (field === "cache_read_input_tokens") {
          if (val > cacheReadTokens) cacheReadTokens = val;
        } else if (field === "cache_creation_input_tokens") {
          if (val > cacheCreationTokens) cacheCreationTokens = val;
        } else if (field === "output_tokens" || field === "completion_tokens") {
          if (val > outputTokens) outputTokens = val;
        }
      }
    }

    // Extract text content for preview from JSON responses
    // Anthropic format: "content":[{"type":"text","text":"..."}]
    const textBlockMatches = [...text.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
    if (textBlockMatches.length > 0) {
      const rawValue = textBlockMatches[textBlockMatches.length - 1][1];
      // Use JSON.parse to correctly handle ALL escape sequences (\uXXXX, \t, \r, etc.)
      let lastText: string;
      try {
        lastText = JSON.parse(`"${rawValue}"`);
      } catch {
        lastText = rawValue;
      }
      responsePreview += lastText;
      if (responsePreview.length > PREVIEW_MAX) {
        responsePreview = responsePreview.slice(-PREVIEW_MAX);
      }
    }
  };

  const recordMetrics = (inp: number, out: number, cacheRead: number = 0, cacheCreation: number = 0) => {
    try {
      const latencyMs = Date.now() - ctx.startTime;
      const latencySec = latencyMs / 1000;
      const tps = latencySec > 0 ? out / latencySec : 0;

      metricsStore.recordRequest({
        requestId: ctx.requestId,
        model: ctx.model,
        actualModel: ctx.actualModel || ctx.model,
        tier: ctx.tier,
        provider,
        targetProvider,
        status,
        inputTokens: inp,
        outputTokens: out,
        latencyMs,
        tokensPerSec: Math.round(tps * 10) / 10,
        timestamp: Date.now(),
        fallbackMode: ctx.fallbackMode,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        sessionId: ctx.sessionId,
      });

      // Record per-provider latency for percentile logging
      recordProviderLatency(provider, latencyMs);

      // Broadcast provider health on errors
      if (status >= 400 || status < 200) {
        broadcastProviderHealth(buildProviderHealth(config, metricsStore));
      }

      // Broadcast completion event
      const contextWindow = getContextWindow(ctx.actualModel || ctx.model);
      setImmediate(() => {
        ctx._streamState = transitionStreamState(ctx, "complete", ctx.requestId);
        if (ctx._streamState !== "complete") return; // blocked by terminal state
        broadcastStreamEvent({
          requestId: ctx.requestId,
          model: ctx.actualModel || ctx.model,
          tier: ctx.tier,
          state: ctx._streamState,
          status,
          latencyMs: Date.now() - ctx.startTime,
          inputTokens: inp,
          outputTokens: out,
          tokensPerSec: Math.round(tps * 10) / 10,
          timestamp: Date.now(),
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreation,
          cacheHitRate: computeCacheHitRate(cacheRead, cacheCreation, inp),
          contextPercent: computeContextPercent(inp, cacheRead, cacheCreation, out, contextWindow),
          contextWindowSize: contextWindow || undefined,
        });
      });
    } catch {
      // Metrics recording errors must not affect the response stream
    }
  };

  const processChunk = (decoded: string, isFinal: boolean, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (isSSE === null) {
      // First chunk — detect format
      isSSE = contentType.includes("text/event-stream") || decoded.startsWith("event:") || decoded.startsWith("data:");
    }

    if (isSSE) {
      lineBuf += decoded.replace(/\r$/, ""); // strip trailing \r from \r\n line endings
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop()!;

      for (const line of lines) {
        if (line === "") {
          if (eventBuf) {
            drainEvents(eventBuf);
            // Pure passthrough — forward event unchanged
            controller.enqueue(te.encode(eventBuf + "\n\n"));
            eventBuf = "";
          }
        } else {
          eventBuf += (eventBuf ? "\n" : "") + line;
        }
      }

      if (isFinal) {
        if (eventBuf.trim()) {
          drainEvents(eventBuf);
          controller.enqueue(te.encode(eventBuf));
        }
        recordMetrics(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreation);
        return;
      }

      // Emit streaming progress (throttled ~4 Hz)
      const now = Date.now();
      if (firstChunk || now - lastStreamEmit >= STREAM_THROTTLE_MS) {
        lastStreamEmit = now;
        firstChunk = false;
        const contextWindow = getContextWindow(ctx.actualModel || ctx.model);
        setImmediate(() => {
          if (ctx._streamState !== "streaming") {
            ctx._streamState = transitionStreamState(ctx, "streaming", ctx.requestId);
          }
          if (ctx._streamState === "error" || ctx._streamState === "complete") return;
          broadcastStreamEvent({
            requestId: ctx.requestId,
            model: ctx.actualModel || ctx.model,
            tier: ctx.tier,
            state: ctx._streamState ?? "streaming",
            outputTokens: tokens.output,
            timestamp: now,
            preview: responsePreview,
            cacheHitRate: computeCacheHitRate(tokens.cacheRead, tokens.cacheCreation, tokens.input),
            contextPercent: computeContextPercent(tokens.input, tokens.cacheRead, tokens.cacheCreation, tokens.output, contextWindow),
            contextWindowSize: contextWindow || undefined,
          });
        });
      }
    } else {
      windowBuf += decoded;
      if (windowBuf.length > WINDOW_SIZE) {
        windowBuf = windowBuf.slice(-WINDOW_SIZE);
      }
      scanWindow(windowBuf);

      // Forward sanitized bytes (non-SSE path — metrics + forwarding in one pass)
      controller.enqueue(te.encode(decoded));

      // Emit streaming progress (throttled ~4 Hz)
      const nowJson = Date.now();
      if (firstChunk || nowJson - lastStreamEmit >= STREAM_THROTTLE_MS) {
        lastStreamEmit = nowJson;
        firstChunk = false;
        const contextWindow = getContextWindow(ctx.actualModel || ctx.model);
        setImmediate(() => {
          if (ctx._streamState !== "streaming") {
            ctx._streamState = transitionStreamState(ctx, "streaming", ctx.requestId);
          }
          if (ctx._streamState === "error" || ctx._streamState === "complete") return;
          broadcastStreamEvent({
            requestId: ctx.requestId,
            model: ctx.actualModel || ctx.model,
            tier: ctx.tier,
            state: ctx._streamState ?? "streaming",
            outputTokens,
            timestamp: nowJson,
            preview: responsePreview,
            cacheHitRate: computeCacheHitRate(cacheReadTokens, cacheCreationTokens, inputTokens),
            contextPercent: computeContextPercent(inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens, contextWindow),
            contextWindowSize: contextWindow || undefined,
          });
        });
      }

      if (isFinal) {
        recordMetrics(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);
      }
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      processChunk(td.decode(chunk, { stream: true }), false, controller);
    },
    flush(controller) {
      processChunk("", true, controller);
    },
  });
}

export interface AppHandle {
  app: Hono;
  getConfig: () => AppConfig;
  setConfig: (config: AppConfig) => Promise<void>;
  closeSessionPool: () => Promise<void>;
  getSessionPoolStats: () => import("./session-pool.js").SessionStats[];
  closeAgents: () => Promise<void>;
  getInFlightCount: () => number;
}

function agentKey(provider: ProviderConfig): string {
  const origin = provider._cachedOrigin;
  const size = provider.poolSize ?? 10;
  return `${origin ?? "unknown"}:${size}`;
}

export function createApp(initConfig: AppConfig, logLevel: LogLevel, metricsStore?: MetricsStore, version?: string): AppHandle {
  let config: AppConfig = initConfig;
  const logger = createLogger(logLevel);
  const app = new Hono();
  const sessionIdleTtlMs = initConfig.server?.sessionIdleTtlMs ?? 600_000;
  const sessionPool = new SessionAgentPool(sessionIdleTtlMs);

  // Share MetricsStore with proxy.ts for connection error tracking (GUI counters)
  if (metricsStore) setProxyMetricsStore(metricsStore);

  // Global error handler — returns Anthropic-compatible JSON error responses
  app.onError((err, c) => {
    console.error(`[server] Unhandled error: ${err.message}`);
    return c.json(
      { type: "error", error: { type: "api_error", message: "Internal proxy error" } },
      { status: 500, headers: { "content-type": "application/json" } }
    );
  });

  // CORS for GUI — restrict to localhost origins
  const ALLOWED_ORIGINS = [
    'http://localhost',
    'http://127.0.0.1',
    'https://localhost',
    'tauri://localhost',
  ];

  app.use("/api/*", async (c, next) => {
    const origin = c.req.header('Origin') || '';
    const isAllowed = !origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.some(o => origin.startsWith(o + ':'));
    c.header("Access-Control-Allow-Origin", isAllowed ? origin : '');
    await next();
  });
  app.options("/api/*", (c) => {
    const origin = c.req.header('Origin') || '';
    const isAllowed = !origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.some(o => origin.startsWith(o + ':'));
    c.header("Access-Control-Allow-Origin", isAllowed ? origin : '');
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version, x-api-key");
    return c.body("", 200);
  });

  app.post("/v1/messages", async (c) => {
    const requestId = randomUUID();

    // Read raw body once, then parse — avoids double serialization
    const maxBodyMB = config.server.maxBodySizeMB ?? 10;
    const MAX_BODY_SIZE = maxBodyMB * 1024 * 1024;
    let body: { model?: string };
    let rawBody: string;
    try {
      rawBody = await c.req.text();
      if (rawBody.length > MAX_BODY_SIZE) {
        return anthropicError("invalid_request_error", `Request body exceeds maximum size of ${maxBodyMB}MB`, requestId);
      }
      body = JSON.parse(rawBody);
    } catch {
      return anthropicError("invalid_request_error", "Invalid JSON body", requestId);
    }

    const model = body.model;
    if (!model) {
      return anthropicError("invalid_request_error", "Missing 'model' field in request body", requestId);
    }

    const ctx = resolveRequest(model, requestId, config, rawBody);
    if (ctx) {
      (ctx as RequestContext & { parsedBody?: Record<string, unknown> }).parsedBody = body as Record<string, unknown>;
    }
    if (!ctx) {
      logger.info("No tier match", { requestId, model });
      const configuredModels = config.modelRouting.size > 0
        ? ` Configured model routes: ${[...config.modelRouting.keys()].join(", ")}.`
        : "";
      return anthropicError(
        "invalid_request_error",
        `No route matches model "${model}". Configured tiers: ${[...config.tierPatterns.keys()].join(", ")}.${configuredModels}`,
        requestId
      );
    }

    // Extract session ID from request headers
    const sessionId = c.req.header("x-session-id") || c.req.header("x-claude-code-session-id");
    if (sessionId) ctx.sessionId = sessionId;

    // Global backoff: all providers in the chain are unhealthy (health < 0.5).
    // Skip the entire fallback chain and return 503 immediately.
    if (ctx._globalBackoff) {
      logger.warn("Global backoff — all providers unhealthy", {
        requestId,
        model,
        tier: ctx.tier,
        providers: ctx.providerChain.map(e => e.provider),
      });
      broadcastStreamEvent({
        requestId,
        model: ctx.providerChain[0]?.model || ctx.model,
        tier: ctx.tier,
        state: "error",
        provider: ctx.providerChain[0]?.provider ?? "unknown",
        timestamp: Date.now(),
        message: "All providers unhealthy — global backoff",
      });
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: `All providers for model "${model}" are currently unhealthy. Please retry later.`,
          },
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
            "retry-after": "30",
            "x-request-id": requestId,
          },
        }
      );
    }

    logger.info("Routing request", {
      requestId,
      model,
      tier: ctx.tier,
      providers: ctx.providerChain.map((e) => e.provider),
    });

    // Broadcast stream start event
    ctx._streamState = "start"; // initialization — skip transition validation
    const parsedBody = (ctx as RequestContext & { parsedBody?: Record<string, unknown> }).parsedBody;
    broadcastStreamEvent({
      requestId,
      model: ctx.providerChain[0]?.model || ctx.model,
      tier: ctx.tier,
      state: ctx._streamState,
      provider: ctx.providerChain[0]?.provider ?? "unknown",
      timestamp: Date.now(),
      maxTokens: typeof parsedBody?.max_tokens === "number" ? parsedBody.max_tokens : undefined,
    });

    // Forward with fallback chain
    let successfulProvider = "unknown";
    let result: FallbackResult;
    inFlightCount++;
    try {
      result = await forwardWithFallback(
        config.providers,
        ctx.providerChain,
        ctx,
        c.req.raw,
        (provider, index) => {
          logger.info("Attempting provider", { requestId, provider, index, tier: ctx.tier });
          if (!successfulProvider) successfulProvider = provider;
        },
        logger,
        config.hedging,
        sessionPool,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Forward failed", { requestId, error: errMsg });
      setImmediate(() => {
        ctx._streamState = transitionStreamState(ctx, "error", ctx.requestId);
        if (ctx._streamState !== "error") return;
        broadcastStreamEvent({
          requestId,
          model: ctx.providerChain[0]?.model || ctx.model,
          tier: ctx.tier,
          state: ctx._streamState,
          status: 502,
          message: errMsg,
          timestamp: Date.now(),
        });
      });
      return c.json(
        { type: "error", error: { type: "api_error", message: "Upstream request failed: " + errMsg } },
        502
      );
    } finally {
      inFlightCount--;
    }

    // Use the actualModel from the winning entry, not ctx.actualModel
    if (result.actualModel) {
      ctx.actualModel = result.actualModel;
    }
    if (result.actualProvider) {
      successfulProvider = result.actualProvider;
    }
    const response = result.response;

    // Broadcast TTFB event — headers received from upstream (skip for error responses)
    if (response.status < 400) {
      let headerSize = 17; // approximate HTTP status line: "HTTP/1.1 200 OK\r\n"
      response.headers.forEach((v, k) => { headerSize += k.length + v.length + 4; });
      headerSize += 2; // trailing CRLF
      setImmediate(() => {
        ctx._streamState = transitionStreamState(ctx, "ttfb", ctx.requestId);
        if (ctx._streamState !== "ttfb") return;
        broadcastStreamEvent({
          requestId,
          model: ctx.providerChain[0]?.model || ctx.model,
          tier: ctx.tier,
          state: ctx._streamState,
          status: response.status,
          headerSize,
          timestamp: Date.now(),
        });
      });
    }

    // Broadcast error event for non-2xx responses
    if (response.status >= 400) {
      setImmediate(() => {
        ctx._streamState = transitionStreamState(ctx, "error", ctx.requestId);
        if (ctx._streamState !== "error") return;
        broadcastStreamEvent({
          requestId,
          model: ctx.providerChain[0]?.model || ctx.model,
          tier: ctx.tier,
          state: ctx._streamState,
          status: response.status,
          message: `HTTP ${response.status}`,
          timestamp: Date.now(),
        });
      });
    }

    // Extract tokens via inline TransformStream for successful responses
    let responseBody: ReadableStream<Uint8Array> | null = response.body;
    if (response.body && response.status >= 200 && response.status < 300 && metricsStore) {
      const targetProvider = result.actualProvider || (ctx.providerChain.length > 0 ? ctx.providerChain[0].provider : successfulProvider);
      const transform = createMetricsTransform(ctx, successfulProvider, targetProvider, metricsStore, config, response.status, response.headers.get("content-type") || "");
      responseBody = response.body.pipeThrough(transform) as typeof responseBody;
    } else if (response.status >= 200 && response.status < 300 && !metricsStore) {
      // No metricsStore — sanitize stream and broadcast complete so the GUI progress bar finishes
      if (response.body) {
        responseBody = response.body.pipeThrough(createSanitizeTransform()) as typeof responseBody;
      }
      const latencyMs = Date.now() - ctx.startTime;
      setImmediate(() => {
        ctx._streamState = transitionStreamState(ctx, "complete", ctx.requestId);
        if (ctx._streamState !== "complete") return;
        broadcastStreamEvent({
          requestId,
          model: result.actualModel || ctx.providerChain[0]?.model || ctx.model,
          tier: ctx.tier,
          state: ctx._streamState,
          status: response.status,
          latencyMs,
          outputTokens: 0,
          timestamp: Date.now(),
        });
      });
    } else if (metricsStore && (response.status < 200 || response.status >= 400)) {
      // Error / non-2xx responses — record metrics so provider error tracking
      // picks them up (metricsStore.recordRequest → _providerErrors population).
      // Without this, error responses were never recorded and the GUI showed 0 errors.
      const errorProvider = result.actualProvider || successfulProvider || (ctx.providerChain[0]?.provider ?? "unknown");
      const errorTarget = result.actualProvider || (ctx.providerChain.length > 0 ? ctx.providerChain[0].provider : errorProvider);
      const latencyMs = Date.now() - ctx.startTime;

      metricsStore.recordRequest({
        requestId: ctx.requestId,
        model: ctx.model,
        actualModel: ctx.actualModel || ctx.model,
        tier: ctx.tier,
        provider: errorProvider,
        targetProvider: errorTarget,
        status: response.status,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs,
        tokensPerSec: 0,
        timestamp: Date.now(),
        fallbackMode: ctx.fallbackMode,
        sessionId: ctx.sessionId,
      });

      recordProviderLatency(errorProvider, latencyMs);
      broadcastProviderHealth(buildProviderHealth(config, metricsStore));
    }

    // Add request ID to response (responses from fetch have immutable headers, so create new)
    const newHeaders = new Headers(response.headers);
    newHeaders.set("x-request-id", requestId);
    // Force Transfer-Encoding: chunked to bypass @hono/node-server's buffering logic.
    // The buffering phase (which reads up to 2 chunks before deciding to stream) causes
    // "socket closed unexpectedly" when the upstream body is a slow/long SSE stream — if the
    // initial read() rejects, the adapter sends an empty 200 with Content-Length: 0,
    // which undici interprets as a truncated response and throws.
    // Setting Transfer-Encoding: chunked forces streaming mode and skips buffering.
    // IMPORTANT: only apply to streaming responses (ReadableStream body). Static error
    // responses from makeErrorResponse() already set content-length; having BOTH
    // content-length and Transfer-Encoding is invalid per RFC 7230 §3.3.3 and causes
    // malformed responses that undici may reject with "socket closed unexpectedly".
    if (responseBody instanceof ReadableStream) {
      newHeaders.set("Transfer-Encoding", "chunked");
      // Remove content-length if present — it's incompatible with Transfer-Encoding
      newHeaders.delete("content-length");
    }
    const finalResponse = new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });

    const latency = Date.now() - ctx.startTime;
    logger.info("Request completed", {
      requestId,
      model,
      tier: ctx.tier,
      status: finalResponse.status,
      latencyMs: latency,
    });

    return finalResponse;
  });

  // REST endpoint for metrics summary (used by GUI on connect)
  // Returns gzip-compressed JSON when client supports it
  app.get("/api/metrics/summary", async (c) => {
    if (!metricsStore) return c.json({ error: "Metrics not enabled" }, 503);
    const data = metricsStore.getSummary();
    const json = JSON.stringify(data);

    const acceptEncoding = c.req.header("accept-encoding") || "";
    if (acceptEncoding.includes("gzip") && json.length >= 1024) {
      const compressed = await gzipAsync(Buffer.from(json));
      return new Response(compressed, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "vary": "accept-encoding",
        },
      });
    }

    return c.json(data);
  });

  // Version endpoint
  app.get("/api/version", (c) => c.json({ version: version ?? "unknown" }));

  // Circuit breaker status endpoint
  app.get("/api/circuit-breaker", (c) => {
    const status: Record<string, { state: string; failures: number; lastFailure: string | null }> = {};
    for (const [name, provider] of config.providers) {
      const breaker = provider._circuitBreaker;
      if (breaker) {
        const s = breaker.getStatus();
        status[name] = {
          state: s.state,
          failures: s.failures,
          lastFailure: s.lastFailure ? new Date(s.lastFailure).toISOString() : null,
        };
      }
    }
    return c.json(status);
  });

  // Hedging observability: per-provider CV, latency stats, and hedge win/loss counts
  app.get("/api/hedging/stats", (c) => {
    const stats: Record<string, {
      sampleCount: number;
      meanLatencyMs: number;
      cv: number;
      inFlight: number;
      maxConcurrent: number;
      hedgeWins: number;
      hedgeLosses: number;
    }> = {};
    for (const [name, provider] of config.providers) {
      const ls = latencyTracker.getStats(name);
      const hs = getHedgeStats(name);
      stats[name] = {
        sampleCount: ls.count,
        meanLatencyMs: ls.mean,
        cv: ls.cv,
        inFlight: inFlightCounter.get(name),
        maxConcurrent: provider.concurrentLimit ?? 1,
        hedgeWins: hs.hedgeWins,
        hedgeLosses: hs.hedgeLosses,
      };
    }
    return c.json(stats);
  });

  // Connection pool stats: pool size, in-flight, estimated free, warmup status
  app.get("/api/pool", (c) => {
    const stats = getPoolStats(config.providers, inFlightCounter);
    return c.json(stats);
  });

  // Health scores: real-time per-provider health (success rate + latency)
  app.get("/api/health-scores", (c) => {
    const providerNames = [...config.providers.values()].map(p => p.name);
    const scores = getAllHealthScores(providerNames);
    return c.json(Object.fromEntries(scores));
  });

  // Session pool: active sessions and their per-provider connections
  app.get("/api/sessions", (c) => {
    const sessions = sessionPool.getStats();
    return c.json({
      activeSessions: sessionPool.sessionCount,
      sessions,
    });
  });

  let inFlightCount = 0;

  // Periodically broadcast provider health to all connected GUI clients
  const healthInterval = setInterval(() => {
    if (metricsStore) {
      broadcastProviderHealth(buildProviderHealth(config, metricsStore));
    }
  }, 5000);
  healthInterval.unref();

  // Active health probe for half-open circuit breakers — independent of routing traffic
  const activeProbeManager = new ActiveProbeManager(config.providers);
  activeProbeManager.start();

  return {
    app,
    getConfig: () => config,
    getInFlightCount: () => inFlightCount,
    setConfig: async (newConfig: AppConfig) => {
      // Build key → agent map from old config for reuse lookup
      const oldAgents = new Map<string, import("undici").Agent>();
      for (const provider of config.providers.values()) {
        if (provider._agent) {
          oldAgents.set(agentKey(provider), provider._agent);
        }
      }

      // For each new provider, check if we can reuse an existing agent
      const reusedKeys = new Set<string>();
      for (const provider of newConfig.providers.values()) {
        const key = agentKey(provider);
        const existingAgent = oldAgents.get(key);
        if (existingAgent) {
          // Reuse: the origin and poolSize haven't changed
          provider._agent = existingAgent;
          reusedKeys.add(key);
        }
        // else: loadConfig() already created a fresh agent for this provider
      }

      // Close agents that are no longer needed (removed or changed origin/poolSize)
      const closePromises: Promise<void>[] = [];
      for (const [key, agent] of oldAgents) {
        if (!reusedKeys.has(key)) {
          closePromises.push(agent.close().catch((e) => {
          console.warn(`[server] Failed to close agent: ${e.message}`);
        }));
        }
      }

      await Promise.all(closePromises);
      config = newConfig;
      activeProbeManager.updateProviders(newConfig.providers);
      clearRoutingCache();
      clearHedgeStats();
    },
    closeSessionPool: async () => {
      await sessionPool.closeAll();
    },
    getSessionPoolStats: () => sessionPool.getStats(),
    closeAgents: async () => {
      const closePromises: Promise<void>[] = [];
      for (const provider of config.providers.values()) {
        if (provider._agent) {
          closePromises.push(provider._agent.close().catch(() => {}));
        }
      }
      await Promise.all(closePromises);
    },
  };
}
