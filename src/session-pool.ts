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
 * Staleness threshold: if an agent has been idle for this long, its underlying
 * HTTP/2 connection is almost certainly half-closed by the upstream server
 * (e.g. GLM closes after ~15-20s of inactivity). Closing and recreating the
 * agent proactively avoids 20s stall timeouts on the next request.
 * 10s is conservative — well below GLM's server-side idle timeout.
 */
const STALE_AGENT_THRESHOLD_MS = 10_000;

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
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTtlMs: number;

  constructor(idleTtlMs: number = DEFAULT_SESSION_IDLE_TTL_MS) {
    this.idleTtlMs = idleTtlMs;
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
    // threshold, its HTTP/2 connection may be half-closed by the upstream.
    // Destroy and create fresh — TCP/TLS handshake happens lazily on next request.
    if (agent) {
      const lastActive = this.lastActivity.get(sessionId)?.get(modelName);
      if (lastActive && Date.now() - lastActive > STALE_AGENT_THRESHOLD_MS) {
        const idleS = Math.round((Date.now() - lastActive) / 1000);
        console.log(`[session-pool] refreshing stale agent ${sessionId.slice(0, 8)}…/${modelName} (idle ${idleS}s > ${STALE_AGENT_THRESHOLD_MS / 1000}s threshold)`);
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

    // Track activity
    let activityMap = this.lastActivity.get(sessionId);
    if (!activityMap) {
      activityMap = new Map();
      this.lastActivity.set(sessionId, activityMap);
    }
    activityMap.set(modelName, Date.now());

    return agent;
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
    // Clean up empty session entries
    if (this.agents.get(sessionId)?.size === 0) {
      this.agents.delete(sessionId);
      this.lastActivity.delete(sessionId);
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
