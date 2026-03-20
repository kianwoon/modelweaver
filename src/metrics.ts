// src/metrics.ts
import type { RequestMetrics, MetricsSummary } from "./types.js";

type Subscriber = (metrics: RequestMetrics) => void;

export class MetricsStore {
  private buffer: RequestMetrics[];
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

    const totalInputTokens = requests.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
    const totalOutputTokens = requests.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
    const avgTokensPerSec =
      requests.length > 0
        ? requests.reduce((sum, r) => sum + (r.tokensPerSec ?? 0), 0) / requests.length
        : 0;

    // Group by model, track actualModel when available
    const modelMap = new Map<string, { actualModel?: string; count: number; lastSeen: number }>();
    for (const r of requests) {
      const existing = modelMap.get(r.model);
      const actual = r.actualModel || undefined;
      if (existing) {
        existing.count++;
        if (r.timestamp > existing.lastSeen) existing.lastSeen = r.timestamp;
        if (actual) existing.actualModel = actual;
      } else {
        modelMap.set(r.model, { actualModel: actual, count: 1, lastSeen: r.timestamp });
      }
    }
    const activeModels = [...modelMap.entries()]
      .map(([model, { actualModel, count, lastSeen }]) => ({ model, actualModel, count, lastSeen }))
      .sort((a, b) => b.count - a.count);

    // Group by target provider (the intended routing target, not fallback)
    const providerMap = new Map<string, number>();
    for (const r of requests) {
      const p = r.targetProvider ?? r.provider;
      providerMap.set(p, (providerMap.get(p) ?? 0) + 1);
    }
    const providerDistribution = [...providerMap.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalRequests: requests.length,
      totalInputTokens,
      totalOutputTokens,
      avgTokensPerSec: Math.round(avgTokensPerSec * 100) / 100,
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

    // Extract in chronological order from the ring buffer
    const result: RequestMetrics[] = [];
    if (this.count < this.maxSize) {
      // Buffer not yet wrapped — items are in order from index 0
      for (let i = 0; i < this.count; i++) {
        result.push(this.buffer[i]);
      }
    } else {
      // Buffer has wrapped — oldest is at head % maxSize, read from there
      const start = this.head % this.maxSize;
      for (let i = 0; i < this.maxSize; i++) {
        result.push(this.buffer[(start + i) % this.maxSize]);
      }
    }
    return result;
  }
}
