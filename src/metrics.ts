// src/metrics.ts
import type { RequestMetrics, MetricsSummary } from "./types.js";

type Subscriber = (metrics: RequestMetrics) => void;

export class MetricsStore {
  private buffer: (RequestMetrics | null)[];
  private maxSize: number;
  private head = 0;
  private count = 0;
  private subscribers: Set<Subscriber>;
  private createdAt: number;

  constructor(maxSize: number = 1000) {
    this.buffer = new Array(maxSize).fill(null);
    this.maxSize = maxSize;
    this.subscribers = new Set();
    this.createdAt = Date.now();
  }

  recordRequest(metrics: RequestMetrics): void {
    // Ring buffer: overwrite oldest entry when full
    const index = this.head % this.maxSize;
    this.buffer[index] = metrics;
    this.head++;
    if (this.count < this.maxSize) this.count++;

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

    // Single-pass aggregation: compute all metrics in one iteration
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokensPerSec = 0;
    const modelMap = new Map<string, { actualModel?: string; count: number; lastSeen: number }>();
    const providerMap = new Map<string, number>();

    for (let i = 0; i < requests.length; i++) {
      const r = requests[i];
      totalInputTokens += r.inputTokens ?? 0;
      totalOutputTokens += r.outputTokens ?? 0;
      totalTokensPerSec += r.tokensPerSec ?? 0;

      // Model grouping — group by requested model so fallbacks don't hide the original
      const groupKey = r.model;
      const existing = modelMap.get(groupKey);
      if (existing) {
        existing.count++;
        if (r.timestamp > existing.lastSeen) existing.lastSeen = r.timestamp;
      } else {
        modelMap.set(groupKey, { actualModel: r.actualModel, count: 1, lastSeen: r.timestamp });
      }

      // Provider grouping — use target provider so fallbacks don't hide the original
      const p = r.targetProvider ?? r.provider;
      providerMap.set(p, (providerMap.get(p) ?? 0) + 1);
    }

    const activeModels = [...modelMap.entries()]
      .map(([model, { actualModel, count, lastSeen }]) => ({ model, actualModel, count, lastSeen }))
      .sort((a, b) => b.count - a.count);

    const providerDistribution = [...providerMap.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalRequests: requests.length,
      totalInputTokens,
      totalOutputTokens,
      avgTokensPerSec: requests.length > 0 ? Math.round((totalTokensPerSec / requests.length) * 10) / 10 : 0,
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

    // Extract in chronological order from the ring buffer, filtering out null slots
    const result: RequestMetrics[] = [];
    if (this.count < this.maxSize) {
      // Buffer not yet wrapped — items are in order from index 0
      for (let i = 0; i < this.count; i++) {
        const entry = this.buffer[i];
        if (entry !== null) result.push(entry);
      }
    } else {
      // Buffer has wrapped — oldest is at head % maxSize, read from there
      const start = this.head % this.maxSize;
      for (let i = 0; i < this.maxSize; i++) {
        const entry = this.buffer[(start + i) % this.maxSize];
        if (entry !== null) result.push(entry);
      }
    }
    return result;
  }
}
