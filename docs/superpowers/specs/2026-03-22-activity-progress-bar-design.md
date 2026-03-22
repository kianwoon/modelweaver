# Animated Activity Progress Bar

**Date**: 2026-03-22
**Status**: Approved
**Scope**: GUI frontend + server WebSocket events

## Goal

Add a prominent, animated progress bar to the ModelWeaver GUI that shows real-time request activity — routing, streaming, fallback, completion, and errors — at a glance without reading numbers.

## Design

### Layout

A sticky header bar positioned between the connection status line and the stats grid. Always visible, never scrolls.

- **Idle**: Shows "Idle" text
- **1 active request**: Single bar fills full width
- **2+ active requests**: Multiple bars stacked vertically, max 3 visible
- **Complete**: Bar fills to 100%, shows tok/s label, fades out after 1s
- **Max height**: ~3 bars (54px) to avoid pushing stats off screen

### Server-side: New WebSocket Event Type `"stream"`

Emitted at request lifecycle points from `src/server.ts`.

**Event shapes**:

```typescript
// Request start
{ type: "stream", data: {
  requestId: string, model: string, tier: string,
  state: "start", provider: string, timestamp: number
}}

// Token progress (throttled to ~4 Hz)
{ type: "stream", data: {
  requestId: string, model: string, tier: string,
  state: "streaming", outputTokens: number, timestamp: number
}}

// Fallback triggered
{ type: "stream", data: {
  requestId: string, model: string, tier: string,
  state: "fallback", from: string, to: string, timestamp: number
}}

// Request complete
{ type: "stream", data: {
  requestId: string, model: string, tier: string,
  state: "complete", status: number, latencyMs: number,
  inputTokens: number, outputTokens: number, tokensPerSec: number
}}

// Request error
{ type: "stream", data: {
  requestId: string, model: string, tier: string,
  state: "error", status: number, message: string
}}
```

### Server Changes

**`src/ws.ts`**:
- Add `broadcastStreamEvent(data: StreamEvent): void` function
- Tracks all connected WS clients (iterate `wss.clients`)
- Export the function

**`src/server.ts`**:
- Before `forwardWithFallback()` call: emit `"start"` event
- Inside `createMetricsTransform()`: emit `"streaming"` event on each chunk, throttled to every 250ms per request
- On fallback provider: emit `"fallback"` event
- On metrics record callback: emit `"complete"` event
- On error response: emit `"error"` event

### GUI Changes

**`index.html`**: Add activity bar container between status and stats.

**`styles.css`**: Animated progress bar styles with striped animation overlay, per-state colors, entrance/exit transitions.

**`app.js`**:
- `Map<requestId, barState>` tracks in-flight requests
- Handle `"stream"` WS messages to create/update/remove bar elements
- Bar width based on elapsed time (cap at ~80% until complete)
- On complete: set to 100%, show tok/s, fade out after 1s
- On error: flash red, fade out after 1.5s
- Show "Idle" when no active bars

### Files Changed

| File | Change |
|------|--------|
| `src/ws.ts` | Add `broadcastStreamEvent()`, track clients |
| `src/server.ts` | Emit stream events at lifecycle points |
| `gui/frontend/index.html` | Add `#activity-bar` container |
| `gui/frontend/styles.css` | Add `.activity-*` styles + stripe animation |
| `gui/frontend/app.js` | Handle `"stream"` messages, render bars |

### Files NOT Changed

- `src/proxy.ts` — stream events emitted from server.ts wrapping existing flow
- `src/metrics.ts` — stream events independent of metrics recording
- `gui/src/*.rs` — no Rust changes, purely frontend

## Constraints

- Token progress throttled to ~4 Hz to avoid WebSocket flooding
- Max 3 visible bars to prevent layout shift
- Pure CSS animations — zero JS animation overhead
- Must not block or slow down the proxy request path (use `setImmediate` for WS sends)
