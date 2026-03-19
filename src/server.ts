// src/server.ts
import { Hono } from "hono";
import { resolveRequest } from "./router.js";
import { forwardWithFallback } from "./proxy.js";
import { createLogger, type LogLevel } from "./logger.js";
import type { AppConfig } from "./types.js";
import { randomUUID } from "node:crypto";

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

export interface AppHandle {
  app: Hono;
  getConfig: () => AppConfig;
  setConfig: (config: AppConfig) => void;
}

export function createApp(initConfig: AppConfig, logLevel: LogLevel): AppHandle {
  let config: AppConfig = initConfig;
  const logger = createLogger(logLevel);
  const app = new Hono();

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
    const response = await forwardWithFallback(
      config.providers,
      ctx.providerChain,
      ctx,
      c.req.raw,
      (provider, index) => {
        logger.info("Attempting provider", { requestId, provider, index, tier: ctx.tier });
      }
    );

    // Add request ID to response (responses from fetch have immutable headers, so create new)
    const newHeaders = new Headers(response.headers);
    newHeaders.set("x-request-id", requestId);
    const finalResponse = new Response(response.body, {
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

  return { app, getConfig: () => config, setConfig: (c) => { config = c; } };
}
