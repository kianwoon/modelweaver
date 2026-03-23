// src/server.ts
import { Hono } from "hono";
import { resolveRequest, clearRoutingCache } from "./router.js";
import { forwardWithFallback } from "./proxy.js";
import { createLogger, type LogLevel } from "./logger.js";
import type { AppConfig, ProviderConfig, RequestContext } from "./types.js";
import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
import type { MetricsStore } from "./metrics.js";
import { broadcastStreamEvent } from "./ws.js";
import type { StreamEvent } from "./types.js";

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
function parseUsageFromData(data: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const usage = (data.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined
    ?? data.usage as Record<string, unknown> | undefined;
  if (!usage) return { inputTokens: 0, outputTokens: 0 };

  const inp = (usage.input_tokens as number | undefined) ?? (usage.prompt_tokens as number | undefined) ?? 0;
  const out = (usage.output_tokens as number | undefined) ?? (usage.completion_tokens as number | undefined) ?? 0;
  const cacheRead = (usage.cache_read_input_tokens as number | undefined) ?? 0;
  const cacheCreation = (usage.cache_creation_input_tokens as number | undefined) ?? 0;

  return { inputTokens: inp + cacheRead + cacheCreation, outputTokens: out };
}

/**
 * Creates a TransformStream that forwards chunks unchanged while extracting
 * token counts for metrics inline (no tee() or separate reader needed).
 * For SSE responses, extracts token counts from usage events incrementally.
 * For non-streaming JSON responses, uses a bounded sliding-window regex scan.
 */
function createMetricsTransform(
  ctx: { requestId: string; model: string; actualModel?: string; tier: string; startTime: number; fallbackMode?: "sequential" | "race" },
  provider: string,
  targetProvider: string,
  metricsStore: MetricsStore,
  status: number,
  contentType: string,
): TransformStream<Uint8Array, Uint8Array> {
  const td = new TextDecoder();

  // --- SSE state ---
  const tokens = { input: 0, output: 0 };
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
      try {
        const data = JSON.parse(dataLine.slice(5)) as Record<string, unknown>;

        // Extract usage (token counts)
        if (dataLine.includes('"usage"')) {
          const usage = parseUsageFromData(data);
          if (usage.inputTokens > tokens.input) tokens.input = usage.inputTokens;
          if (usage.outputTokens > tokens.output) tokens.output = usage.outputTokens;
        }

        // Extract text content for preview
        // Anthropic format: content_block_delta with delta.text
        const delta = data.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.text === "string") {
          responsePreview += delta.text;
          if (responsePreview.length > PREVIEW_MAX) {
            responsePreview = responsePreview.slice(-PREVIEW_MAX);
          }
        }
        // OpenAI format: choices[0].delta.content
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
      } catch { /* skip malformed */ }
    }
  };

  const scanWindow = (text: string) => {
    const inputMatches = [...text.matchAll(/"(?:input_tokens|prompt_tokens)"\s*:\s*(\d+)/g)];
    const cacheReadMatches = [...text.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g)];
    const cacheCreationMatches = [...text.matchAll(/"cache_creation_input_tokens"\s*:\s*(\d+)/g)];
    const outputMatches = [...text.matchAll(/"(?:output_tokens|completion_tokens)"\s*:\s*(\d+)/g)];

    if (inputMatches.length > 0) {
      const val = parseInt(inputMatches[inputMatches.length - 1][1], 10);
      if (val > inputTokens) inputTokens = val;
    }
    if (cacheReadMatches.length > 0) {
      const val = parseInt(cacheReadMatches[cacheReadMatches.length - 1][1], 10);
      if (val > cacheReadTokens) cacheReadTokens = val;
    }
    if (cacheCreationMatches.length > 0) {
      const val = parseInt(cacheCreationMatches[cacheCreationMatches.length - 1][1], 10);
      if (val > cacheCreationTokens) cacheCreationTokens = val;
    }
    if (outputMatches.length > 0) {
      const val = parseInt(outputMatches[outputMatches.length - 1][1], 10);
      if (val > outputTokens) outputTokens = val;
    }

    // Extract text content for preview from JSON responses
    // Anthropic format: "content":[{"type":"text","text":"..."}]
    const anthContent = [...text.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
    if (anthContent.length > 0) {
      const lastText = anthContent[anthContent.length - 1][1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      responsePreview += lastText;
      if (responsePreview.length > PREVIEW_MAX) {
        responsePreview = responsePreview.slice(-PREVIEW_MAX);
      }
    }
  };

  const recordMetrics = (inp: number, out: number) => {
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
      });

      // Broadcast completion event
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
        setImmediate(() => {
          broadcastStreamEvent({
            requestId: ctx.requestId,
            model: ctx.model,
            tier: ctx.tier,
            state: "streaming",
            outputTokens: tokens.output,
            timestamp: now,
            preview: responsePreview,
          });
        });
      }

      if (isFinal) {
        recordMetrics(tokens.input, tokens.output);
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
        setImmediate(() => {
          broadcastStreamEvent({
            requestId: ctx.requestId,
            model: ctx.model,
            tier: ctx.tier,
            state: "streaming",
            outputTokens,
            timestamp: nowJson,
            preview: responsePreview,
          });
        });
      }

      if (isFinal) {
        const totalInput = inputTokens + cacheReadTokens + cacheCreationTokens;
        recordMetrics(totalInput, outputTokens);
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
  setConfig: (config: AppConfig) => void;
}

function agentKey(provider: ProviderConfig): string {
  const origin = provider._cachedOrigin;
  const size = provider.poolSize ?? 10;
  return `${origin ?? "unknown"}:${size}`;
}

export function createApp(initConfig: AppConfig, logLevel: LogLevel, metricsStore?: MetricsStore): AppHandle {
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

  // CORS for GUI (Tauri WebView has origin tauri://localhost)
  app.use("/api/*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "*");
    await next();
  });
  // Handle CORS preflight for API routes only (GUI needs CORS; proxy endpoint does not)
  app.options("/api/*", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version, x-api-key");
    return c.body("", 200);
  });

  app.post("/v1/messages", async (c) => {
    const requestId = randomUUID();

    // Read raw body once, then parse — avoids double serialization
    let body: { model?: string };
    let rawBody: string;
    try {
      rawBody = await c.req.text();
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
    let response: Response;
    try {
      response = await forwardWithFallback(
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
        logger
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
      const targetProvider = ctx.providerChain.length > 0 ? ctx.providerChain[0].provider : successfulProvider;
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

  return {
    app,
    getConfig: () => config,
    setConfig: (newConfig: AppConfig) => {
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
      for (const [key, agent] of oldAgents) {
        if (!reusedKeys.has(key)) {
          agent.close();
        }
      }

      config = newConfig;
      clearRoutingCache();
    },
  };
}
