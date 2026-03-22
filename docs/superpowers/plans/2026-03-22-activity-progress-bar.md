# Animated Activity Progress Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real-time animated progress bar to the ModelWeaver GUI showing request activity (routing, streaming, fallback, complete, error).

**Architecture:** Server emits new `"stream"` WebSocket events at request lifecycle points. GUI receives and renders animated CSS progress bars in a sticky header. Events are throttled to ~4 Hz to avoid flooding.

**Tech Stack:** TypeScript (server), HTML/CSS/JS (GUI frontend), WebSocket (ws library), Vitest (testing)

---

### Task 1: Add StreamEvent type and broadcastStreamEvent to ws.ts

**Files:**
- Modify: `src/ws.ts`
- Modify: `src/types.ts`
- Test: `tests/ws.test.ts`

- [ ] **Step 1: Add StreamEvent type to types.ts**

Add to `src/types.ts` after the `MetricsSummary` interface:

```typescript
export type StreamState = "start" | "streaming" | "fallback" | "complete" | "error";

export interface StreamEvent {
  requestId: string;
  model: string;
  tier: string;
  state: StreamState;
  timestamp: number;
  provider?: string;
  outputTokens?: number;
  from?: string;
  to?: string;
  status?: number;
  latencyMs?: number;
  inputTokens?: number;
  tokensPerSec?: number;
  message?: string;
}
```

- [ ] **Step 2: Add broadcastStreamEvent to ws.ts**

Modify `src/ws.ts` to:
1. Store the `wss` reference in a module-level variable
2. Export a `broadcastStreamEvent(data: StreamEvent): void` function that iterates `wss.clients` and sends to all OPEN connections using `setImmediate` (off critical path)

```typescript
import type { MetricsStore } from "./metrics.js";
import type { RequestMetrics, MetricsSummary, StreamEvent } from "./types.js";

let wssInstance: ReturnType<typeof WebSocketServer.prototype> | null = null;

export function broadcastStreamEvent(data: StreamEvent): void {
  if (!wssInstance) return;
  const msg = JSON.stringify({ type: "stream", data });
  for (const client of wssInstance.clients) {
    if (client.readyState === client.OPEN) {
      setImmediate(() => {
        if (client.readyState === client.OPEN) {
          client.send(msg);
        }
      });
    }
  }
}
```

In `attachWebSocket`, assign `wssInstance = wss;` after creating the WebSocketServer.

- [ ] **Step 3: Write tests for broadcastStreamEvent**

Add to `tests/ws.test.ts` inside the existing `describe("attachWebSocket")` block:

```typescript
import { broadcastStreamEvent } from "../src/ws.js";
import type { StreamEvent } from "../src/types.js";

describe("broadcastStreamEvent", () => {
  it("broadcasts stream events to all connected clients", async () => {
    const server = await createHttpServer();
    const store = new MetricsStore(100);
    attachWebSocket(server, store);
    const [ws1] = await connectAndReceive(server);
    const [ws2] = await connectAndReceive(server);

    const event: StreamEvent = {
      requestId: "stream-1",
      model: "claude-sonnet-4",
      tier: "sonnet",
      state: "start",
      provider: "anthropic",
      timestamp: Date.now(),
    };
    broadcastStreamEvent(event);

    const [msg1, msg2] = await Promise.all([
      waitForMessage(ws1),
      waitForMessage(ws2),
    ]);

    expect(JSON.parse(msg1).type).toBe("stream");
    expect(JSON.parse(msg1).data.requestId).toBe("stream-1");
    expect(JSON.parse(msg1).data.state).toBe("start");
    expect(JSON.parse(msg2).type).toBe("stream");
    expect(JSON.parse(msg2).data.requestId).toBe("stream-1");

    ws1.close();
    ws2.close();
    await closeServer(server);
  });

  it("does not throw when no WebSocket server is attached", () => {
    expect(() => broadcastStreamEvent({
      requestId: "no-op",
      model: "test",
      tier: "test",
      state: "start",
      timestamp: Date.now(),
    })).not.toThrow();
  });

  it("skips closed clients when broadcasting", async () => {
    const server = await createHttpServer();
    const store = new MetricsStore(100);
    attachWebSocket(server, store);
    const [ws1] = await connectAndReceive(server);
    const [ws2] = await connectAndReceive(server);

    ws2.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(() => broadcastStreamEvent({
      requestId: "skip-closed",
      model: "test",
      tier: "test",
      state: "start",
      timestamp: Date.now(),
    })).not.toThrow();

    ws1.close();
    await closeServer(server);
  });
});
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run tests/ws.test.ts`
Expected: All tests pass (existing + new)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/ws.ts tests/ws.test.ts
git commit -m "feat(ws): add StreamEvent type and broadcastStreamEvent"
```

---

### Task 2: Emit stream events from server.ts at request lifecycle points

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add import for broadcastStreamEvent**

At top of `src/server.ts`, add:

```typescript
import { broadcastStreamEvent } from "./ws.js";
import type { StreamEvent } from "./types.js";
```

- [ ] **Step 2: Emit "start" event before forwarding**

In the `app.post("/v1/messages", ...)` handler, after resolving the request and before `forwardWithFallback()`, add:

```typescript
// Broadcast stream start event
broadcastStreamEvent({
  requestId,
  model,
  tier: ctx.tier,
  state: "start",
  provider: ctx.providerChain[0]?.provider ?? "unknown",
  timestamp: Date.now(),
});
```

- [ ] **Step 3: Emit "streaming" events with throttling inside createMetricsTransform**

Inside `createMetricsTransform`, add a throttle mechanism. The function already has access to the transform stream — add a per-request throttle (250ms):

```typescript
const STREAM_THROTTLE_MS = 250;
let lastStreamEmit = 0;
```

Inside the `processChunk` function, after accumulating outputTokens, add:

```typescript
// Emit streaming progress event (throttled to ~4 Hz)
const now = Date.now();
if (now - lastStreamEmit >= STREAM_THROTTLE_MS && outputTokens > 0) {
  lastStreamEmit = now;
  broadcastStreamEvent({
    requestId: ctx.requestId,
    model: ctx.model,
    tier: ctx.tier,
    state: "streaming",
    outputTokens,
    timestamp: now,
  });
}
```

Also in the `flush()` function, if there are un-emitted tokens, emit a final streaming event.

- [ ] **Step 4: Emit "complete" or "error" events after metrics record**

After the metrics recording in the `recordMetrics` function inside `createMetricsTransform`, add:

For success (status 200-299):

```typescript
broadcastStreamEvent({
  requestId: ctx.requestId,
  model: ctx.model,
  tier: ctx.tier,
  state: "complete",
  status,
  latencyMs: Date.now() - ctx.startTime,
  inputTokens: inp,
  outputTokens: out,
  tokensPerSec: Math.round(tps * 10) / 10,
  timestamp: Date.now(),
});
```

For error (non-2xx status), the error is already handled in `forwardWithFallback`. The metrics transform won't fire for error responses since they don't go through the streaming path. Instead, emit error events from the server handler when `finalResponse.status >= 400`:

```typescript
// After obtaining finalResponse, before returning:
if (finalResponse.status >= 400) {
  broadcastStreamEvent({
    requestId,
    model,
    tier: ctx.tier,
    state: "error",
    status: finalResponse.status,
    message: `HTTP ${finalResponse.status}`,
    timestamp: Date.now(),
  });
}
```

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `npx vitest run tests/server.test.ts tests/ws.test.ts`
Expected: All existing tests pass

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): emit stream events at request lifecycle points"
```

---

### Task 3: Add activity bar HTML container to index.html

**Files:**
- Modify: `gui/frontend/index.html`

- [ ] **Step 1: Add activity bar div between status and stats**

Insert after the status div (line 26) and before the stats div (line 29):

```html
    <!-- Activity progress bar -->
    <div id="activity-bar" class="activity-bar">
      <div id="activity-content" class="activity-content">
        <span class="activity-idle">Idle</span>
      </div>
    </div>
```

- [ ] **Step 2: Commit**

```bash
git add gui/frontend/index.html
git commit -m "feat(gui): add activity progress bar container"
```

---

### Task 4: Add animated progress bar CSS styles

**Files:**
- Modify: `gui/frontend/styles.css`

- [ ] **Step 1: Add activity bar styles**

Add after the `.activity-idle` styles section (after the status section, before the stats section). Insert after the `@keyframes pulse` block:

```css
/* Activity progress bar */
.activity-bar {
  flex-shrink: 0;
  padding: 4px 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 0;
  max-height: 58px;
  overflow: hidden;
}

.activity-content {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.activity-idle {
  font-size: 10px;
  color: var(--text-dim);
  padding: 2px 0;
  user-select: none;
}

.activity-track {
  height: 18px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 9px;
  overflow: hidden;
  position: relative;
  display: flex;
  align-items: center;
  padding: 0 8px;
  animation: activity-enter 0.2s ease-out;
}

.activity-fill {
  height: 100%;
  border-radius: 9px;
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0%;
  transition: width 0.3s ease;
  /* Striped barber-pole animation */
  background-image: repeating-linear-gradient(
    -45deg,
    transparent,
    transparent 8px,
    rgba(255, 255, 255, 0.15) 8px,
    rgba(255, 255, 255, 0.15) 16px
  );
  background-size: 200% 100%;
  animation: activity-stripes 0.6s linear infinite;
}

.activity-fill.state-streaming {
  background-color: var(--green);
  box-shadow: 0 0 8px rgba(76, 175, 80, 0.4);
}

.activity-fill.state-fallback {
  background-color: var(--yellow);
  box-shadow: 0 0 8px rgba(255, 193, 7, 0.4);
  animation-duration: 0.4s;
}

.activity-fill.state-error {
  background-color: var(--accent);
  box-shadow: 0 0 8px rgba(233, 69, 96, 0.5);
  animation: none;
}

.activity-fill.state-complete {
  animation: none;
  background-color: var(--green);
  transition: width 0.15s ease, opacity 0.5s ease 0.5s;
  opacity: 0;
}

.activity-fill.state-start {
  background-color: var(--blue);
  box-shadow: 0 0 8px rgba(33, 150, 243, 0.4);
}

.activity-label {
  position: relative;
  z-index: 1;
  font-size: 10px;
  color: white;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
  display: flex;
  justify-content: space-between;
}

@keyframes activity-stripes {
  0% { background-position: 0 0; }
  100% { background-position: 22.63px 0; }
}

@keyframes activity-enter {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

Also add `max-height: 58px` to the `.activity-bar` and add `.activity-bar` to the `.titlebar, .status, .stats, .activity-bar` flex-shrink rule.

- [ ] **Step 2: Commit**

```bash
git add gui/frontend/styles.css
git commit -m "feat(gui): add animated progress bar CSS with stripe animation"
```

---

### Task 5: Handle stream events in app.js and render progress bars

**Files:**
- Modify: `gui/frontend/app.js`

- [ ] **Step 1: Add activity bar state management**

At the top of `app.js`, add after the DOM references:

```javascript
// Activity bar state
const activityContent = document.getElementById('activity-content');
const activeRequests = new Map(); // requestId -> { element, startTime, lastOutputTokens, model, tier }
const MAX_VISIBLE_BARS = 3;
```

- [ ] **Step 2: Add helper functions**

```javascript
function getTierColorClass(tier) {
  if (tier.includes('sonnet')) return 'sonnet';
  if (tier.includes('haiku')) return 'haiku';
  if (tier.includes('opus')) return 'opus';
  return '';
}

function createActivityBar(requestId, model, tier) {
  const track = document.createElement('div');
  track.className = 'activity-track';

  const fill = document.createElement('div');
  fill.className = 'activity-fill state-start';
  track.appendChild(fill);

  const label = document.createElement('span');
  label.className = 'activity-label';
  label.innerHTML = '<span>' + shortModel(model) + '</span><span></span>';
  track.appendChild(label);

  // Hide idle text
  const idle = activityContent.querySelector('.activity-idle');
  if (idle) idle.style.display = 'none';

  // Add to DOM, enforce max visible bars
  activityContent.appendChild(track);
  trimBars();

  return { element: track, fill, label, startTime: Date.now(), lastOutputTokens: 0, model, tier };
}

function trimBars() {
  const bars = activityContent.querySelectorAll('.activity-track');
  while (bars.length > MAX_VISIBLE_BARS) {
    const oldest = bars[0];
    oldest.remove();
    bars.shift();
  }
}

function removeActivityBar(requestId) {
  const entry = activeRequests.get(requestId);
  if (!entry) return;
  const bar = entry.element;

  // Fade out then remove
  bar.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
  bar.style.opacity = '0';
  bar.style.transform = 'translateX(20px)';
  setTimeout(() => {
    bar.remove();
    activeRequests.delete(requestId);
    // Show idle text if no bars remain
    if (activeRequests.size === 0) {
      let idle = activityContent.querySelector('.activity-idle');
      if (!idle) {
        idle = document.createElement('span');
        idle.className = 'activity-idle';
        idle.textContent = 'Idle';
        activityContent.appendChild(idle);
      }
      idle.style.display = '';
    }
  }, 500);
}
```

- [ ] **Step 3: Add stream message handler**

In the `ws.addEventListener('message', ...)` handler, add handling for `"stream"` type alongside existing `"summary"` and `"request"`:

```javascript
} else if (msg.type === 'stream') {
  handleStreamEvent(msg.data);
}
```

Add the `handleStreamEvent` function:

```javascript
function handleStreamEvent(data) {
  if (data.state === 'start') {
    const bar = createActivityBar(data.requestId, data.model, data.tier);
    activeRequests.set(data.requestId, bar);
    // Transition to streaming fill color
    setTimeout(() => {
      if (bar.fill) {
        bar.fill.classList.remove('state-start');
        bar.fill.classList.add('state-streaming');
      }
    }, 300);

  } else if (data.state === 'streaming') {
    const entry = activeRequests.get(data.requestId);
    if (!entry) return;

    // Animate width based on time elapsed (cap at 80% until complete)
    const elapsed = (Date.now() - entry.startTime) / 1000;
    const pct = Math.min(80, elapsed * 5); // ~16s to reach 80%
    entry.fill.style.width = pct + '%';
    entry.lastOutputTokens = data.outputTokens || 0;

    // Update token label
    const spans = entry.label.querySelectorAll('span');
    if (spans.length >= 2) {
      spans[1].textContent = data.outputTokens + ' tok';
    }

  } else if (data.state === 'fallback') {
    const entry = activeRequests.get(data.requestId);
    if (!entry) return;
    entry.fill.classList.remove('state-streaming');
    entry.fill.classList.add('state-fallback');
    const spans = entry.label.querySelectorAll('span');
    if (spans.length >= 2) {
      spans[1].textContent = 'fallback → ' + (data.to || '?');
    }

  } else if (data.state === 'complete') {
    const entry = activeRequests.get(data.requestId);
    if (!entry) return;
    entry.fill.classList.remove('state-streaming', 'state-fallback', 'state-start');
    entry.fill.classList.add('state-complete');
    entry.fill.style.width = '100%';
    const tps = data.tokensPerSec ? data.tokensPerSec.toFixed(0) + ' tok/s' : '';
    const latency = data.latencyMs >= 1000 ? (data.latencyMs / 1000).toFixed(1) + 's' : data.latencyMs + 'ms';
    const spans = entry.label.querySelectorAll('span');
    if (spans.length >= 2) {
      spans[1].textContent = (data.outputTokens || 0) + ' tok · ' + tps + ' · ' + latency;
    }
    setTimeout(() => removeActivityBar(data.requestId), 1200);

  } else if (data.state === 'error') {
    const entry = activeRequests.get(data.requestId);
    if (!entry) return;
    entry.fill.classList.remove('state-streaming', 'state-fallback', 'state-start');
    entry.fill.classList.add('state-error');
    entry.fill.style.width = entry.fill.style.width || '10%';
    const spans = entry.label.querySelectorAll('span');
    if (spans.length >= 2) {
      spans[1].textContent = 'error ' + (data.status || '');
    }
    setTimeout(() => removeActivityBar(data.requestId), 1500);
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add gui/frontend/app.js
git commit -m "feat(gui): handle stream events and render animated progress bars"
```

---

### Task 6: Integration testing and polish

**Files:**
- None (testing only)

- [ ] **Step 1: Run all existing tests**

Run: `npx vitest run`
Expected: All 174+ tests pass, no regressions

- [ ] **Step 2: Manual smoke test**

1. Start ModelWeaver: `npm run dev`
2. Start the GUI: `npx modelweaver gui`
3. Send a request through the proxy (e.g., via Claude Code)
4. Verify:
   - Green animated bar appears on request start
   - Bar grows as tokens stream
   - Bar shows tok/s and latency on completion
   - Bar fades out after completion
   - "Idle" text reappears when no active requests

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "chore: activity progress bar implementation complete"
```
