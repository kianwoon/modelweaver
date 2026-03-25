# Connection Pool Poisoning & Daemon Shutdown Fix

**Date**: 2026-03-25

## Problem Statement

ModelWeaver proxy intermittently returns 502 errors to all clients. The issue cascades — once it starts, every request fails. `modelweaver stop && modelweaver start` does NOT reliably fix it because the stop mechanism fails to kill all processes.

## Evidence

### Log Pattern (from ~/.modelweaver/modelweaver.log)

```
07:31  status:200 + Body stalled: no data after 30000ms  ← stream dies, connection leaks
07:32  status:200 + Body stalled: no data after 30000ms  ← another leak
07:33  status:502, latencyMs:15005                        ← reuses dead connection
07:36  status:502, latencyMs:15004                        ← cascading failures
08:27  status:429, latencyMs:30001                        ← GLM rate-limiting, proxy waits full timeout
08:28  status:502, latencyMs:33007                        ← TTFB timeout on retry
```

### Process Orphaning Evidence

```
$ ps aux | grep modelweaver
kianwoonwong  84124  node ... --daemon     ← orphaned worker #1
kianwoonwong  83996  node ... --daemon     ← orphaned worker #2 (got port 3456)
kianwoonwong  83463  node ... --daemon     ← orphaned worker #3
kianwoonwong  83354  node ... --monitor    ← orphaned monitor (keeps respawning)
```

## Root Cause 1: Connection Pool Poisoning

ModelWeaver uses undici's `Agent` for HTTP keep-alive pooling (config.ts:232):

```typescript
providerConfig._agent = new Agent({
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 60000,
  connections: 10,
  allowH2: true,
});
```

When upstream drops mid-stream, body stall detection fires (proxy.ts:484) and destroys the PassThrough wrapper, but `undiciResponse.body` is NEVER destroyed. The underlying TCP connection returns to the pool in a broken state. Next request reuses it -> hangs -> TTFB timeout -> 502.

### Error Paths That Leak Connections

**Path 1: Body stall (HIGH RISK)** -- proxy.ts:475-484

- `passThrough.destroy()` called, `undiciResponse.body` untouched
- Connection returns to pool broken

**Path 2: Body stall re-armed timer (HIGH RISK)** -- proxy.ts:490-499

- Same issue on re-armed stall timer

**Path 3: Race cancellation (MEDIUM RISK)** -- proxy.ts:447-451

- External abort clears timers only, doesn't destroy body

**Path 4: TTFB timeout (LOW-MEDIUM)** -- proxy.ts:420-425

- controller.abort() before response received; undici handles internally but edge cases exist

**Path 5: Total timeout (LOW-MEDIUM)** -- proxy.ts:413

- Same as TTFB timeout concern

## Root Cause 2: Broken Daemon Shutdown

Architecture: `monitor (--monitor) -> worker (--daemon, detached)`

`stopDaemon()` (daemon.ts:361) sends SIGTERM to monitor PID. Monitor handler (monitor.ts:116) kills child worker. But:

- Worker spawned with `detached: true` -- separate process group
- `killProcessTree` sends signals to individual PIDs, doesn't walk process tree
- Monitor may exit before worker fully dies -> worker orphaned
- Orphaned monitor auto-restarts worker (monitor.ts:68-109)
- Multiple stop/start cycles create zombie monitor+worker pairs
- Port 3456 stays bound by orphan -> new daemon can't start

## Root Cause 2b: GUI App Respawns Daemon

The ModelWeaver GUI app (`ModelWeaver.app`) monitors the daemon process and auto-restarts it when it detects the daemon is not running. This means:

- `modelweaver stop` kills the daemon, but the GUI immediately respawns it (with the same poisoned connection pool)
- `pkill -9` kills the daemon, GUI respawns it again
- Multiple stop/start cycles create an escalating number of zombie processes
- The user must close the GUI app FIRST before any stop/start cycle will work
- This is not documented anywhere and creates a confusing experience where "stop && start" appears broken

## Root Cause 4: 429 Not Read Immediately

When GLM returns HTTP 429 (rate limit), the proxy waits the full 30s timeout instead of reading the response immediately. The 429 response body is small and arrives instantly, but the proxy's stream handling doesn't detect the completed response.

## Design

### Fix 1: Destroy undici body on all error paths (proxy.ts)

Track the undici response body and destroy it alongside PassThrough:

```typescript
// After undiciResponse received (~line 466):
let upstreamBody = undiciResponse.body;

// Body stall (~line 484):
passThrough.destroy(new Error(stallMsg));
upstreamBody?.destroy(new Error(stallMsg));

// Body stall re-armed (~line 499):
passThrough.destroy(new Error(stallMsg));
upstreamBody?.destroy(new Error(stallMsg));

// External abort (~line 449):
upstreamBody?.destroy(new Error("Cancelled"));
```

### Fix 2: Reliable daemon shutdown (daemon.ts)

In `stopDaemon()`:

1. Read both monitor PID and worker PID files
2. Kill worker FIRST (it holds the connection pool and port)
3. Then kill monitor
4. Use `kill(-pgid, signal)` on POSIX for process group kill
5. Verify both PIDs are dead before returning success

In `killProcessTree()`:

1. Find child processes via `pgrep -P`
2. Kill entire process group, not just individual PIDs

### Fix 3: Prevent duplicate workers (monitor.ts)

In `spawnDaemon()`:

1. Check if port 3456 is already in use before spawning
2. If port is taken, log error and don't spawn (don't create zombie workers)

### Fix 4: Read 429 responses immediately (proxy.ts)

When upstream returns 429, the response is complete (small JSON body). The stall timer should not apply to non-streaming error responses. Detect 4xx/5xx status codes after TTFB and read the body immediately instead of piping through the stall-detection PassThrough.

## Files to Modify

1. **`src/proxy.ts`** -- Destroy undici body on error paths; handle 429 immediately
2. **`src/daemon.ts`** -- Fix stopDaemon() and killProcessTree() for reliable shutdown
3. **`src/monitor.ts`** -- Prevent duplicate worker spawning; check port before spawn
4. **`tests/`** -- Tests for connection cleanup and shutdown reliability

## Testing Strategy

1. Unit test: Mock upstream that sends TTFB then stalls -> verify connection destroyed
2. Unit test: Mock abort signal -> verify body cleanup
3. Integration test: Kill upstream mid-stream -> verify next request succeeds
4. Integration test: `modelweaver stop && start` -> verify no orphaned processes
5. Integration test: Simulate 429 -> verify immediate response (not 30s wait)
