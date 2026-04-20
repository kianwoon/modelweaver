import { Readable } from "node:stream";
import type { ProviderAdapter, TransformResult } from "./base.js";
import { mapAnthropicToOpenAIChat, mapOpenAIErrorToAnthropic, createOpenAIChatToAnthropicStream } from "./openai-utils.js";

export class OpenAIChatAdapter implements ProviderAdapter {
  readonly format = "openai-chat" as const;

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
    return { body: mapAnthropicToOpenAIChat(body), headers: outHeaders };
  }

  buildUpstreamUrl(baseUrl: string, _incomingPath: string, _model: string): string {
    const base = baseUrl.replace(/\/+$/, "");
    if (base.endsWith("/v1")) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  transformResponse(upstreamBody: NodeJS.ReadableStream): NodeJS.ReadableStream {
    return (upstreamBody as Readable).pipe(createOpenAIChatToAnthropicStream());
  }

  transformError(status: number, body: string): { type: string; message: string } {
    const normalized = JSON.parse(mapOpenAIErrorToAnthropic(status, body));
    return { type: normalized.error.type, message: normalized.error.message };
  }
}
