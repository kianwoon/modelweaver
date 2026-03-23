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
const clientStreamThrottle = new WeakMap<any, number>();

let wssInstance: InstanceType<typeof import("ws").WebSocketServer> | null = null;

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
  const now = Date.now();
  for (const client of wssInstance.clients) {
    if (client.readyState !== client.OPEN) continue;
    // Backpressure: skip if outbound buffer is too large
    if (client.bufferedAmount > BACKPRESSURE_THRESHOLD) continue;
    // Throttle streaming events per client (non-streaming events always pass)
    if (isStreaming) {
      const lastEmit = clientStreamThrottle.get(client) ?? 0;
      if (now - lastEmit < STREAM_WS_THROTTLE_MS) continue;
      clientStreamThrottle.set(client, now);
    }
    setImmediate(() => {
      if (client.readyState === client.OPEN) {
        client.send(msg);
      }
    });
  }
}
