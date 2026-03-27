// src/metrics.ts
import type { RequestMetrics, MetricsSummary, ModelPerformanceStats } from "./types.js";

type Subscriber = (metrics: RequestMetrics) => void;

const WS_RECENT_REQUESTS_CAP = 50;

interface ModelEntry {
  actualModel?: string;
  count: number;
  lastSeen: number;
}

export class MetricsStore {
  private static readonly MAX_MAP_SIZE = 200;

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
  private _totalCacheReadTokens = 0;
  private _totalCacheCreationTokens = 0;
  private _modelMap = new Map<string, ModelEntry>();
  private _providerMap = new Map<string, number>();

  constructor(maxSize: number = 1000) {
    this.buffer = new Array(maxSize).fill(null);
    this.maxSize = maxSize;
    this.subscribers = new Set();
    this.createdAt = Date.now();
  }

  /** Evict the entry with the lowest count when the map exceeds MAX_MAP_SIZE. */
  private pruneMap<V>(map: Map<string, V>, getCount: (v: V) => number): void {
    if (map.size <= MetricsStore.MAX_MAP_SIZE) return;
    let minKey = '';
    let minVal = Infinity;
    for (const [k, v] of map) {
      const val = getCount(v);
      if (val < minVal) {
        minVal = val;
        minKey = k;
      }
    }
    if (minKey) map.delete(minKey);
  }

  recordRequest(metrics: RequestMetrics): void {
    const index = this.head % this.maxSize;
    const evicted = this.count >= this.maxSize ? this.buffer[index] : null;

    // Decrement counters for evicted entry
    if (evicted !== null) {
      this._totalInputTokens -= evicted.inputTokens ?? 0;
      this._totalOutputTokens -= evicted.outputTokens ?? 0;
      this._totalTokensPerSec -= evicted.tokensPerSec ?? 0;
      this._totalCacheReadTokens -= evicted.cacheReadTokens ?? 0;
      this._totalCacheCreationTokens -= evicted.cacheCreationTokens ?? 0;

      const mKey = evicted.actualModel || evicted.model;
      const mEntry = this._modelMap.get(mKey);
      if (mEntry) {
        mEntry.count--;
        if (mEntry.count <= 0) this._modelMap.delete(mKey);
      }

      const pKey = evicted.targetProvider ?? evicted.provider;
      const pCount = this._providerMap.get(pKey) ?? 0;
      if (pCount <= 1) this._providerMap.delete(pKey);
      else this._providerMap.set(pKey, pCount - 1);
    }

    // Increment counters for new entry
    this._totalInputTokens += metrics.inputTokens ?? 0;
    this._totalOutputTokens += metrics.outputTokens ?? 0;
    this._totalTokensPerSec += metrics.tokensPerSec ?? 0;
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

    // Enforce size caps on maps
    this.pruneMap(this._modelMap, (e) => e.count);
    this.pruneMap(this._providerMap, (v) => v);

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
  }

  getSummary(): MetricsSummary {
    const requests = this.getRecentRequests();

    const activeModels = [...this._modelMap.entries()]
      .map(([model, { actualModel, count, lastSeen }]) => ({ model, actualModel, count, lastSeen }))
      .sort((a, b) => b.count - a.count);

    const providerDistribution = [...this._providerMap.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count);

    // Compute average cache hit rate across all requests with cache data
    let cacheHitRateSum = 0;
    let cacheHitRateCount = 0;
    for (const r of requests) {
      const totalInput = (r.inputTokens ?? 0) + (r.cacheReadTokens ?? 0) + (r.cacheCreationTokens ?? 0);
      if (totalInput > 0 && (r.cacheReadTokens ?? 0) > 0) {
        cacheHitRateSum += (r.cacheReadTokens! / totalInput) * 100;
        cacheHitRateCount++;
      }
    }

    // getRecentRequests() already caps at WS_RECENT_REQUESTS_CAP
    return {
      totalRequests: this._lifetimeRequests,
      totalInputTokens: this._totalInputTokens,
      totalOutputTokens: this._totalOutputTokens,
      avgTokensPerSec: this.count > 0 ? Math.round((this._totalTokensPerSec / this.count) * 10) / 10 : 0,
      totalCacheReadTokens: this._totalCacheReadTokens,
      totalCacheCreationTokens: this._totalCacheCreationTokens,
      avgCacheHitRate: cacheHitRateCount > 0 ? Math.round((cacheHitRateSum / cacheHitRateCount) * 10) / 10 : 0,
      activeModels,
      providerDistribution,
      recentRequests: requests,
      uptimeSeconds: Math.floor((Date.now() - this.createdAt) / 1000),
      modelStats: this.getModelStats(),
    };
  }

  onRecord(callback: Subscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private getModelStats(): ModelPerformanceStats[] {
    if (this.count === 0) return [];

    // Group entries by actualModel || model
    const groups = new Map<string, RequestMetrics[]>();
    for (let i = 0; i < this.count; i++) {
      const index = (i) % this.maxSize;
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

      // Cache hit rate
      let cacheHitSum = 0;
      let cacheHitCount = 0;
      for (const e of entries) {
        const totalInput = (e.inputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheCreationTokens ?? 0);
        if (totalInput > 0 && (e.cacheReadTokens ?? 0) > 0) {
          cacheHitSum += (e.cacheReadTokens! / totalInput) * 100;
          cacheHitCount++;
        }
      }
      const avgCacheHitRate = cacheHitCount > 0 ? Math.round((cacheHitSum / cacheHitCount) * 10) / 10 : 0;

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
    return stats;
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
