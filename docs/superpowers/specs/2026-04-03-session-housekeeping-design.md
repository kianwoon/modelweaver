# Session Housekeeping Design

**Date:** 2026-04-03
**Status:** Approved

## Problem

1. Sessions from dead Claude Code processes linger too long, consuming connections
2. Reload/stop drops all session connections without draining
3. No visibility into which sessions are active, their idle time, or provider usage
4. Current 2-min idle TTL is too aggressive — active-but-paused sessions get reconnected unnecessarily

## Solution

Three targeted changes to `SessionAgentPool` and `server.ts`:

### 1. Increase Idle TTL to 10 Minutes

- **`SESSION_IDLE_TTL_MS`**: `120_000` → `600_000` (10 min)
- **Sweep interval**: keep at 60s (checks are cheap — just Map iteration)
- **Make TTL configurable** via optional `sessionIdleTtlMs` field in YAML config (Zod schema in `src/config.ts`)
- Pass through as constructor option to `SessionAgentPool` with 10min default

### 2. Synchronous Drain on Reload/Stop

- Add `await sessionPool.closeAll()` to the existing shutdown handler in `src/index.ts` (line ~505), alongside the existing `handle.closeAgents()` call
- This covers both SIGTERM (reload) and SIGINT (Ctrl-C) since the handler is shared
- `closeAll()` already exists — no new function needed
- Session connections drain concurrently with in-flight request drain (10s timeout)

### 3. Session Visibility via `/api/sessions`

- Add `getStats(): SessionStats[]` method to `SessionAgentPool`
- Returns per-session data: `{ id, providerCount, lastActivity (ISO), idleMs, providers[] }`
- Update `GET /api/sessions` endpoint to include the `sessions` array alongside existing `activeSessions` count

## Files Changed

| File | Change |
|------|--------|
| `src/session-pool.ts` | Increase TTL default, accept TTL via constructor, add `getStats()` method |
| `src/config.ts` | Add `sessionIdleTtlMs` to config schema |
| `src/server.ts` | Wire TTL config to `SessionAgentPool`, update `/api/sessions` endpoint |
| `src/index.ts` | Add `sessionPool.closeAll()` to shutdown handler |

## API Response Example

```json
{
  "activeSessions": 2,
  "sessions": [
    {
      "id": "sess_abc123",
      "providerCount": 2,
      "lastActivity": "2026-04-03T10:30:00Z",
      "idleMs": 45000,
      "providers": ["anthropic", "openai"]
    },
    {
      "id": "sess_def456",
      "providerCount": 1,
      "lastActivity": "2026-04-03T10:25:00Z",
      "idleMs": 305000,
      "providers": ["anthropic"]
    }
  ]
}
```

## Out of Scope

- Client-side heartbeat mechanism (requires Claude Code changes)
- Connection health checks / stale H2 detection
- GUI changes for session display
- Session rate limiting or max session caps
