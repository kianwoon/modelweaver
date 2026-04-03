// src/session-pool.ts
import { Agent, type Dispatcher } from "undici";

const SESSION_AGENT_CONNECTIONS = 1;
const SESSION_KEEPALIVE_MS = 30_000;
const SESSION_KEEPALIVE_MAX_MS = 60_000;
const SESSION_IDLE_TTL_MS = 120_000; // 2 minutes idle → close
const SWEEP_INTERVAL_MS = 60_000; // sweep every 60s

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

  constructor() {
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
    if (!agent) {
      agent = new Agent({
        connections: SESSION_AGENT_CONNECTIONS,
        keepAliveTimeout: SESSION_KEEPALIVE_MS,
        keepAliveMaxTimeout: SESSION_KEEPALIVE_MAX_MS,
        allowH2: true,
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
        if (now - lastActive > SESSION_IDLE_TTL_MS) {
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
