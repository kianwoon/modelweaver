// src/ws.ts
import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import type { MetricsStore } from "./metrics.js";
import type { RequestMetrics, MetricsSummary, MetricsSummaryDelta, StreamEvent } from "./types.js";
import type { ConfigFieldError } from "./config.js";

interface WsMessage {
  type: "request" | "summary" | "summary_delta";
  data: RequestMetrics | MetricsSummary | MetricsSummaryDelta;
}

const PING_INTERVAL_MS = 30_000; // 30 seconds
const MAX_MISSED_PONGS = 2;
const BACKPRESSURE_THRESHOLD = 64 * 1024; // 64KB
const SUMMARY_DEBOUNCE_MS = 500;
const STREAM_WS_THROTTLE_MS = 500; // caps stream event delivery to ~2 Hz per client
const BACKPRESSURE_LOG_INTERVAL_MS = 10_000; // throttle backpressure warnings to once per 10s
const MAX_DRAIN_QUEUE = 100; // cap queue size per client to prevent unbounded growth
const MAX_TOTAL_QUEUED_BYTES = 10 * 1024 * 1024; // 10MB safety cap across all clients
let totalQueuedBytes = 0;
const clientStreamThrottle = new Map<WebSocket, number>();

interface PendingDrain {
  timer: ReturnType<typeof setTimeout>;
  queue: string[];
}
const pendingDrains = new Map<WebSocket, PendingDrain>();
const lastSummarySent = new WeakMap<any, MetricsSummary>();

function computeSummaryDelta(prev: MetricsSummary, next: MetricsSummary): MetricsSummaryDelta | null {
  const delta: MetricsSummaryDelta = {};
  let changed = false;

  if (prev.totalRequests !== next.totalRequests) { delta.totalRequests = next.totalRequests; changed = true; }
  if (prev.totalInputTokens !== next.totalInputTokens) { delta.totalInputTokens = next.totalInputTokens; changed = true; }
  if (prev.totalOutputTokens !== next.totalOutputTokens) { delta.totalOutputTokens = next.totalOutputTokens; changed = true; }
  if (prev.avgTokensPerSec !== next.avgTokensPerSec) { delta.avgTokensPerSec = next.avgTokensPerSec; changed = true; }
  if (prev.totalCacheReadTokens !== next.totalCacheReadTokens) { delta.totalCacheReadTokens = next.totalCacheReadTokens; changed = true; }
  if (prev.totalCacheCreationTokens !== next.totalCacheCreationTokens) { delta.totalCacheCreationTokens = next.totalCacheCreationTokens; changed = true; }
  if (prev.avgCacheHitRate !== next.avgCacheHitRate) { delta.avgCacheHitRate = next.avgCacheHitRate; changed = true; }
  if (prev.uptimeSeconds !== next.uptimeSeconds) { delta.uptimeSeconds = next.uptimeSeconds; changed = true; }

  // These change frequently — always include
  delta.activeModels = next.activeModels;
  delta.providerDistribution = next.providerDistribution;
  delta.modelStats = next.modelStats;

  // recentRequests: only send new ones not in prev
  // Fast path: skip Set allocation when no new requests arrived
  let newRequests: typeof next.recentRequests;
  if (next.recentRequests.length === prev.recentRequests.length &&
      next.recentRequests[0]?.requestId === prev.recentRequests[0]?.requestId) {
    newRequests = [];
  } else {
    const prevIds = new Set(prev.recentRequests.map(r => r.requestId));
    newRequests = next.recentRequests.filter(r => !prevIds.has(r.requestId));
  }
  if (newRequests.length > 0) { delta.recentRequests = newRequests; changed = true; }

  // sessionStats: only include if changed
  const prevSessions: any[] = (prev as any).sessionStats;
  const nextSessions: any[] = (next as any).sessionStats;
  if (prevSessions && nextSessions) {
    if (prevSessions.length !== nextSessions.length) {
      (delta as any).sessionStats = nextSessions;
      changed = true;
    } else {
      let sessionsChanged = false;
      for (let i = 0; i < nextSessions.length; i++) {
        const p = prevSessions[i];
        const n = nextSessions[i];
        if (!p || !n || p.sessionId !== n.sessionId || p.requestCount !== n.requestCount || p.lastSeen !== n.lastSeen) {
          sessionsChanged = true;
          break;
        }
      }
      if (sessionsChanged) {
        (delta as any).sessionStats = nextSessions;
        changed = true;
      }
    }
  } else if (nextSessions) {
    (delta as any).sessionStats = nextSessions;
    changed = true;
  }

  return changed ? delta : null;
}

let wssInstance: InstanceType<typeof import("ws").WebSocketServer> | null = null;

// Module-level counters for dropped events (useful for monitoring)
let streamDroppedCount = 0;
let droppedQueueCount = 0;
let lastBackpressureWarnTime = 0;

function maybeLogBackpressure(source: string): void {
  const now = Date.now();
  if (now - lastBackpressureWarnTime >= BACKPRESSURE_LOG_INTERVAL_MS) {
    console.warn(`[ws] Backpressure: dropping ${source} events (total dropped stream events: ${streamDroppedCount}, dropped queue events: ${droppedQueueCount})`);
    lastBackpressureWarnTime = now;
  }
}

export function attachWebSocket(server: Server, metricsStore: MetricsStore): void {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wssInstance = wss;

  wss.on("connection", (ws) => {
    // Send current summary as initial state
    const summary = metricsStore.getSummary();
    lastSummarySent.set(ws, summary);
    const initialMsg: WsMessage = { type: "summary", data: summary };
    ws.send(JSON.stringify(initialMsg));

    let pendingSummaryTimer: ReturnType<typeof setTimeout> | undefined;
    let missedPongs = 0;
    const alive = () => ws.readyState === ws.OPEN;

    // Subscribe to new metrics with backpressure check and debounced summary
    const unsubscribe = metricsStore.onRecord((metrics: RequestMetrics) => {
      if (!alive()) return;

      // Backpressure: skip send if outbound buffer is too large
      if (ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
        // Schedule a summary update instead so the client eventually catches up
        scheduleSummaryUpdate();
        maybeLogBackpressure("metrics");
        return;
      }

      // Defer JSON.stringify + send off the critical path
      setImmediate(() => {
        if (!alive()) return;
        const msg: WsMessage = { type: "request", data: metrics };
        ws.send(JSON.stringify(msg));
      });

      scheduleSummaryUpdate();
    });

    function scheduleSummaryUpdate(): void {
      if (pendingSummaryTimer) return; // already scheduled
      pendingSummaryTimer = setTimeout(() => {
        pendingSummaryTimer = undefined;
        if (!alive()) return;
        const summary = metricsStore.getSummary();
        let msg: WsMessage;
        const prev = lastSummarySent.get(ws);
        if (prev) {
          const delta = computeSummaryDelta(prev, summary);
          if (delta) {
            msg = { type: "summary_delta", data: delta };
          } else {
            return; // Nothing changed
          }
        } else {
          msg = { type: "summary", data: summary };
        }
        ws.send(JSON.stringify(msg));
        lastSummarySent.set(ws, summary);
      }, SUMMARY_DEBOUNCE_MS);
    }

    // Ping/pong heartbeat for liveness tracking
    const pingTimer = setInterval(() => {
      if (!alive()) {
        clearInterval(pingTimer);
        return;
      }
      // Terminate if client missed too many pongs
      if (missedPongs >= MAX_MISSED_PONGS) {
        cleanup();  // ensure timers and subscriber are cleaned up
        ws.terminate();
        return;
      }
      ws.ping();
      missedPongs++;
    }, PING_INTERVAL_MS);

    ws.on("pong", () => {
      missedPongs = 0; // reset on successful pong
    });

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(pingTimer);
      if (pendingSummaryTimer) clearTimeout(pendingSummaryTimer);
      lastSummarySent.delete(ws);
      clientStreamThrottle.delete(ws);
      const pending = pendingDrains.get(ws);
      if (pending) {
        clearTimeout(pending.timer);
        pendingDrains.delete(ws);
      }
      unsubscribe();
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
}

export function broadcastStreamEvent(data: StreamEvent): void {
  if (!wssInstance) return;
  const isStreaming = data.state === "streaming";
  const isCritical = data.state === "complete" || data.state === "error";
  const now = Date.now();

  let serializedMsg: string | undefined;
  for (const client of wssInstance.clients) {
    if (client.readyState !== client.OPEN) continue;

    // Throttle streaming events per client (non-streaming events always pass)
    if (isStreaming) {
      const lastEmit = clientStreamThrottle.get(client) ?? 0;
      if (now - lastEmit < STREAM_WS_THROTTLE_MS) continue;
      clientStreamThrottle.set(client, now);
    }

    // Lazy serialization — only when we know at least one client needs it
    if (!serializedMsg) serializedMsg = JSON.stringify({ type: "stream", data });
    const msg = serializedMsg;

    // Backpressure handling
    if (client.bufferedAmount > BACKPRESSURE_THRESHOLD) {
      if (isCritical) {
        let pending = pendingDrains.get(client);
        if (pending) {
          // Cap queue size per client to prevent unbounded growth
          if (pending.queue.length >= MAX_DRAIN_QUEUE) {
            const dropped = pending.queue.shift()!; // drop oldest
            totalQueuedBytes -= Buffer.byteLength(dropped, 'utf-8');
            droppedQueueCount++;
            maybeLogBackpressure("queue");
          }
          const msgSize = Buffer.byteLength(msg, 'utf-8');
          if (totalQueuedBytes + msgSize > MAX_TOTAL_QUEUED_BYTES) {
            console.warn(`[ws] Total queued bytes cap reached (${totalQueuedBytes}/${MAX_TOTAL_QUEUED_BYTES}), dropping message`);
            droppedQueueCount++;
            maybeLogBackpressure("global-cap");
            continue;
          }
          totalQueuedBytes += msgSize;
          pending.queue.push(msg);
        } else {
          const queue = [msg];
          const sendOnDrain = () => {
            pendingDrains.delete(client);
            totalQueuedBytes = 0;
            if (client.readyState === client.OPEN) {
              for (const queuedMsg of queue) client.send(queuedMsg);
            }
          };
          const timer = setTimeout(() => {
            pendingDrains.delete(client);
            totalQueuedBytes = 0;
            client.removeListener('drain', sendOnDrain);
            if (client.readyState === client.OPEN) {
              for (const queuedMsg of queue) client.send(queuedMsg);
            }
          }, 5_000).unref();
          pendingDrains.set(client, { timer, queue });
          client.once('drain', sendOnDrain);
        }
        continue;
      }
      // Non-critical streaming event: drop and count
      streamDroppedCount++;
      maybeLogBackpressure("stream");
      continue;
    }

    setImmediate(() => {
      if (client.readyState === client.OPEN) {
        client.send(msg);
      }
    });
  }
}

/**
 * Broadcast a config validation error to all connected GUI clients.
 * Sent as a `config_error` message type so the GUI can display
 * structured field-level error details.
 */
export function broadcastConfigError(fieldErrors: ConfigFieldError[]): void {
  if (!wssInstance) return;
  const msg = JSON.stringify({ type: "config_error", data: { fieldErrors, timestamp: Date.now() } });
  for (const client of wssInstance.clients) {
    if (client.readyState !== client.OPEN) continue;
    setImmediate(() => {
      if (client.readyState === client.OPEN) {
        client.send(msg);
      }
    });
  }
}

export function closeWebSocket(): void {
  if (!wssInstance) return;
  // Clear all pending drain timers before terminating clients
  for (const [, pending] of pendingDrains) {
    clearTimeout(pending.timer);
  }
  pendingDrains.clear();
  clientStreamThrottle.clear();
  for (const client of wssInstance.clients) {
    client.terminate();
  }
  wssInstance.close();
  wssInstance = null;
}
