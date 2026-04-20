import { Readable } from "node:stream";
import type { ProviderAdapter, TransformResult } from "./base.js";
import {
  mapAnthropicToOpenAIResponses,
  mapOpenAIErrorToAnthropic,
  createOpenAIResponsesToAnthropicStream,
} from "./openai-utils.js";

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly format = "openai-responses" as const;

  transformRequest(body: string, headers: Record<string, string>): TransformResult {
    const outHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (key === "anthropic-version" || key === "anthropic-beta") continue;
      if (key === "x-api-key") {
        outHeaders["authorization"] = `Bearer ${value}`;
        continue;
      }
      outHeaders[key] = value;
    }
    return { body: mapAnthropicToOpenAIResponses(body), headers: outHeaders };
  }

  buildUpstreamUrl(baseUrl: string, _incomingPath: string, _model: string): string {
    const base = baseUrl.replace(/\/+$/, "");
    if (base.endsWith("/v1")) return `${base}/responses`;
    return `${base}/v1/responses`;
  }

  transformResponse(upstreamBody: NodeJS.ReadableStream): NodeJS.ReadableStream {
    return (upstreamBody as Readable).pipe(createOpenAIResponsesToAnthropicStream());
  }

  transformError(status: number, body: string): { type: string; message: string } {
    const normalized = JSON.parse(mapOpenAIErrorToAnthropic(status, body));
    return { type: normalized.error.type, message: normalized.error.message };
  }
}
