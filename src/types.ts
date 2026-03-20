export interface ModelLimits {
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  timeout: number;
  authType?: "anthropic" | "bearer";
  modelLimits?: ModelLimits;
}

export interface RoutingEntry {
  provider: string;
  model?: string;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface AppConfig {
  server: ServerConfig;
  providers: Map<string, ProviderConfig>;
  routing: Map<string, RoutingEntry[]>;
  tierPatterns: Map<string, string[]>;
  modelRouting: Map<string, RoutingEntry[]>;
}

export interface RequestContext {
  requestId: string;
  model: string;
  actualModel?: string;
  tier: string;
  providerChain: RoutingEntry[];
  startTime: number;
  rawBody: string;
}

export interface RequestMetrics {
  requestId: string;
  model: string;
  actualModel?: string;
  tier: string;
  provider: string;
  targetProvider: string;
  status: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  tokensPerSec: number;
  timestamp: number;
}

export interface MetricsSummary {
  uptimeSeconds: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgTokensPerSec: number;
  activeModels: { model: string; actualModel?: string; count: number; lastSeen: number }[];
  providerDistribution: { provider: string; count: number }[];
  recentRequests: RequestMetrics[];
}
