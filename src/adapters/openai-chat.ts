import type { ProviderAdapter } from "./base.js";

export class OpenAIChatAdapter implements ProviderAdapter {
  readonly format = "openai-chat" as const;

  transformRequest(body: string, headers: Record<string, string>) {
    return { body, headers };
  }

  buildUpstreamUrl(baseUrl: string, _incomingPath: string, _model: string) {
    return `${baseUrl}/v1/chat/completions`;
  }

  transformResponse(stream: NodeJS.ReadableStream) {
    return stream;
  }

  transformError(status: number, body: string) {
    return { type: "error", message: body };
  }
}
