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
  _serverConfig?: ServerConfig;
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
  streamBufferMs?: number;       // 0/unset = disabled, > 0 = time-based flush threshold (ms)
  streamBufferBytes?: number;    // 0/unset = disabled, > 0 = size-based flush threshold (bytes)
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
  /** Tracks current StreamState for transition validation */
  _streamState?: StreamState;
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
  providerErrors: { [provider: string]: { total: number; errors: { [status: number]: number }; lastErrorCode: number | null; lastErrorTime: number | null } };
}

export interface ProviderHealthEntry {
  state: string;
  failures: number;
  lastFailure: number | null;
  lastErrorCode: number | null;
  lastErrorTime: number | null;
  errorCount: number;
  errorBreakdown?: {
    total: number;
    errors: { [status: number]: number };
    lastErrorCode: number | null;
    lastErrorTime: number | null;
  };
}

export interface ProviderHealth {
  [provider: string]: ProviderHealthEntry;
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

const VALID_TRANSITIONS: Record<StreamState, StreamState[]> = {
  start: ["ttfb", "streaming", "error"],
  ttfb: ["streaming", "error"],
  streaming: ["complete", "error", "fallback"],
  fallback: ["streaming", "complete", "error"],
  complete: [],
  error: [],
};

/**
 * Validate StreamState transitions — rejects invalid transitions by returning current state (no-op).
 *
 * NOTE: Prefer transitionStreamState() for all ctx-bound transitions.
 * This pure function is only safe when the caller owns exclusive access to the state.
 */
export function nextState(current: StreamState, next: StreamState, ctx?: string): StreamState {
  if (!VALID_TRANSITIONS[current].includes(next)) {
    console.warn(`[StreamState] Invalid transition: ${current} → ${next}`, ctx ?? "");
    return current;
  }
  return next;
}

/**
 * Compare-and-swap transition on ctx._streamState.
 *
 * Prevents race conditions between concurrent async callbacks (timeout handlers,
 * stall timers, hedge aborts, fallback retries) that can all read a non-terminal
 * state before any of them writes the terminal state.
 *
 * Returns the new state if transition succeeded, or the current state if blocked
 * (already terminal or invalid transition).
 */
export function transitionStreamState(
  ctx: { _streamState?: StreamState },
  next: StreamState,
  requestId?: string,
): StreamState {
  const current = ctx._streamState ?? "start";

  // Terminal states — no transitions allowed
  if (current === "complete" || current === "error") {
    return current;
  }

  // Validate transition
  if (!VALID_TRANSITIONS[current].includes(next)) {
    console.warn(`[StreamState] Invalid transition: ${current} → ${next}`, requestId ?? "");
    return current;
  }

  ctx._streamState = next;
  return next;
}

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
