// src/server.ts
import { Hono } from "hono";
import { resolveRequest } from "./router.js";
import { forwardWithFallback } from "./proxy.js";
import { createLogger, type LogLevel } from "./logger.js";
import type { AppConfig } from "./types.js";
import { randomUUID } from "node:crypto";
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
 * Asynchronously read a response stream and extract token counts for metrics.
 * Reads the entire stream, then regex-matches for input_tokens and output_tokens.
 * Works for both streaming (SSE) and non-streaming (JSON) responses.
 */
function extractTokensAsync(
  body: ReadableStream<Uint8Array>,
  ctx: { requestId: string; model: string; tier: string; startTime: number },
  provider: string,
  targetProvider: string,
  metricsStore: MetricsStore,
  status: number,
): void {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      // Combine all chunks into a single string
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      const text = new TextDecoder().decode(combined);

      // Extract tokens from SSE events only (message_start, message_delta)
      // to avoid matching spurious values in tool_result content blocks
      let inputTokens = 0;
      let outputTokens = 0;

      if (text.startsWith("event:")) {
        // SSE streaming response — parse event types
        const events = text.split("\n\n");
        for (const event of events) {
          const eventLines = event.split("\n");
          const eventType = eventLines.find(l => l.startsWith("event:"));
          const dataLine = eventLines.find(l => l.startsWith("data:"));

          if (!dataLine) continue;

          try {
            const data = JSON.parse(dataLine.slice(5));
            const usage = data.message?.usage ?? data.usage;
            if (!usage) continue;

            // Anthropic format: input_tokens / output_tokens
            // OpenAI-compatible format: prompt_tokens / completion_tokens
            const inp = usage.input_tokens ?? usage.prompt_tokens ?? 0;
            const out = usage.output_tokens ?? usage.completion_tokens ?? 0;

            if (inp > 0) inputTokens = inp;
            if (out > 0) outputTokens = out;

            // Anthropic cache tokens
            inputTokens += (usage.cache_read_input_tokens ?? 0)
              + (usage.cache_creation_input_tokens ?? 0);
          } catch { /* skip malformed event data */ }
        }
      } else {
        // Non-streaming JSON response — support both Anthropic and OpenAI token names
        const inputMatches = [...text.matchAll(/"(?:input_tokens|prompt_tokens)"\s*:\s*(\d+)/g)];
        const cacheReadMatches = [...text.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g)];
        const cacheCreationMatches = [...text.matchAll(/"cache_creation_input_tokens"\s*:\s*(\d+)/g)];
        const outputMatches = [...text.matchAll(/"(?:output_tokens|completion_tokens)"\s*:\s*(\d+)/g)];
        inputTokens = (inputMatches.length > 0 ? parseInt(inputMatches[inputMatches.length - 1][1], 10) : 0)
          + (cacheReadMatches.length > 0 ? parseInt(cacheReadMatches[cacheReadMatches.length - 1][1], 10) : 0)
          + (cacheCreationMatches.length > 0 ? parseInt(cacheCreationMatches[cacheCreationMatches.length - 1][1], 10) : 0);
        outputTokens = outputMatches.length > 0 ? parseInt(outputMatches[outputMatches.length - 1][1], 10) : 0;
      }

      // Skip recording if no tokens found (error responses or edge cases)
      if (inputTokens === 0 && outputTokens === 0) return;

      const latencyMs = Date.now() - ctx.startTime;
      const latencySec = latencyMs / 1000;
      const tokensPerSec = latencySec > 0 ? (inputTokens + outputTokens) / latencySec : 0;

      metricsStore.recordRequest({
        requestId: ctx.requestId,
        model: ctx.model,
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

    // Resolve routing
    const rawBody = JSON.stringify(body);
    const ctx = resolveRequest(model, requestId, config, rawBody);
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
      extractTokensAsync(metricsBody, ctx, successfulProvider, targetProvider, metricsStore, response.status);
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
  app.get("/api/metrics/summary", (c) => {
    if (!metricsStore) return c.json({ error: "Metrics not enabled" }, 503);
    return c.json(metricsStore.getSummary());
  });

  return { app, getConfig: () => config, setConfig: (c) => { config = c; } };
}
