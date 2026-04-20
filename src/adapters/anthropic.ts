import type { ProviderAdapter, TransformResult } from "./base.js";

export class AnthropicAdapter implements ProviderAdapter {
  readonly format = "anthropic" as const;

  transformRequest(body: string, headers: Record<string, string>): TransformResult {
    return { body, headers };
  }

  buildUpstreamUrl(baseUrl: string, incomingPath: string, _model: string): string {
    const url = new URL(incomingPath, baseUrl);
    return url.toString();
  }

  transformResponse(upstreamBody: NodeJS.ReadableStream): NodeJS.ReadableStream {
    return upstreamBody;
  }

  transformError(_status: number, body: string): { type: string; message: string } {
    try {
      const parsed = JSON.parse(body);
      const err = parsed.error ?? parsed;
      return { type: err.type ?? "unknown_error", message: err.message ?? "Unknown error" };
    } catch {
      return { type: "unknown_error", message: body };
    }
  }
}
