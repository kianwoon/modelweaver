# Session Housekeeping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase session idle TTL to 10min, drain session connections on shutdown, and expose per-session stats via the API.

**Architecture:** Modify `SessionAgentPool` to accept a configurable TTL and return per-session stats. Wire TTL from YAML config through to the pool constructor. Add `closeAll()` to the shutdown path. Enrich the `/api/sessions` endpoint.

**Tech Stack:** TypeScript, Vitest, Hono, Zod

---

### Task 1: Make SessionAgentPool TTL configurable

**Files:**
- Modify: `src/session-pool.ts:1-28`

- [ ] **Step 1: Accept `idleTtlMs` via constructor, default 600000**

In `src/session-pool.ts`, replace the constant-based approach with a constructor parameter:

```typescript
// Remove this line:
// const SESSION_IDLE_TTL_MS = 120_000;

// Add default constant for documentation purposes:
const DEFAULT_SESSION_IDLE_TTL_MS = 600_000; // 10 minutes

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
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }
```

- [ ] **Step 2: Update `sweep()` to use `this.idleTtlMs`**

In `src/session-pool.ts`, change the sweep method's TTL check (line ~73):

```typescript
// Before:
if (now - lastActive > SESSION_IDLE_TTL_MS) {

// After:
if (now - lastActive > this.idleTtlMs) {
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/session-pool.ts
git commit -m "feat(session-pool): make idle TTL configurable via constructor (default 10min)"
```

---

### Task 2: Add `getStats()` method to SessionAgentPool

**Files:**
- Modify: `src/session-pool.ts:121-134` (add method before `get sessionCount`)

- [ ] **Step 1: Add SessionStats type and `getStats()` method**

Add this type at the top of the file (after imports) and the method to the class:

```typescript
// After imports, before the class:
export interface SessionStats {
  id: string;
  providerCount: number;
  lastActivity: string; // ISO 8601
  idleMs: number;
  providers: string[];
}
```

Add method to the class (before `get sessionCount`):

```typescript
/** Per-session stats for observability */
getStats(): SessionStats[] {
  const now = Date.now();
  const result: SessionStats[] = [];
  for (const [sessionId, providerMap] of this.lastActivity) {
    const entries = [...providerMap.entries()];
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
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/session-pool.ts
git commit -m "feat(session-pool): add getStats() for per-session observability"
```

---

### Task 3: Add `sessionIdleTtlMs` to config schema

**Files:**
- Modify: `src/config.ts:167-177` (server schema)
- Modify: `src/types.ts` (ServerConfig interface)

- [ ] **Step 1: Add field to ServerConfig type**

In `src/types.ts`, find the `ServerConfig` interface and add:

```typescript
export interface ServerConfig {
  port?: number;
  host?: string;
  streamBufferMs?: number;
  streamBufferBytes?: number;
  globalBackoffEnabled?: boolean;
  unhealthyThreshold?: number;
  maxBodySizeMB?: number;
  sessionIdleTtlMs?: number; // Session idle TTL in ms (default: 600000 = 10min)
}
```

- [ ] **Step 2: Add field to Zod schema**

In `src/config.ts`, add to the server object schema (line ~175, after `maxBodySizeMB`):

```typescript
sessionIdleTtlMs: z.number().int().min(60000).optional(),
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/types.ts
git commit -m "feat(config): add sessionIdleTtlMs to server config schema"
```

---

### Task 4: Wire config TTL to SessionAgentPool in server.ts

**Files:**
- Modify: `src/server.ts:406` (SessionAgentPool creation)
- Modify: `src/server.ts:392` (AppHandle interface)

- [ ] **Step 1: Add `closeSessionPool` to AppHandle**

In `src/server.ts`, update the `AppHandle` interface:

```typescript
export interface AppHandle {
  app: Hono;
  getConfig: () => AppConfig;
  setConfig: (config: AppConfig) => Promise<void>;
  closeAgents: () => Promise<void>;
  closeSessionPool: () => Promise<void>;
  getInFlightCount: () => number;
}
```

- [ ] **Step 2: Pass TTL to SessionAgentPool constructor**

In `src/server.ts`, change the SessionAgentPool creation (line ~406):

```typescript
// Before:
const sessionPool = new SessionAgentPool();

// After:
const sessionIdleTtlMs = initConfig.server?.sessionIdleTtlMs ?? 600_000;
const sessionPool = new SessionAgentPool(sessionIdleTtlMs);
```

- [ ] **Step 3: Add `closeSessionPool` to the returned handle**

In the return object at the bottom of `createApp` (line ~857), add before `closeAgents`:

```typescript
closeSessionPool: async () => {
  await sessionPool.closeAll();
},
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): wire sessionIdleTtlMs config to SessionAgentPool"
```

---

### Task 5: Drain session pool on shutdown

**Files:**
- Modify: `src/index.ts:505` (daemon shutdown handler)
- Modify: `src/index.ts:607-610` (foreground shutdown handler)

- [ ] **Step 1: Add session pool drain to daemon shutdown**

In `src/index.ts`, add before `await handle.closeAgents()` in the daemon shutdown handler (line ~505):

```typescript
await handle.closeSessionPool();
await handle.closeAgents();
```

- [ ] **Step 2: Add session pool drain to foreground shutdown**

In `src/index.ts`, add before `await handle.closeAgents()` in the foreground shutdown handler (line ~608):

```typescript
await handle.closeSessionPool();
await handle.closeAgents();
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(daemon): drain session pool on shutdown/reload"
```

---

### Task 6: Enrich `/api/sessions` endpoint

**Files:**
- Modify: `src/server.ts:786-792` (sessions endpoint)

- [ ] **Step 1: Update endpoint to return per-session stats**

Replace the `/api/sessions` handler:

```typescript
app.get("/api/sessions", (c) => {
  const sessions = sessionPool.getStats();
  return c.json({
    activeSessions: sessionPool.sessionCount,
    sessions,
  });
});
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(api): return per-session stats in /api/sessions"
```

---

### Task 7: Write tests for SessionAgentPool

**Files:**
- Create: `tests/session-pool.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/session-pool.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionAgentPool } from "../src/session-pool.js";

describe("SessionAgentPool", () => {
  let pool: SessionAgentPool;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await pool?.destroy();
  });

  describe("idle TTL", () => {
    it("uses default 10-minute TTL", () => {
      pool = new SessionAgentPool();
      pool.get("sess-1", "provider-a");
      // Advance 9 minutes 59 seconds
      vi.advanceTimersByTime(599_000);
      // Trigger sweep
      vi.runOnlyPendingTimers();
      expect(pool.sessionCount).toBe(1);
      // Advance past 10 minutes
      vi.advanceTimersByTime(10_000);
      vi.runOnlyPendingTimers();
      expect(pool.sessionCount).toBe(0);
    });

    it("accepts custom TTL via constructor", () => {
      pool = new SessionAgentPool(30_000); // 30 seconds
      pool.get("sess-1", "provider-a");
      vi.advanceTimersByTime(29_000);
      vi.runOnlyPendingTimers();
      expect(pool.sessionCount).toBe(1);
      vi.advanceTimersByTime(10_000);
      vi.runOnlyPendingTimers();
      expect(pool.sessionCount).toBe(0);
    });
  });

  describe("getStats()", () => {
    it("returns empty array for no sessions", () => {
      pool = new SessionAgentPool();
      expect(pool.getStats()).toEqual([]);
    });

    it("returns per-session stats with providers", () => {
      pool = new SessionAgentPool();
      const now = Date.now();
      vi.setSystemTime(now);
      pool.get("sess-1", "anthropic");
      pool.get("sess-1", "openai");
      pool.get("sess-2", "anthropic");

      const stats = pool.getStats();
      expect(stats).toHaveLength(2);
      // Find sess-1
      const s1 = stats.find(s => s.id === "sess-1")!;
      expect(s1.providerCount).toBe(2);
      expect(s1.providers).toContain("anthropic");
      expect(s1.providers).toContain("openai");
      expect(s1.idleMs).toBe(0);

      // Find sess-2
      const s2 = stats.find(s => s.id === "sess-2")!;
      expect(s2.providerCount).toBe(1);
      expect(s2.providers).toEqual(["anthropic"]);
    });

    it("reports correct idleMs", () => {
      pool = new SessionAgentPool();
      const now = Date.now();
      vi.setSystemTime(now);
      pool.get("sess-1", "anthropic");

      vi.advanceTimersByTime(60_000);
      const stats = pool.getStats();
      expect(stats[0].idleMs).toBe(60_000);
    });
  });

  describe("evict", () => {
    it("removes specific session+provider agent", () => {
      pool = new SessionAgentPool();
      pool.get("sess-1", "anthropic");
      pool.get("sess-1", "openai");
      expect(pool.sessionCount).toBe(1);

      pool.evict("sess-1", "anthropic");
      expect(pool.sessionCount).toBe(1); // session still exists
      const stats = pool.getStats();
      expect(stats[0].providers).toEqual(["openai"]);
    });

    it("removes session when last provider is evicted", () => {
      pool = new SessionAgentPool();
      pool.get("sess-1", "anthropic");
      pool.evict("sess-1", "anthropic");
      expect(pool.sessionCount).toBe(0);
    });
  });

  describe("get() without sessionId", () => {
    it("returns null when no sessionId", () => {
      pool = new SessionAgentPool();
      expect(pool.get(undefined, "anthropic")).toBeNull();
      expect(pool.sessionCount).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/session-pool.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/session-pool.test.ts
git commit -m "test(session-pool): add unit tests for TTL, getStats, evict"
```

---

### Task 8: Full verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, no regressions.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 3: Reload daemon**

Run: `npx modelweaver reload`
Expected: Daemon restarts cleanly.

- [ ] **Step 4: Verify API response**

Run: `curl http://localhost:3456/api/sessions`
Expected: JSON with `activeSessions` and `sessions` array (may be empty).
