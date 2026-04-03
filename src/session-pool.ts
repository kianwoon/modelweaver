// src/session-pool.ts
import { Agent, type Dispatcher } from "undici";

export interface SessionStats {
  id: string;
  providerCount: number;
  lastActivity: string; // ISO 8601
  idleMs: number;
  providers: string[];
}

const SESSION_AGENT_CONNECTIONS = 3; // Support parallel subagent streams per session
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
 * Manages per-session per-provider undici Agents.
 * Each session gets its own dedicated HTTP/2 connection to each provider,
 * enabling TCP isolation between concurrent Claude Code sessions.
 *
 * Falls back to the shared provider agent when no session ID is present.
 */
export class SessionAgentPool {
  /** sessionId → providerName → Agent */
  private agents = new Map<string, Map<string, Agent>>();
  /** sessionId → providerName → last activity timestamp */
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
   * Get or create a session-scoped agent for the given provider.
   * Returns null if no sessionId (caller should use shared pool).
   */
  get(sessionId: string | undefined, providerName: string): Dispatcher | null {
    if (!sessionId) return null;

    let providerMap = this.agents.get(sessionId);
    if (!providerMap) {
      providerMap = new Map();
      this.agents.set(sessionId, providerMap);
    }

    let agent = providerMap.get(providerName);

    // Connection pre-check: if the agent has been idle beyond the staleness
    // threshold, its HTTP/2 connection may be half-closed by the upstream.
    // Destroy and create fresh — TCP/TLS handshake happens lazily on next request.
    if (agent) {
      const lastActive = this.lastActivity.get(sessionId)?.get(providerName);
      if (lastActive && Date.now() - lastActive > STALE_AGENT_THRESHOLD_MS) {
        const idleS = Math.round((Date.now() - lastActive) / 1000);
        console.log(`[session-pool] refreshing stale agent ${sessionId.slice(0, 8)}…/${providerName} (idle ${idleS}s > ${STALE_AGENT_THRESHOLD_MS / 1000}s threshold)`);
        agent.close().catch(() => {});
        providerMap.delete(providerName);
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
      providerMap.set(providerName, agent);
    }

    // Track activity
    let activityMap = this.lastActivity.get(sessionId);
    if (!activityMap) {
      activityMap = new Map();
      this.lastActivity.set(sessionId, activityMap);
    }
    activityMap.set(providerName, Date.now());

    return agent;
  }

  /** Close and remove agents idle beyond SESSION_IDLE_TTL_MS */
  private sweep(): void {
    const now = Date.now();
    const deadSessions = new Set<string>();

    for (const [sessionId, providerMap] of this.lastActivity) {
      let allIdle = true;
      for (const [providerName, lastActive] of providerMap) {
        if (now - lastActive > this.idleTtlMs) {
          // Close the idle agent
          const agent = this.agents.get(sessionId)?.get(providerName);
          if (agent) agent.close().catch(() => {});
          this.agents.get(sessionId)?.delete(providerName);
          providerMap.delete(providerName);
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

  /** Close and remove a specific session+provider agent (e.g., on connection error) */
  evict(sessionId: string, providerName: string): void {
    const agent = this.agents.get(sessionId)?.get(providerName);
    if (agent) {
      agent.close().catch(() => {});
      this.agents.get(sessionId)?.delete(providerName);
      this.lastActivity.get(sessionId)?.delete(providerName);
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
        providerCount: entries.length,
        lastActivity: new Date(Math.max(...entries.map(([, ts]) => ts))).toISOString(),
        idleMs: now - Math.max(...entries.map(([, ts]) => ts)),
        providers: entries.map(([name]) => name),
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
