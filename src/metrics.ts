// src/metrics.ts
import type { RequestMetrics, MetricsSummary, ModelPerformanceStats, ConnectionErrorEntry } from "./types.js";

type Subscriber = (metrics: RequestMetrics) => void;

const WS_RECENT_REQUESTS_CAP = 50;

interface ModelEntry {
  actualModel?: string;
  count: number;
  lastSeen: number;
}

export class MetricsStore {
  private static readonly MAX_MAP_SIZE = 200;
  /** Hide sessions idle beyond this threshold from the GUI. Read-time filter — no timer needed. */
  private static readonly SESSION_IDLE_TTL_MS = 600_000; // 10 minutes (matches session-pool.ts)

  private buffer: (RequestMetrics | null)[];
  private maxSize: number;
  private head = 0;
  private count = 0;
  private _lifetimeRequests = 0;
  private subscribers: Set<Subscriber>;
  private createdAt: number;

  // Running counters — updated incrementally in recordRequest()
  private _totalInputTokens = 0;
  private _totalOutputTokens = 0;
  private _totalTokensPerSec = 0;
  private _nonZeroTpsCount = 0; // count of entries with tokensPerSec > 0
  private _totalCacheReadTokens = 0;
  private _totalCacheCreationTokens = 0;
  private _modelMap = new Map<string, ModelEntry>();
  private _providerMap = new Map<string, number>();
  private _providerErrors = new Map<string, { total: number; errors: { [status: number]: number }; lastErrorCode: number | null; lastErrorTime: number | null }>();
  private _sessionMap = new Map<string, { count: number; lastSeen: number }>();

  // Connection-level error counters (stall, TTFB timeout, connection failed)
  // Tracked separately from HTTP status errors — do NOT affect health scores or circuit breakers.
  private _connectionErrors = new Map<string, ConnectionErrorEntry>();

  // Lazy cache for getModelStats() — invalidated on every recordRequest()
  private _modelStatsDirty = true;
  private _cachedModelStats: ModelPerformanceStats[] = [];

  // Incremental min tracking for pruneMap — avoids O(n) scan on every eviction
  private _modelMapMin = { current: null as string | null };
  private _providerMapMin = { current: null as string | null };
  private _providerErrorsMin = { current: null as string | null };
  private _sessionMapMin = { current: null as string | null };

  constructor(maxSize: number = 1000) {
    this.buffer = new Array(maxSize).fill(null);
    this.maxSize = maxSize;
    this.subscribers = new Set();
    this.createdAt = Date.now();
  }

  /** Evict the entry with the lowest count when the map exceeds MAX_MAP_SIZE.
   *  Uses incremental min tracking — O(1) on normal evictions, O(n) only when
   *  evicting the current minimum (rare). */
  private pruneMap<K>(
    map: Map<string, K>,
    getCount: (v: K) => number,
    minKeyRef: { current: string | null },
  ): void {
    if (map.size <= MetricsStore.MAX_MAP_SIZE) return;

    let minKey: string | null = null;
    let minVal = Infinity;

    // If we're not evicting the tracked minimum, we're O(1)
    const evicting = minKeyRef.current;
    if (evicting && map.has(evicting)) {
      map.delete(evicting);
      minKeyRef.current = null; // force rescan for next time
    }

    // If we don't know the minimum, do a full scan (rare — only after evicting min)
    if (minKeyRef.current === null) {
      for (const [k, v] of map) {
        const val = getCount(v);
        if (val < minVal) {
          minVal = val;
          minKey = k;
        }
      }
      minKeyRef.current = minKey;
    }
  }

  recordRequest(metrics: RequestMetrics): void {
    const index = this.head % this.maxSize;
    const evicted = this.count >= this.maxSize ? this.buffer[index] : null;

    // Decrement counters for evicted entry
    if (evicted !== null) {
      this._totalInputTokens -= evicted.inputTokens ?? 0;
      this._totalOutputTokens -= evicted.outputTokens ?? 0;
      this._totalTokensPerSec -= evicted.tokensPerSec ?? 0;
      if ((evicted.tokensPerSec ?? 0) > 0) this._nonZeroTpsCount--;
      this._totalCacheReadTokens -= evicted.cacheReadTokens ?? 0;
      this._totalCacheCreationTokens -= evicted.cacheCreationTokens ?? 0;

      const mKey = evicted.actualModel || evicted.model;
      const mEntry = this._modelMap.get(mKey);
      if (mEntry) {
        mEntry.count--;
        if (mEntry.count <= 0) {
          this._modelMap.delete(mKey);
          if (this._modelMapMin.current === mKey) this._modelMapMin.current = null;
        }
      }

      const pKey = evicted.targetProvider ?? evicted.provider;
      const pCount = this._providerMap.get(pKey) ?? 0;
      if (pCount <= 1) {
        this._providerMap.delete(pKey);
        if (this._providerMapMin.current === pKey) this._providerMapMin.current = null;
      } else {
        this._providerMap.set(pKey, pCount - 1);
      }

      // Decrement provider error counters for evicted entry
      if (evicted.status < 200 || evicted.status >= 400) {
        const pe = this._providerErrors.get(pKey);
        if (pe) {
          pe.total--;
          if (pe.errors[evicted.status]) pe.errors[evicted.status]--;
          // Remove oldest buffered error entry for this provider
          const buf = this._providerErrorsBuffer.get(pKey);
          if (buf && buf.length > 0) buf.shift();
          if (pe.total <= 0) {
            this._providerErrors.delete(pKey);
            this._providerErrorsBuffer.delete(pKey);
            if (this._providerErrorsMin.current === pKey) this._providerErrorsMin.current = null;
          } else {
            // Recalculate lastErrorCode/lastErrorTime from remaining buffer
            this._recalcProviderLastError(pKey, pe);
          }
        }
      }

      // Decrement session counter for evicted entry
      if (evicted.sessionId) {
        const sEntry = this._sessionMap.get(evicted.sessionId);
        if (sEntry) {
          sEntry.count--;
          if (sEntry.count <= 0) {
            this._sessionMap.delete(evicted.sessionId);
            if (this._sessionMapMin.current === evicted.sessionId) this._sessionMapMin.current = null;
          }
        }
      }
    }

    // Increment counters for new entry
    // NOTE: Uses Number (IEEE 754 double). Precision loss after ~9 quadrillion tokens.
    // Consider BigInt for extreme-scale deployments.
    this._totalInputTokens += metrics.inputTokens ?? 0;
    this._totalOutputTokens += metrics.outputTokens ?? 0;
    this._totalTokensPerSec += metrics.tokensPerSec ?? 0;
    if ((metrics.tokensPerSec ?? 0) > 0) this._nonZeroTpsCount++;
    this._totalCacheReadTokens += metrics.cacheReadTokens ?? 0;
    this._totalCacheCreationTokens += metrics.cacheCreationTokens ?? 0;

    const mKey = metrics.actualModel || metrics.model;
    const existing = this._modelMap.get(mKey);
    if (existing) {
      existing.count++;
      if (metrics.timestamp > existing.lastSeen) existing.lastSeen = metrics.timestamp;
      // Update actualModel to latest seen for the grouped model
      existing.actualModel = metrics.actualModel;
    } else {
      this._modelMap.set(mKey, { actualModel: metrics.actualModel, count: 1, lastSeen: metrics.timestamp });
    }

    const pKey = metrics.targetProvider ?? metrics.provider;
    this._providerMap.set(pKey, (this._providerMap.get(pKey) ?? 0) + 1);

    // Track provider errors (4xx/5xx)
    if (metrics.status < 200 || metrics.status >= 400) {
      const pe = this._providerErrors.get(pKey);
      if (pe) {
        pe.total++;
        pe.errors[metrics.status] = (pe.errors[metrics.status] ?? 0) + 1;
        pe.lastErrorCode = metrics.status;
        pe.lastErrorTime = metrics.timestamp;
      } else {
        this._providerErrors.set(pKey, {
          total: 1,
          errors: { [metrics.status]: 1 },
          lastErrorCode: metrics.status,
          lastErrorTime: metrics.timestamp,
        });
      }
      // Push to per-provider error timestamp buffer for recalc on eviction
      let buf = this._providerErrorsBuffer.get(pKey);
      if (!buf) { buf = []; this._providerErrorsBuffer.set(pKey, buf); }
      buf.push({ status: metrics.status, timestamp: metrics.timestamp });
      if (buf.length > 100) buf.shift();
      this.pruneMap(this._providerErrors, (e) => e.total, this._providerErrorsMin);
    }

    // Increment session counter
    if (metrics.sessionId) {
      const existing = this._sessionMap.get(metrics.sessionId);
      if (existing) {
        existing.count++;
        if (metrics.timestamp > existing.lastSeen) existing.lastSeen = metrics.timestamp;
      } else {
        this._sessionMap.set(metrics.sessionId, { count: 1, lastSeen: metrics.timestamp });
      }
      this.pruneMap(this._sessionMap, (e) => e.count, this._sessionMapMin);
    }

    // Enforce size caps on maps
    this.pruneMap(this._modelMap, (e) => e.count, this._modelMapMin);
    this.pruneMap(this._providerMap, (v) => v, this._providerMapMin);

    // Ring buffer: overwrite oldest entry when full
    this.buffer[index] = metrics;
    this.head++;
    if (this.count < this.maxSize) this.count++;
    this._lifetimeRequests++;

    // Notify subscribers (catch errors to prevent breaking recording)
    for (const cb of this.subscribers) {
      try {
        cb(metrics);
      } catch {
        // Swallow subscriber errors — recording must not break
      }
    }

    // Invalidate modelStats cache since buffer changed
    this._modelStatsDirty = true;
  }

  getSummary(): MetricsSummary {
    const requests = this.getRecentRequests();

    const activeModels = [...this._modelMap.entries()]
      .map(([model, { actualModel, count, lastSeen }]) => ({ model, actualModel, count, lastSeen }))
      .sort((a, b) => b.count - a.count);

    const providerDistribution = [...this._providerMap.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count);

    // Compute average cache hit rate using running counters (same 1000-entry window as token totals)
    const totalInputAll = this._totalInputTokens + this._totalCacheReadTokens + this._totalCacheCreationTokens;
    const avgCacheHitRate = totalInputAll > 0
      ? Math.round((this._totalCacheReadTokens / totalInputAll) * 1000) / 10
      : 0;

    // getRecentRequests() already caps at WS_RECENT_REQUESTS_CAP
    return {
      totalRequests: this._lifetimeRequests,
      totalInputTokens: this._totalInputTokens,
      totalOutputTokens: this._totalOutputTokens,
      avgTokensPerSec: this._nonZeroTpsCount > 0 ? Math.round((this._totalTokensPerSec / this._nonZeroTpsCount) * 10) / 10 : 0,
      totalCacheReadTokens: this._totalCacheReadTokens,
      totalCacheCreationTokens: this._totalCacheCreationTokens,
      avgCacheHitRate,
      activeModels,
      providerDistribution,
      recentRequests: requests,
      uptimeSeconds: Math.floor((Date.now() - this.createdAt) / 1000),
      modelStats: this.getModelStats(),
      sessionStats: (() => {
        const cutoff = Date.now() - MetricsStore.SESSION_IDLE_TTL_MS;
        const live: { sessionId: string; requestCount: number; lastSeen: number }[] = [];
        for (const [id, entry] of this._sessionMap) {
          if (entry.lastSeen >= cutoff) {
            live.push({ sessionId: id, requestCount: entry.count, lastSeen: entry.lastSeen });
          } else {
            this._sessionMap.delete(id);
            if (this._sessionMapMin.current === id) this._sessionMapMin.current = null;
          }
        }
        return live.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 50);
      })(),
      providerErrors: Object.fromEntries(this._providerErrors),
    };
  }

  onRecord(callback: Subscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private getModelStats(): ModelPerformanceStats[] {
    if (!this._modelStatsDirty) return this._cachedModelStats;
    if (this.count === 0) return [];

    // Group entries by actualModel || model
    const groups = new Map<string, RequestMetrics[]>();
    for (let i = 0; i < this.count; i++) {
      const index = ((this.head - this.count + i) % this.maxSize + this.maxSize) % this.maxSize;
      const entry = this.buffer[index];
      if (entry === null) continue;
      const key = entry.actualModel || entry.model;
      const list = groups.get(key);
      if (list) list.push(entry);
      else groups.set(key, [entry]);
    }

    const stats: ModelPerformanceStats[] = [];
    for (const [model, entries] of groups) {
      const latencies = entries.map(e => e.latencyMs).sort((a, b) => a - b);
      const avgLatencyMs = Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length);
      const p50Idx = Math.floor(latencies.length * 0.5);
      const p95Idx = Math.min(Math.floor(latencies.length * 0.95), latencies.length - 1);
      const p50LatencyMs = latencies[p50Idx] ?? 0;
      const p95LatencyMs = latencies[p95Idx] ?? 0;

      const successCount = entries.filter(e => e.status >= 200 && e.status < 300).length;
      const successRate = Math.round((successCount / entries.length) * 1000) / 10;
      const errorCount = entries.filter(e => e.status < 200 || e.status >= 400).length;

      const tokSecEntries = entries.filter(e => e.tokensPerSec > 0);
      const avgTokensPerSec = tokSecEntries.length > 0
        ? Math.round((tokSecEntries.reduce((s, e) => s + e.tokensPerSec, 0) / tokSecEntries.length) * 10) / 10
        : 0;

      // Cache hit rate — sum-based (includes zero-cache requests in denominator)
      const totalInputForModel = entries.reduce((s, e) =>
        s + (e.inputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheCreationTokens ?? 0), 0);
      const totalCacheReadForModel = entries.reduce((s, e) => s + (e.cacheReadTokens ?? 0), 0);
      const avgCacheHitRate = totalInputForModel > 0
        ? Math.round((totalCacheReadForModel / totalInputForModel) * 1000) / 10
        : 0;

      // Provider breakdown
      const providerGroups = new Map<string, { count: number; latencySum: number; errorCount: number }>();
      for (const e of entries) {
        const pKey = e.targetProvider ?? e.provider;
        const pg = providerGroups.get(pKey);
        if (pg) {
          pg.count++;
          pg.latencySum += e.latencyMs;
          if (e.status < 200 || e.status >= 400) pg.errorCount++;
        } else {
          providerGroups.set(pKey, {
            count: 1,
            latencySum: e.latencyMs,
            errorCount: (e.status < 200 || e.status >= 400) ? 1 : 0,
          });
        }
      }

      const providerBreakdown = [...providerGroups.entries()]
        .map(([provider, { count, latencySum, errorCount }]) => ({
          provider,
          count,
          avgLatencyMs: Math.round(latencySum / count),
          errorCount,
        }))
        .sort((a, b) => b.count - a.count);

      stats.push({
        model,
        count: entries.length,
        avgLatencyMs,
        p50LatencyMs,
        p95LatencyMs,
        successRate,
        avgTokensPerSec,
        avgCacheHitRate,
        errorCount,
        providerBreakdown,
      });
    }

    // Sort by count descending
    stats.sort((a, b) => b.count - a.count);

    this._modelStatsDirty = false;
    this._cachedModelStats = stats;
    return this._cachedModelStats;
  }

  /** Recompute lastErrorCode and lastErrorTime for a provider from its error buffer.
   *  Called when an old error entry is evicted so lastError stays accurate. */
  private _recalcProviderLastError(provider: string, pe: { total: number; errors: { [status: number]: number }; lastErrorCode: number | null; lastErrorTime: number | null }): void {
    // The errors map stores { statusCode: count }. We need the most recent entry.
    // Since we only track counts (not timestamps per status code), we keep the
    // last known timestamp per status in a separate parallel map.
    const buffered = this._providerErrorsBuffer.get(provider);
    if (buffered && buffered.length > 0) {
      const mostRecent = buffered[buffered.length - 1];
      pe.lastErrorCode = mostRecent.status;
      pe.lastErrorTime = mostRecent.timestamp;
    } else {
      pe.lastErrorCode = null;
      pe.lastErrorTime = null;
    }
  }

  /** Ring buffer for per-status error timestamps — used to recompute lastError after eviction. */
  private _providerErrorsBuffer = new Map<string, { status: number; timestamp: number }[]>();

  /** Returns full provider health state (errors + circuit breaker state merged). */
  getProviderErrors(): { [provider: string]: { total: number; errors: { [status: number]: number }; lastErrorCode: number | null; lastErrorTime: number | null } } {
    return Object.fromEntries(this._providerErrors);
  }

  /** Record a connection-level error (stall, TTFB timeout, connection failed).
   *  Tracked separately from HTTP status errors — does NOT affect health scores or circuit breakers. */
  recordConnectionError(provider: string, type: keyof Omit<ConnectionErrorEntry, "lastTime">): void {
    const entry = this._connectionErrors.get(provider) ?? { stalls: 0, ttfbTimeouts: 0, connectionErrors: 0, lastTime: null };
    entry[type]++;
    entry.lastTime = Date.now();
    this._connectionErrors.set(provider, entry);
  }

  /** Returns connection-level error counters for all providers. */
  getConnectionErrors(): { [provider: string]: ConnectionErrorEntry } {
    return Object.fromEntries(this._connectionErrors);
  }

  private getRecentRequests(): RequestMetrics[] {
    if (this.count === 0) return [];

    // Collect only the last WS_RECENT_REQUESTS_CAP entries in reverse (newest first)
    const cap = Math.min(this.count, WS_RECENT_REQUESTS_CAP);
    const result: RequestMetrics[] = [];
    // Start from the most recently written slot and walk backward
    for (let i = 0; i < cap; i++) {
      const index = ((this.head - 1 - i) % this.maxSize + this.maxSize) % this.maxSize;
      const entry = this.buffer[index];
      if (entry !== null) {
        result.push(entry);
      }
    }
    // Reverse to get chronological order (oldest first, newest last)
    result.reverse();
    return result;
  }
}
