// src/session-pool.ts
import { Agent, type Dispatcher } from "undici";

export interface SessionStats {
  id: string;
  modelCount: number;
  lastActivity: string; // ISO 8601
  idleMs: number;
  models: string[];
}

const SESSION_AGENT_CONNECTIONS = 1; // One TCP connection per model — HTTP/2 multiplexing handles concurrent streams
const SESSION_KEEPALIVE_MS = 30_000;
const SESSION_KEEPALIVE_MAX_MS = 60_000;
const DEFAULT_SESSION_IDLE_TTL_MS = 600_000; // 10 minutes idle → close
const SWEEP_INTERVAL_MS = 60_000; // sweep every 60s
/**
 * Default staleness threshold. Previously 10s, which was shorter than the
 * keepAliveTimeout (30s) and pingInterval (10s), causing agents to be evicted
 * before the HTTP/2 PING could keep them alive. Raised to 30s to match
 * keepAliveTimeout — the PING frame (every 10s) keeps the connection alive.
 */
const DEFAULT_STALE_AGENT_THRESHOLD_MS = 30_000;

/**
 * Manages per-session per-model undici Agents.
 * Each session gets its own dedicated HTTP/2 connection per model name,
 * enabling TCP isolation between concurrent model streams (e.g. main agent
 * on sonnet + subagents on haiku never contend for the same connection).
 *
 * Falls back to the shared provider agent when no session ID is present.
 */
export class SessionAgentPool {
  /** sessionId → modelName → Agent */
  private agents = new Map<string, Map<string, Agent>>();
  /** sessionId → modelName → last activity timestamp */
  private lastActivity = new Map<string, Map<string, number>>();
  /** sessionId → modelName → in-flight request count (prevents stale close on active streams) */
  private inFlight = new Map<string, Map<string, number>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTtlMs: number;
  private readonly staleThresholdMs: number;

  constructor(idleTtlMs: number = DEFAULT_SESSION_IDLE_TTL_MS, staleThresholdMs?: number) {
    this.idleTtlMs = idleTtlMs;
    this.staleThresholdMs = staleThresholdMs ?? DEFAULT_STALE_AGENT_THRESHOLD_MS;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Don't prevent process exit
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /**
   * Get or create a session-scoped agent for the given model.
   * Returns null if no sessionId (caller should use shared pool).
   */
  get(sessionId: string | undefined, modelName: string): Dispatcher | null {
    if (!sessionId) return null;

    let modelMap = this.agents.get(sessionId);
    if (!modelMap) {
      modelMap = new Map();
      this.agents.set(sessionId, modelMap);
    }

    let agent = modelMap.get(modelName);

    // Connection pre-check: if the agent has been idle beyond the staleness
    // threshold AND has no in-flight requests, its HTTP/2 connection may be
    // half-closed by the upstream. Destroy and create fresh.
    // IMPORTANT: never close an agent with in-flight streams — that kills the
    // HTTP/2 connection mid-stream, causing "socket closed unexpectedly" errors.
    if (agent) {
      const lastActive = this.lastActivity.get(sessionId)?.get(modelName);
      const active = this.inFlight.get(sessionId)?.get(modelName) ?? 0;
      if (lastActive && Date.now() - lastActive > this.staleThresholdMs && active === 0) {
        const idleS = Math.round((Date.now() - lastActive) / 1000);
        console.log(`[session-pool] refreshing stale agent ${sessionId.slice(0, 8)}…/${modelName} (idle ${idleS}s > ${this.staleThresholdMs / 1000}s threshold, no in-flight streams)`);
        agent.close().catch(() => {});
        modelMap.delete(modelName);
        agent = undefined;
      }
    }

    if (!agent) {
      agent = new Agent({
        connections: SESSION_AGENT_CONNECTIONS,
        keepAliveTimeout: SESSION_KEEPALIVE_MS,
        keepAliveMaxTimeout: SESSION_KEEPALIVE_MAX_MS,
        allowH2: true,
        pingInterval: 10_000, // HTTP/2 PING every 10s — detect dead connections in background
      });
      modelMap.set(modelName, agent);
    }

    // Track activity and in-flight count
    let activityMap = this.lastActivity.get(sessionId);
    if (!activityMap) {
      activityMap = new Map();
      this.lastActivity.set(sessionId, activityMap);
    }
    activityMap.set(modelName, Date.now());

    let flightMap = this.inFlight.get(sessionId);
    if (!flightMap) {
      flightMap = new Map();
      this.inFlight.set(sessionId, flightMap);
    }
    flightMap.set(modelName, (flightMap.get(modelName) ?? 0) + 1);

    return agent;
  }

  /** Decrement in-flight count for a session+model (call when request completes) */
  release(sessionId: string, modelName: string): void {
    const flightMap = this.inFlight.get(sessionId);
    if (flightMap) {
      const count = (flightMap.get(modelName) ?? 1) - 1;
      if (count <= 0) {
        flightMap.delete(modelName);
        if (flightMap.size === 0) this.inFlight.delete(sessionId);
      } else {
        flightMap.set(modelName, count);
      }
    }
  }

  /** Close and remove agents idle beyond SESSION_IDLE_TTL_MS */
  private sweep(): void {
    const now = Date.now();
    const deadSessions = new Set<string>();

    for (const [sessionId, providerMap] of this.lastActivity) {
      let allIdle = true;
      for (const [modelName, lastActive] of providerMap) {
        if (now - lastActive > this.idleTtlMs) {
          // Close the idle agent
          const agent = this.agents.get(sessionId)?.get(modelName);
          if (agent) agent.close().catch(() => {});
          this.agents.get(sessionId)?.delete(modelName);
          providerMap.delete(modelName);
          this.inFlight.get(sessionId)?.delete(modelName);
        } else {
          allIdle = false;
        }
      }
      if (allIdle || providerMap.size === 0) {
        deadSessions.add(sessionId);
      }
    }

    // Clean up empty session entries
    for (const sessionId of deadSessions) {
      const providerMap = this.agents.get(sessionId);
      if (!providerMap || providerMap.size === 0) {
        this.agents.delete(sessionId);
        this.lastActivity.delete(sessionId);
      }
    }
  }

  /** Close and remove a specific session+model agent (e.g., on connection error) */
  evict(sessionId: string, modelName: string): void {
    const agent = this.agents.get(sessionId)?.get(modelName);
    if (agent) {
      agent.close().catch(() => {});
      this.agents.get(sessionId)?.delete(modelName);
      this.lastActivity.get(sessionId)?.delete(modelName);
    }
    this.inFlight.get(sessionId)?.delete(modelName);
    // Clean up empty session entries
    if (this.agents.get(sessionId)?.size === 0) {
      this.agents.delete(sessionId);
      this.lastActivity.delete(sessionId);
      this.inFlight.delete(sessionId);
    }
  }

  /** Close all session agents (e.g., on reload/shutdown) */
  async closeAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [, providerMap] of this.agents) {
      for (const [, agent] of providerMap) {
        promises.push(agent.close().catch(() => {}));
      }
    }
    this.agents.clear();
    this.lastActivity.clear();
    this.inFlight.clear();
    await Promise.all(promises);
  }

  /** Per-session stats for observability */
  getStats(): SessionStats[] {
    const now = Date.now();
    const result: SessionStats[] = [];
    for (const [sessionId, providerMap] of this.lastActivity) {
      const entries = [...providerMap.entries()];
      if (entries.length === 0) continue; // skip stale entries (sweep may have emptied the map)
      result.push({
        id: sessionId,
        modelCount: entries.length,
        lastActivity: new Date(Math.max(...entries.map(([, ts]) => ts))).toISOString(),
        idleMs: now - Math.max(...entries.map(([, ts]) => ts)),
        models: entries.map(([name]) => name),
      });
    }
    return result;
  }

  /** Number of active sessions */
  get sessionCount(): number {
    return this.agents.size;
  }

  /** Destroy the pool (stop sweep timer + close all) */
  async destroy(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.closeAll();
  }
}
