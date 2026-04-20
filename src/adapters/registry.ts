import type { ApiFormat, ProviderAdapter } from "./base.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAIChatAdapter } from "./openai-chat.js";
import { OpenAIResponsesAdapter } from "./openai-responses.js";

const cache = new Map<string, ProviderAdapter>();

export function getAdapter(format?: string): ProviderAdapter {
  const key = format ?? "anthropic";
  let adapter = cache.get(key);
  if (adapter) return adapter;

  switch (key as ApiFormat) {
    case "openai-chat":
      adapter = new OpenAIChatAdapter();
      break;
    case "openai-responses":
      adapter = new OpenAIResponsesAdapter();
      break;
    default:
      adapter = new AnthropicAdapter();
  }

  cache.set(key, adapter);
  return adapter;
}
