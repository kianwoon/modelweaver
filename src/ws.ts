// src/ws.ts
import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import type { MetricsStore } from "./metrics.js";
import type { RequestMetrics, MetricsSummary } from "./types.js";

interface WsMessage {
  type: "request" | "summary";
  data: RequestMetrics | MetricsSummary;
}

export function attachWebSocket(server: Server, metricsStore: MetricsStore): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    // Send current summary as initial state
    const summary = metricsStore.getSummary();
    const initialMsg: WsMessage = { type: "summary", data: summary };
    ws.send(JSON.stringify(initialMsg));

    // Subscribe to new metrics
    const unsubscribe = metricsStore.onRecord((metrics: RequestMetrics) => {
      if (ws.readyState === ws.OPEN) {
        const msg: WsMessage = { type: "request", data: metrics };
        ws.send(JSON.stringify(msg));
      }
    });

    ws.on("close", () => {
      unsubscribe();
    });

    ws.on("error", () => {
      unsubscribe();
    });
  });
}
