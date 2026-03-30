// src/server.ts
import { Hono } from "hono";
import { resolveRequest, clearRoutingCache } from "./router.js";
import { forwardWithFallback, type FallbackResult, recordProviderLatency } from "./proxy.js";
import { createLogger, type LogLevel } from "./logger.js";
import type { AppConfig, ProviderConfig, RequestContext } from "./types.js";
import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

import type { MetricsStore } from "./metrics.js";
import { latencyTracker, inFlightCounter, getHedgeStats, clearHedgeStats } from "./hedging.js";
import { broadcastStreamEvent } from "./ws.js";

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
 * Creates a TransformStream that forwards chunks unchanged while extracting
 * token counts for metrics inline (no tee() or separate reader needed).
 * For SSE responses, extracts token counts from usage events incrementally.
 * For non-streaming JSON responses, uses a bounded sliding-window regex scan.
 */
function createMetricsTransform(
  ctx: { requestId: string; model: string; actualModel?: string; tier: string; startTime: number; fallbackMode?: "sequential" | "race"; sessionId?: string },
  provider: string,
  targetProvider: string,
  metricsStore: MetricsStore,
  status: number,
  contentType: string,
): TransformStream<Uint8Array, Uint8Array> {
  const td = new TextDecoder();

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
      } catch { /* skip malformed */ }
    }
  };

  const scanWindow = (text: string) => {
    // Fast bailout: most chunks don't contain usage data
    const hasUsage = text.includes('"usage"');

    // Single combined regex pass for all token fields
    const TOKEN_RE = /"(input_tokens|prompt_tokens|cache_read_input_tokens|cache_creation_input_tokens|output_tokens|completion_tokens)"\s*:\s*(\d+)/g;
    if (hasUsage) {
      let m: RegExpExecArray | null;
      while ((m = TOKEN_RE.exec(text)) !== null) {
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
      const lastText = JSON.parse(`"${rawValue}"`);
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

      // Broadcast completion event
      const contextWindow = getContextWindow(ctx.actualModel || ctx.model);
      setImmediate(() => {
        broadcastStreamEvent({
          requestId: ctx.requestId,
          model: ctx.model,
          tier: ctx.tier,
          state: "complete",
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

  const processChunk = (decoded: string, isFinal: boolean) => {
    if (isSSE === null) {
      // First chunk — detect format
      isSSE = contentType.includes("text/event-stream") || decoded.startsWith("event:");
    }

    if (isSSE) {
      lineBuf += decoded;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop()!;

      for (const line of lines) {
        if (line === "") {
          if (eventBuf) {
            drainEvents(eventBuf);
            eventBuf = "";
          }
        } else {
          eventBuf += (eventBuf ? "\n" : "") + line;
        }
      }

      if (isFinal && eventBuf.trim()) drainEvents(eventBuf);

      // Emit streaming progress (throttled ~4 Hz)
      const now = Date.now();
      if (firstChunk || now - lastStreamEmit >= STREAM_THROTTLE_MS) {
        lastStreamEmit = now;
        firstChunk = false;
        const contextWindow = getContextWindow(ctx.actualModel || ctx.model);
        setImmediate(() => {
          broadcastStreamEvent({
            requestId: ctx.requestId,
            model: ctx.model,
            tier: ctx.tier,
            state: "streaming",
            outputTokens: tokens.output,
            timestamp: now,
            preview: responsePreview,
            cacheHitRate: computeCacheHitRate(tokens.cacheRead, tokens.cacheCreation, tokens.input),
            contextPercent: computeContextPercent(tokens.input, tokens.cacheRead, tokens.cacheCreation, tokens.output, contextWindow),
            contextWindowSize: contextWindow || undefined,
          });
        });
      }

      if (isFinal) {
        recordMetrics(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreation);
      }
    } else {
      windowBuf += decoded;
      if (windowBuf.length > WINDOW_SIZE) {
        windowBuf = windowBuf.slice(-WINDOW_SIZE);
      }
      scanWindow(windowBuf);

      // Emit streaming progress (throttled ~4 Hz)
      const nowJson = Date.now();
      if (firstChunk || nowJson - lastStreamEmit >= STREAM_THROTTLE_MS) {
        lastStreamEmit = nowJson;
        firstChunk = false;
        const contextWindow = getContextWindow(ctx.actualModel || ctx.model);
        setImmediate(() => {
          broadcastStreamEvent({
            requestId: ctx.requestId,
            model: ctx.model,
            tier: ctx.tier,
            state: "streaming",
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
      controller.enqueue(chunk);
      processChunk(td.decode(chunk, { stream: true }), false);
    },
    flush() {
      processChunk("", true);
    },
  });
}

export interface AppHandle {
  app: Hono;
  getConfig: () => AppConfig;
  setConfig: (config: AppConfig) => Promise<void>;
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
    const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
    let body: { model?: string };
    let rawBody: string;
    try {
      rawBody = await c.req.text();
      if (rawBody.length > MAX_BODY_SIZE) {
        return anthropicError("invalid_request_error", `Request body exceeds maximum size of ${MAX_BODY_SIZE / 1024 / 1024}MB`, requestId);
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

    logger.info("Routing request", {
      requestId,
      model,
      tier: ctx.tier,
      providers: ctx.providerChain.map((e) => e.provider),
    });

    // Broadcast stream start event
    broadcastStreamEvent({
      requestId,
      model,
      tier: ctx.tier,
      state: "start",
      provider: ctx.providerChain[0]?.provider ?? "unknown",
      timestamp: Date.now(),
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
          // Only capture first attempted provider; accurate winner tracking requires
          // an onSuccess callback in proxy.ts (handled separately).
          if (!successfulProvider) successfulProvider = provider;
        },
        logger,
        config.hedging,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("Forward failed", { requestId, error: errMsg });
      setImmediate(() => {
        broadcastStreamEvent({
          requestId,
          model,
          tier: ctx.tier,
          state: "error",
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
        broadcastStreamEvent({
          requestId,
          model,
          tier: ctx.tier,
          state: "ttfb",
          status: response.status,
          headerSize,
          timestamp: Date.now(),
        });
      });
    }

    // Broadcast error event for non-2xx responses
    if (response.status >= 400) {
      setImmediate(() => {
        broadcastStreamEvent({
          requestId,
          model,
          tier: ctx.tier,
          state: "error",
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
      const transform = createMetricsTransform(ctx, successfulProvider, targetProvider, metricsStore, response.status, response.headers.get("content-type") || "");
      responseBody = response.body.pipeThrough(transform) as typeof responseBody;
    }

    // Add request ID to response (responses from fetch have immutable headers, so create new)
    const newHeaders = new Headers(response.headers);
    newHeaders.set("x-request-id", requestId);
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

  let inFlightCount = 0;

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

      config = newConfig;
      clearRoutingCache();
      clearHedgeStats();
      await Promise.all(closePromises);
    },
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
