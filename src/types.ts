import type { CircuitBreaker } from "./circuit-breaker.js";

export interface ModelLimits {
  maxOutputTokens: number;
}

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  timeout: number;
  ttfbTimeout?: number;
  stallTimeout?: number;
  authType?: "anthropic" | "bearer";
  modelLimits?: ModelLimits;
  concurrentLimit?: number;

  /** Runtime-only cached fields — not serialized to config */
  _cachedHost?: string;
  _cachedOrigin?: string;
  _cachedPathname?: string;
  _agent?: import("undici").Agent;
  _circuitBreaker?: CircuitBreaker;
  poolSize?: number;
}

export interface RoutingEntry {
  provider: string;
  model?: string;
  weight?: number;
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
  fallbackMode?: "sequential" | "race";
  hasDistribution?: boolean;
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
  fallbackMode?: "sequential" | "race";
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface MetricsSummary {
  uptimeSeconds: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgTokensPerSec: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  avgCacheHitRate: number;
  activeModels: { model: string; actualModel?: string; count: number; lastSeen: number }[];
  providerDistribution: { provider: string; count: number }[];
  recentRequests: RequestMetrics[];
}

export type StreamState = "start" | "ttfb" | "streaming" | "fallback" | "complete" | "error";

export interface StreamEvent {
  requestId: string;
  model: string;
  tier: string;
  state: StreamState;
  timestamp: number;
  provider?: string;
  outputTokens?: number;
  from?: string;
  to?: string;
  status?: number;
  latencyMs?: number;
  inputTokens?: number;
  tokensPerSec?: number;
  message?: string;
  preview?: string;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheHitRate?: number;
  contextPercent?: number;
  contextWindowSize?: number;
  headerSize?: number;
}
