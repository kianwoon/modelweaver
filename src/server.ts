// src/server.ts
import { Hono } from "hono";
import { resolveRequest } from "./router.js";
import { forwardWithFallback } from "./proxy.js";
import { createLogger, type LogLevel } from "./logger.js";
import type { AppConfig, RequestContext } from "./types.js";
import { randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
import type { MetricsStore } from "./metrics.js";

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
 * Asynchronously read a response stream and extract token counts for metrics.
 * Uses a streaming line-by-line SSE parser — does NOT buffer the entire response.
 * For SSE responses, extracts token counts from usage events incrementally.
 * For non-streaming JSON responses, accumulates a small buffer to parse at the end.
 */
function extractTokensAsync(
  body: ReadableStream<Uint8Array>,
  ctx: { requestId: string; model: string; actualModel?: string; tier: string; startTime: number },
  provider: string,
  targetProvider: string,
  metricsStore: MetricsStore,
  status: number,
  contentType: string,
): void {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  (async () => {
    try {
      // Detect SSE vs JSON by checking the first chunk
      const first = await reader.read();
      if (first.done) return;

      const isSSE = contentType.includes("text/event-stream")
        || decoder.decode(first.value, { stream: true }).startsWith("event:");

      if (isSSE) {
        // Streaming SSE: parse line-by-line, only track usage fields
        let inputTokens = 0;
        let outputTokens = 0;
        // Prepend first chunk to the line buffer
        let lineBuf = decoder.decode(first.value, { stream: true });

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Process any remaining buffer
            if (lineBuf.trim()) processSSEChunk(lineBuf);
            break;
          }
          lineBuf += decoder.decode(value, { stream: true });
          // Process complete lines (split, keep incomplete last segment)
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop()!;
          processSSEChunk(lines.join("\n"));
        }

        function processSSEChunk(chunk: string): void {
          for (const event of chunk.split("\n\n")) {
            const dataLine = event.split("\n").find(l => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const data = JSON.parse(dataLine.slice(5)) as Record<string, unknown>;
              const usage = parseUsageFromData(data);
              if (usage.inputTokens > inputTokens) inputTokens = usage.inputTokens;
              if (usage.outputTokens > outputTokens) outputTokens = usage.outputTokens;
            } catch { /* skip malformed */ }
          }
        }

        if (inputTokens === 0 && outputTokens === 0) return;
        recordMetrics(inputTokens, outputTokens);
      } else {
        // Non-streaming JSON: streaming regex scan with bounded sliding window.
        // Only keeps ~4KB in memory -- no O(n^2) buffer accumulation.
        const WINDOW_SIZE = 4096;
        let inputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;
        let outputTokens = 0;
        let windowBuf = decoder.decode(first.value, { stream: true });
        scanWindow(windowBuf);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          windowBuf += decoder.decode(value, { stream: true });
          if (windowBuf.length > WINDOW_SIZE) {
            windowBuf = windowBuf.slice(-WINDOW_SIZE);
          }
          scanWindow(windowBuf);
        }
        // Final scan to catch any pattern at the tail end
        scanWindow(windowBuf);

        function scanWindow(text: string): void {
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
        }

        const totalInput = inputTokens + cacheReadTokens + cacheCreationTokens;
        if (totalInput === 0 && outputTokens === 0) return;
        recordMetrics(totalInput, outputTokens);
      }

      function recordMetrics(inputTokens: number, outputTokens: number): void {
        const latencyMs = Date.now() - ctx.startTime;
        const latencySec = latencyMs / 1000;
        const tokensPerSec = latencySec > 0 ? (inputTokens + outputTokens) / latencySec : 0;

        metricsStore.recordRequest({
          requestId: ctx.requestId,
          model: ctx.model,
          actualModel: ctx.actualModel || ctx.model,
          tier: ctx.tier,
          provider,
          targetProvider,
          status,
          inputTokens,
          outputTokens,
          latencyMs,
          tokensPerSec: Math.round(tokensPerSec * 10) / 10,
          timestamp: Date.now(),
        });
      }
    } catch {
      // Metrics extraction errors must not affect the response stream
    }
  })();
}

export interface AppHandle {
  app: Hono;
  getConfig: () => AppConfig;
  setConfig: (config: AppConfig) => void;
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

    // Parse model from request body
    let body: { model?: string };
    try {
      body = await c.req.json();
    } catch {
      return anthropicError("invalid_request_error", "Invalid JSON body", requestId);
    }

    const model = body.model;
    if (!model) {
      return anthropicError("invalid_request_error", "Missing 'model' field in request body", requestId);
    }

    // Resolve routing — rawBody is already serialized; attach parsed body to avoid double-parse in proxy
    const rawBody = JSON.stringify(body);
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

    // Forward with fallback chain
    let successfulProvider = "unknown";
    const response = await forwardWithFallback(
      config.providers,
      ctx.providerChain,
      ctx,
      c.req.raw,
      (provider, index) => {
        logger.info("Attempting provider", { requestId, provider, index, tier: ctx.tier });
        successfulProvider = provider;
      }
    );

    // Extract tokens via tee() for successful responses
    let responseBody = response.body;
    if (response.body && response.status >= 200 && response.status < 300 && metricsStore) {
      const [clientBody, metricsBody] = response.body.tee();
      const targetProvider = ctx.providerChain.length > 0 ? ctx.providerChain[0].provider : successfulProvider;
      extractTokensAsync(metricsBody, ctx, successfulProvider, targetProvider, metricsStore, response.status, response.headers.get("content-type") || "");
      responseBody = clientBody;
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

  return { app, getConfig: () => config, setConfig: (c) => { config = c; } };
}
