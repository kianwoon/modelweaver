// src/server.ts
import { Hono } from "hono";
import { resolveRequest, clearRoutingCache } from "./router.js";
import { classifyTier, extractLastUserMessage } from "./classifier.js";
import { forwardWithFallback, setMetricsStore as setProxyMetricsStore, type FallbackResult, recordProviderLatency } from "./proxy.js";
import { SessionAgentPool, DEFAULT_STALE_AGENT_THRESHOLD_MS } from "./session-pool.js";
import { createLogger, type LogLevel } from "./logger.js";
import type { AppConfig, RequestContext } from "./types.js";
import { transitionStreamState } from "./types.js";
import { resolveConcurrency, getSemaphore, resetSemaphores } from "./concurrency.js";
import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

import type { MetricsStore } from "./metrics.js";
import { latencyTracker, inFlightCounter, getHedgeStats, clearHedgeStats } from "./hedging.js";
import { getPoolStats, closeAllAgents } from "./pool.js";
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

// Dead code removed: NULL_SANITIZE_RE, NULL_REPLACEMENTS, sanitizeNullObjects(),
// isNullOnlyDelta(), getThinkingBlockIndex(), isForOmittedIndex(), createSanitizeTransform()
// were all unused after the pure passthrough change (commit 25a2287).
// The passthrough approach forwards bytes untouched — the Anthropic SDK handles
// native provider SSE correctly without proxy modifications.

/**
 * Creates a TransformStream that extracts token counts from response bytes
 * and records them in the MetricsStore. Used via tee() — the client stream
 * passes through untouched; only the metrics branch flows through this transform.
 * For SSE responses, extracts token counts from usage events incrementally.
 * For non-streaming JSON responses, uses a bounded sliding-window regex scan.
 */
function createMetricsTransform(
  ctx: RequestContext,
  provider: string,
  targetProvider: string,
  metricsStore: MetricsStore,
  config: AppConfig,
  status: number,
  contentType: string,
): TransformStream<Uint8Array, Uint8Array> {
  const td = new TextDecoder();
  const te = new TextEncoder();

  // Token fields regex — used in scanWindow for non-SSE JSON responses
  const TOKEN_FIELDS_RE = /"(input_tokens|prompt_tokens|cache_read_input_tokens|cache_creation_input_tokens|output_tokens|completion_tokens)"\s*:\s*(\d+)/g;

  // --- SSE state ---
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let lineBuf = "";
  let eventLines: string[] = [];

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
      // Use streaming-only duration for TPS (exclude TTFB wait time).
      // Only use streaming duration when it's long enough for reliable measurement
      // (>= 200ms). Short durations (< 200ms) have huge relative error due to
      // Date.now() resolution (~1ms), producing inflated numbers like 64K tok/s.
      const rawStreamDurMs = ctx._streamStartTime ? Date.now() - ctx._streamStartTime : 0;
      const durMs = rawStreamDurMs >= 200 ? rawStreamDurMs : latencyMs;
      const tpsSec = durMs / 1000;
      const tps = tpsSec > 0 ? out / tpsSec : 0;

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
          if (eventLines.length > 0) {
            const eventText = eventLines.join("\n");
            drainEvents(eventText);
            // Pure passthrough — forward event unchanged
            controller.enqueue(te.encode(eventText + "\n\n"));
            eventLines.length = 0;
          }
        } else {
          eventLines.push(line);
        }
      }

      if (isFinal) {
        if (eventLines.length > 0) {
          const eventText = eventLines.join("\n");
          drainEvents(eventText);
          controller.enqueue(te.encode(eventText));
          eventLines.length = 0;
        }
        recordMetrics(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreation);
        return;
      }

      // Emit streaming progress (throttled ~4 Hz)
      const now = Date.now();
      if (firstChunk || now - lastStreamEmit >= STREAM_THROTTLE_MS) {
        lastStreamEmit = now;
        if (firstChunk) ctx._streamStartTime = now; // capture streaming start (excludes TTFB)
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
        if (firstChunk) ctx._streamStartTime = nowJson; // capture streaming start (excludes TTFB)
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
        ctx._finalOutputTokens = outputTokens;
        ctx._finalInputTokens = inputTokens;
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

export function createApp(initConfig: AppConfig, logLevel: LogLevel, metricsStore?: MetricsStore, version?: string): AppHandle {
  let config: AppConfig = initConfig;
  const logger = createLogger(logLevel);
  const app = new Hono();
  const sessionIdleTtlMs = initConfig.server?.sessionIdleTtlMs ?? 600_000;
  // Collect the minimum stale threshold across all providers (pool is shared)
  const providerStaleMs = [...(initConfig.providers?.values() ?? [])]
    .map(p => p._staleAgentThresholdMs)
    .filter((v): v is number => v != null);
  const staleThresholdMs = providerStaleMs.length > 0 ? Math.min(...providerStaleMs) : undefined;
  const sessionPool = new SessionAgentPool(sessionIdleTtlMs, staleThresholdMs);

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

  // OpenAI-compatible models list endpoint
  app.get("/v1/models", (c) => {
    const models = [...config.modelRouting.entries()].map(([modelId, entries]) => ({
      id: modelId,
      object: "model",
      created: 0,
      owned_by: entries[0]?.provider ?? "unknown",
    }));
    return c.json({ object: "list", data: models });
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

    // Smart routing: classify request by content, override tier if patterns match
    let overrideTier: number | undefined;
    if (config.smartRouting?.enabled) {
      const lastMessage = extractLastUserMessage(body as Record<string, unknown>);
      if (lastMessage) {
        const classified = classifyTier(lastMessage, config.smartRouting);
        if (classified !== null) {
          overrideTier = classified;
          logger.info("Smart routing classified", {
            requestId,
            model,
            classifiedTier: classified,
            messageLength: lastMessage.length,
          });
        }
      }
      // Record classification metrics
      if (metricsStore) {
        if (overrideTier === 1) metricsStore.recordSmartTier("tier1");
        else if (overrideTier === 2) metricsStore.recordSmartTier("tier2");
        else metricsStore.recordSmartTier("passthrough");
      }
    }

    const ctx = resolveRequest(model, requestId, config, rawBody, overrideTier);
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

    // Extract session name (human-readable label from ANTHROPIC_CUSTOM_HEADERS)
    const sessionName = c.req.header("x-session-name");
    if (sessionId && sessionName) sessionPool.setName(sessionId, sessionName);

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
    const conc = resolveConcurrency(ctx.model, ctx.tier, ctx.providerChain[0]?.provider, config.providerConcurrency, config.modelConcurrency, config.tierConcurrency);
    const sem = conc ? getSemaphore(conc.key, conc.config.max_inflight) : null;
    const acquired = sem ? await sem.acquire(conc!.config.queueTimeoutMs) : true;
    if (!acquired) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: `Concurrency limit reached for "${conc!.key}" (${conc!.config.max_inflight} inflight). Retry after queue timeout.`,
          },
        }),
        {
          status: 503,
          headers: {
            "content-type": "application/json",
            "retry-after": String(Math.ceil(conc!.config.queueTimeoutMs / 1000)),
          },
        },
      );
    }
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
      if (sem) sem.release();
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

    // PURE PASSTHROUGH — zero modification to the upstream stream bytes.
    // The createMetricsTransform is connected via tee() so it never touches
    // the client-bound bytes, avoiding the SSE corruption that motivated the
    // pure-passthrough change in commit 25a2287.
    let responseBody: ReadableStream<Uint8Array> | null = response.body;
    if (response.status >= 200 && response.status < 300) {
      // Tee the stream: branch 1 goes untouched to the client, branch 2 feeds
      // the metrics extractor (createMetricsTransform) for token/latency tracking.
      if (responseBody instanceof ReadableStream && metricsStore) {
        const targetProvider = result.actualProvider || (ctx.providerChain.length > 0 ? ctx.providerChain[0].provider : successfulProvider);
        const [clientStream, metricsStream] = responseBody.tee();
        const metricsTransform = createMetricsTransform(
          ctx, successfulProvider, targetProvider, metricsStore, config,
          response.status, response.headers.get("content-type") || "",
        );
        // Drain the metrics branch into a sink that discards output.
        // The transform's flush() calls recordMetrics() when the stream ends.
        metricsStream.pipeThrough(metricsTransform).pipeTo(new WritableStream({
          write() {},
          close() {},
          abort() {},
        }));
        responseBody = clientStream;
      }
      const latencyMs = Date.now() - ctx.startTime;
      setImmediate(() => {
        // For streaming responses, do NOT transition to "complete" here.
        // The proxy's safeClose() handles stream completion when passThrough ends.
        // Premature "complete" blocks the data handler (proxy.ts passThrough.on("data"))
        // which drops all chunks when ctx._streamState === "complete".
        // Only transition for non-streaming responses (no ReadableStream body).
        const isStreaming = response.body instanceof ReadableStream;
        if (!isStreaming) {
          ctx._streamState = transitionStreamState(ctx, "complete", ctx.requestId);
        }
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

    // Add request ID and provider to response (responses from fetch have immutable headers, so create new)
    const newHeaders = new Headers(response.headers);
    newHeaders.set("x-request-id", requestId);
    const resolvedProvider = result.actualProvider || successfulProvider;
    if (resolvedProvider) {
      newHeaders.set("x-modelweaver-provider", resolvedProvider);
    }
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
    const outTok = ctx._finalOutputTokens ?? 0;
    const inTok = ctx._finalInputTokens ?? 0;
    const ttfbMs = ctx._streamStartTime ? ctx._streamStartTime - ctx.startTime : undefined;
    const streamMs = ttfbMs != null ? latency - ttfbMs : undefined;
    const tokPerSec = outTok > 0 && streamMs != null && streamMs > 0 ? Math.round(outTok / (streamMs / 1000)) : undefined;
    logger.info("Request completed", {
      requestId,
      model,
      tier: ctx.tier,
      status: finalResponse.status,
      latencyMs: latency,
      ...(resolvedProvider ? { provider: resolvedProvider } : {}),
      ...(outTok > 0 ? { outputTokens: outTok } : {}),
      ...(inTok > 0 ? { inputTokens: inTok } : {}),
      ...(ttfbMs != null ? { ttfbMs } : {}),
      ...(tokPerSec != null ? { tokPerSec } : {}),
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
      // Close all old per-model agents
      const closePromises: Promise<void>[] = [];
      for (const provider of config.providers.values()) {
        closePromises.push(closeAllAgents(provider));
      }
      await Promise.all(closePromises);

      // New providers start with empty _agents Maps — agents are lazy-created
      config = newConfig;
      activeProbeManager.updateProviders(newConfig.providers);
      clearRoutingCache();
      clearHedgeStats();
      resetSemaphores();

      // Update session pool thresholds from new config
      const newIdleTtl = newConfig.server?.sessionIdleTtlMs ?? 600_000;
      const newProviderStaleMs = [...(newConfig.providers?.values() ?? [])]
        .map(p => p._staleAgentThresholdMs)
        .filter((v): v is number => v != null);
      const newStaleMs = newProviderStaleMs.length > 0 ? Math.min(...newProviderStaleMs) : DEFAULT_STALE_AGENT_THRESHOLD_MS;
      sessionPool.updateConfig(newIdleTtl, newStaleMs);
    },
    closeSessionPool: async () => {
      await sessionPool.destroy();
    },
    getSessionPoolStats: () => sessionPool.getStats(),
    closeAgents: async () => {
      const closePromises: Promise<void>[] = [];
      for (const provider of config.providers.values()) {
        closePromises.push(closeAllAgents(provider));
      }
      await Promise.all(closePromises);
    },
  };
}
