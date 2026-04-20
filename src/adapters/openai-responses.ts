import type { ProviderAdapter } from "./base.js";

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly format = "openai-responses" as const;

  transformRequest(body: string, headers: Record<string, string>) {
    return { body, headers };
  }

  buildUpstreamUrl(baseUrl: string, _incomingPath: string, _model: string) {
    return `${baseUrl}/v1/responses`;
  }

  transformResponse(stream: NodeJS.ReadableStream) {
    return stream;
  }

  transformError(status: number, body: string) {
    return { type: "error", message: body };
  }
}
