// src/metrics.ts
import type { RequestMetrics, MetricsSummary } from "./types.js";

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
    };
  }

  onRecord(callback: Subscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
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
