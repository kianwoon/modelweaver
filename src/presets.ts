/**
 * Provider preset templates for the ModelWeaver init wizard.
 */

export interface ProviderPreset {
  /** Machine name for config keys (e.g., "anthropic") */
  id: string;
  /** Display name (e.g., "Anthropic") */
  name: string;
  /** API base URL */
  baseUrl: string;
  /** Suggested env var name (e.g., "ANTHROPIC_API_KEY") */
  envKey: string;
  /** How to send the API key */
  authType: "bearer" | "anthropic";
  models: {
    sonnet: string;
    opus: string;
    haiku: string;
  };
}

const PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
    authType: "anthropic",
    models: {
      sonnet: "claude-sonnet-4-20250514",
      opus: "claude-opus-4-20250514",
      haiku: "claude-haiku-4-5-20251001",
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    envKey: "OPENROUTER_API_KEY",
    authType: "bearer",
    models: {
      sonnet: "anthropic/claude-sonnet-4",
      opus: "anthropic/claude-opus-4",
      haiku: "anthropic/claude-haiku-4",
    },
  },
  {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz",
    envKey: "TOGETHER_API_KEY",
    authType: "bearer",
    models: {
      sonnet: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      opus: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      haiku: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    },
  },
  {
    id: "vertex",
    name: "Google Vertex",
    baseUrl: "https://aiplatform.googleapis.com",
    envKey: "GOOGLE_APPLICATION_CREDENTIALS",
    authType: "bearer",
    models: {
      sonnet: "claude-sonnet-4@vertex",
      opus: "claude-opus-4@vertex",
      haiku: "claude-haiku-4@vertex",
    },
  },
  {
    id: "fireworks",
    name: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envKey: "FIREWORKS_API_KEY",
    authType: "bearer",
    models: {
      sonnet: "accounts/fireworks/models/claude-sonnet-4",
      opus: "accounts/fireworks/models/claude-opus-4",
      haiku: "accounts/fireworks/models/claude-haiku-4",
    },
  },
];

/** Returns all available provider presets. */
export function getPresets(): ProviderPreset[] {
  return PRESETS;
}

/** Returns a single preset by its machine-readable id, or undefined if not found. */
export function getPreset(id: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
