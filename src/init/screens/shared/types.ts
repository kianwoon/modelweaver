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

export type ConfigTarget = 'global' | 'project';

export interface WizardState {
  configTarget: ConfigTarget;
  providers: Map<string, WizardProvider>;
  models: string[];
  distribution: Map<string, RoutingEntry[]>;
  fallback: Map<string, RoutingEntry[]>;
  server: { port: number; host: string };
  hedging: { speculativeDelay: number; cvThreshold: number; maxHedge: number };
}

export type ScreenAction =
  | { type: 'back' }
  | { type: 'quit' }
  | { type: 'save' }
  | { type: 'navigate'; section: ScreenId }
  | { type: 'error'; message: string };

export type ScreenId = 'main' | 'providers' | 'models' | 'distribution' | 'fallback' | 'server' | 'hedging';

export function createEmptyState(): WizardState {
  return {
    configTarget: 'global',
    providers: new Map(),
    models: [],
    distribution: new Map(),
    fallback: new Map(),
    server: { port: 3456, host: 'localhost' },
    hedging: { speculativeDelay: 1000, cvThreshold: 0.5, maxHedge: 4 },
  };
}
