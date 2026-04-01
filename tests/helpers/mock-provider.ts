// tests/helpers/mock-provider.ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";

/**
 * Creates a mock Anthropic-compatible provider server for testing.
 * Returns { url, close, setBehavior }.
 */
export function createMockProvider() {
  const app = new Hono();

  let behavior: "success" | "error-429" | "error-500" | "error-401" | "timeout" | "stall" = "success";

  app.post("/v1/messages", async (c) => {
    if (behavior === "timeout") {
      // Never respond — caller must set short timeout
      await new Promise(() => {}); // hangs forever
    }

    if (behavior === "stall") {
      // Send one initial SSE chunk (to trigger pipe data flow and stall timer setup),
      // then stall indefinitely — simulating a provider that starts streaming but then
      // goes silent, triggering the stall timer to fire and inject an SSE error event.
      return new Response(
        new ReadableStream({
          start(controller) {
            // Enqueue one valid SSE chunk to trigger the pipe's data flow setup,
            // then never send more data or close — the stall timer will handle cleanup.
            controller.enqueue(
              new Uint8Array(
                new TextEncoder().encode(
                  "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_stall\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"test\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n"
                )
              )
            );
            // Do NOT close — simulate a stream that stalls after headers/initial data
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "anthropic-version": "2023-06-01",
          },
        }
      );
    }

    if (behavior === "error-429") {
      return c.json(
        { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
        429
      );
    }

    if (behavior === "error-500") {
      return c.json(
        { type: "error", error: { type: "api_error", message: "Internal error" } },
        500
      );
    }

    if (behavior === "error-401") {
      return c.json(
        { type: "error", error: { type: "authentication_error", message: "Invalid API key" } },
        401
      );
    }

    // Success: stream SSE response
    const body = await c.req.json();
    return new Response(
      [
        "event: message_start\n",
        `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: body.model || "test-model", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
        "event: content_block_start\n",
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        "event: content_block_delta\n",
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from mock provider" } })}\n\n`,
        "event: content_block_stop\n",
        `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        "event: message_delta\n",
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
        "event: message_stop\n",
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join(""),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "anthropic-version": "2023-06-01",
        },
      }
    );
  });

  const server = serve({ fetch: app.fetch, port: 0 });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Force resolve after 2s to prevent afterEach hangs when connections are dangling
        setTimeout(() => resolve(), 2000);
      }),
    setBehavior: (b: typeof behavior) => { behavior = b; },
  };
}
