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
  _agents?: Map<string, import("undici").Agent>;
  _circuitBreaker?: CircuitBreaker;
  _serverConfig?: ServerConfig;
  poolSize?: number;
  modelPools?: Record<string, number>;
  /** Max connection-level retries (TTFB timeout/stall/connection failure) before escalating to fallback. Default: 3 */
  _connectionRetries?: number;
  /** Staleness threshold (ms) for session-scoped agents. Idle agents beyond this are proactively refreshed. Default: 30000 */
  _staleAgentThresholdMs?: number;
  /** Configured default backoff (ms) for 429/503 rate-limited responses when no Retry-After header is present. Default: 1000 */
  _rateLimitBackoffMs?: number;
}

export interface RoutingEntry {
  provider: string;
  model?: string;
  weight?: number;
}

export interface ClassificationRule {
  /** Regex pattern string (compiled at config load time into _compiled) */
  pattern: string;
  /** Score awarded when this pattern matches the user message */
  score: number;
  /** Pre-compiled RegExp — populated by config loader, not from YAML */
  _compiled?: RegExp;
}

export interface SmartRoutingConfig {
  /** Master switch — when false, smart routing is skipped entirely */
  enabled: boolean;
  /** Minimum cumulative score for a tier to be selected */
  escalationThreshold: number;
  /** Tier definitions: key is tier number (1, 2), value is array of classification rules */
  patterns: Record<number, ClassificationRule[]>;
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
  retryBaseDelayMs?: number;     // Base delay (ms) between fallback retries — default 500
  retryMaxDelayMs?: number;      // Max delay (ms) between fallback retries — default 5000
  retryMultiplier?: number;      // Exponential backoff multiplier — default 2
  /** When true (default), skip the entire provider chain when all are unhealthy */
  globalBackoffEnabled?: boolean;
  /** Health score threshold below which a provider is considered unhealthy — default 0.5 */
  unhealthyThreshold?: number;
  /** Maximum request body size in MB — rejects requests exceeding this limit */
  maxBodySizeMB?: number;
  /** Session idle TTL in ms — closes per-session agent connections after this idle period. Default: 600000 (10min) */
  sessionIdleTtlMs?: number;
  /** When true, strip `thinking` blocks from upstream requests to prevent heavy SSE output */
  disableThinking?: boolean;
}

export interface AppConfig {
  server: ServerConfig;
  providers: Map<string, ProviderConfig>;
  routing: Map<string, RoutingEntry[]>;
  tierPatterns: Map<string, string[]>;
  modelRouting: Map<string, RoutingEntry[]>;
  hedging?: HedgingConfig;
  smartRouting?: SmartRoutingConfig;
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
  /** Timestamp when the first streaming chunk arrived (after TTFB). Used for streaming-only TPS. */
  _streamStartTime?: number;
  /** Retry-after value (seconds) from the last provider 429/503 response */
  _retryAfterMs?: number;
  /** Set when all providers in the chain have health < UNHEALTHY_THRESHOLD.
   *  Triggers immediate 503 response without attempting the chain. */
  _globalBackoff?: boolean;
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
  sessionStats: { sessionId: string; requestCount: number; lastSeen: number; modelCount?: number; models?: string[]; name?: string }[];
  providerErrors: { [provider: string]: { total: number; errors: { [status: number]: number }; lastErrorCode: number | null; lastErrorTime: number | null } };
  smartTierCounts?: { tier1: number; tier2: number; passthrough: number };
}

export interface ConnectionErrorEntry {
  stalls: number;
  ttfbTimeouts: number;
  connectionErrors: number;
  lastTime: number | null;
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
  connectionErrors?: ConnectionErrorEntry;
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
  ttfb: ["streaming", "complete", "error"],
  streaming: ["complete", "error", "fallback"],
  fallback: ["streaming", "complete", "error"],
  complete: [],
  // Allow recovery from error state: if upstream data arrives after a timeout/
  // stall error (e.g. from a race between TTFB timer and actual response), the
  // stream should resume rather than being permanently stuck in error state.
  // "error → complete" is also allowed for non-streaming error responses.
  // "error → error" is a no-op — common when stall timer and catch block both
  // fire for the same failure (stall handler runs first via setImmediate,
  // then catch block also tries to set error).
  error: ["streaming", "ttfb", "complete", "error"],
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

  // Terminal state — no transitions allowed from complete
  if (current === "complete") {
    return current;
  }
  // Error state allows recovery transitions (streaming, ttfb, complete)
  // but blocks duplicate error transitions.

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
  maxTokens?: number;
}
