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

export interface HedgingConfig {
  /** Delay (ms) before starting backup providers in staggered race */
  speculativeDelay: number;
  /** Coefficient of variation threshold — hedging activates when CV >= this */
  cvThreshold: number;
  /** Maximum number of hedged copies per request */
  maxHedge: number;
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
  hedging?: HedgingConfig;
}

export interface RequestContext {
  requestId: string;
  model: string;
  actualModel?: string;
  tier: string;
  providerChain: RoutingEntry[];
  startTime: number;
  rawBody: string;
  sessionId?: string;
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
  sessionId?: string;
}

export interface ModelPerformanceStats {
  model: string;
  count: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
  avgTokensPerSec: number;
  avgCacheHitRate: number;
  errorCount: number;
  providerBreakdown: {
    provider: string;
    count: number;
    avgLatencyMs: number;
    errorCount: number;
  }[];
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
  modelStats: ModelPerformanceStats[];
  sessionStats: { sessionId: string; requestCount: number; lastSeen: number }[];
  providerErrors: { [provider: string]: { total: number; errors: { [status: number]: number } } };
}

export interface MetricsSummaryDelta {
  totalRequests?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  avgTokensPerSec?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  avgCacheHitRate?: number;
  uptimeSeconds?: number;
  activeModels?: MetricsSummary["activeModels"];
  providerDistribution?: MetricsSummary["providerDistribution"];
  modelStats?: ModelPerformanceStats[];
  recentRequests?: RequestMetrics[];  // Only new entries since last delta
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
