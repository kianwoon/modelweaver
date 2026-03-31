// src/init/screens/shared/types.ts

export interface WizardProvider {
  id: string;  // unique, e.g. "glm"
  baseUrl: string;
  envKey: string;       // e.g. "GLM_API_KEY"
  apiKey: string;       // runtime value, not stored in config.yaml
  timeout: number;
  ttfbTimeout: number;
  authType: 'anthropic' | 'bearer';
  concurrentLimit?: number;
  stallTimeout?: number;
  poolSize?: number;
  circuitBreaker: {
    threshold: number;
    windowSeconds: number;
    cooldown: number;
  };
}

export interface RoutingEntry {
  provider: string;      // provider id
  model: string;        // model name on that provider
  weight?: number;       // only for distribution
}

export interface WizardState {
  providers: Map<string, WizardProvider>;
  models: string[];
  distribution: Map<string, RoutingEntry[]>;
  fallback: Map<string, RoutingEntry[]>;
  server: { port: number; host: string };
}

export type ScreenAction =
  | { type: 'back' }
  | { type: 'quit' }
  | { type: 'save' }
  | { type: 'navigate'; section: ScreenId }
  | { type: 'error'; message: string };

export type ScreenId = 'main' | 'providers' | 'models' | 'distribution' | 'fallback' | 'server';

export function createEmptyState(): WizardState {
  return {
    providers: new Map(),
    models: [],
    distribution: new Map(),
    fallback: new Map(),
    server: { port: 3456, host: 'localhost' },
  };
}
