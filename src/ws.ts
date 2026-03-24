// src/ws.ts
import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import type { MetricsStore } from "./metrics.js";
import type { RequestMetrics, MetricsSummary, StreamEvent } from "./types.js";

interface WsMessage {
  type: "request" | "summary";
  data: RequestMetrics | MetricsSummary;
}

const PING_INTERVAL_MS = 30_000; // 30 seconds
const MAX_MISSED_PONGS = 2;
const BACKPRESSURE_THRESHOLD = 64 * 1024; // 64KB
const SUMMARY_DEBOUNCE_MS = 500;
const STREAM_WS_THROTTLE_MS = 500; // caps stream event delivery to ~2 Hz per client
const BACKPRESSURE_LOG_INTERVAL_MS = 10_000; // throttle backpressure warnings to once per 10s
const clientStreamThrottle = new WeakMap<any, number>();

let wssInstance: InstanceType<typeof import("ws").WebSocketServer> | null = null;

// Module-level counters for dropped events (useful for monitoring)
let streamDroppedCount = 0;
let lastBackpressureWarnTime = 0;

function maybeLogBackpressure(source: string): void {
  const now = Date.now();
  if (now - lastBackpressureWarnTime >= BACKPRESSURE_LOG_INTERVAL_MS) {
    console.warn(`[ws] Backpressure: dropping ${source} events (total dropped stream events: ${streamDroppedCount})`);
    lastBackpressureWarnTime = now;
  }
}

export function attachWebSocket(server: Server, metricsStore: MetricsStore): void {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wssInstance = wss;

  wss.on("connection", (ws) => {
    // Send current summary as initial state
    const summary = metricsStore.getSummary();
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
        const msg: WsMessage = { type: "summary", data: metricsStore.getSummary() };
        ws.send(JSON.stringify(msg));
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
      unsubscribe();
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
}

export function broadcastStreamEvent(data: StreamEvent): void {
  if (!wssInstance) return;
  const msg = JSON.stringify({ type: "stream", data });
  const isStreaming = data.state === "streaming";
  const isCritical = data.state === "complete" || data.state === "error";
  const now = Date.now();
  for (const client of wssInstance.clients) {
    if (client.readyState !== client.OPEN) continue;
    // Throttle streaming events per client (non-streaming events always pass)
    if (isStreaming) {
      const lastEmit = clientStreamThrottle.get(client) ?? 0;
      if (now - lastEmit < STREAM_WS_THROTTLE_MS) continue;
      clientStreamThrottle.set(client, now);
    }
    // Backpressure: for critical events, use a callback to wait until drain; for others, drop
    if (client.bufferedAmount > BACKPRESSURE_THRESHOLD) {
      if (isCritical) {
        // Critical events (complete/error) must not be silently dropped.
        // Wait for the drain event, then send. Use a one-time listener.
        const sendOnDrain = () => {
          if (client.readyState === client.OPEN) {
            client.send(msg);
          }
        };
        // If the socket already has a pending drain (bufferAmount is decreasing),
        // the 'drain' event will fire. Otherwise send immediately on next tick.
        client.once('drain', sendOnDrain);
        // Safety timeout: if drain never fires within 5s, force-send anyway
        setTimeout(() => {
          client.removeListener('drain', sendOnDrain);
          if (client.readyState === client.OPEN) {
            client.send(msg);
          }
        }, 5_000).unref();
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
