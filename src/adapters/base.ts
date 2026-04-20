export type ApiFormat = "anthropic" | "openai-chat" | "openai-responses";

export interface TransformResult {
  body: string;
  headers: Record<string, string>;
}

export interface ProviderAdapter {
  readonly format: ApiFormat;

  transformRequest(body: string, headers: Record<string, string>): TransformResult;

  buildUpstreamUrl(baseUrl: string, incomingPath: string, model: string): string;

  transformResponse(upstreamBody: NodeJS.ReadableStream): NodeJS.ReadableStream;

  transformError(status: number, body: string): { type: string; message: string };
}
