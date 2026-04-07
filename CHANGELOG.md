# Changelog

All notable changes to ModelWeaver.

## [v0.3.67] — 2025-04-07

### Fixes

- **Session pool timer leak** — `closeAll()` now clears the `sweepTimer` interval, preventing accumulated timers during hot-reload cycles (#199)
- **Tauri GUI panic protection** — replaced unsafe `.unwrap()` calls in setup with defensive `if let` + `let _ =`, preventing GUI crashes when the webview window isn't ready (#200)
- **WS reconnect timer cleanup** — clear stale `reconnectTimer` in WebSocket close handler to prevent dual polling (#198)
- **Monitor exit handler** — add defensive exit handler in SIGTERM/SIGINT to prevent double-signal crashes (#197)
- **Session pool hot-reload** — update pool TTL and stale threshold on config hot-reload (#191)
- **setMaxListeners guard** — floor decrement to prevent negative values (#190)
- **Daemon shutdown** — call `destroy()` on shutdown and remove dead `gui` field from `parseArgs` (#189)
- **GUI stats bar** — fix missing cache tokens and precision loss in stats display (#187)

## [v0.3.66] — 2025-04-06

### Fixes

- **GOAWAY code 0 discrimination** — graceful HTTP/2 drain no longer marks pool as "failed" (#188)
- **Configurable stale agent threshold** — raised default from 10s to 30s, matching keepAliveTimeout to stop the evict-cold-start-slow-TTFB churn loop (#188)
- **TTFB retry cap** — TTFB timeouts capped at 2 retries (vs 5 for socket errors), reducing worst-case from 360s to 180s per provider (#188)

## [v0.3.65] — 2025-04-06

### Features

- **Per-model connection pool isolation** — each model gets its own `undici.Agent`, preventing TCP contention between concurrent streams. New `modelPools` config schema with per-model breakdown in pool stats (#186)

## [v0.3.64] — 2025-04-05

### Fixes

- **TTFB timeout floor** — respect configured `ttfbTimeout` as minimum, not ceiling. Adaptive TTFB was clamping user-configured timeouts down to observed p95

## [v0.3.63] — 2025-04-05

### Features

- **Upstream keep-alive sync** — sync upstream keep-alive timeouts with server-side settings for consistent connection management

## [v0.3.62] — 2025-04-04

### Features

- **Claude Code timeout optimization** — optimize connection timeouts for maximum performance with Claude Code sessions

### Fixes

- **Header forwarding revert** — restore allowlist header forwarding; denylist caused ZlibError in some providers
- **User-agent forwarding** — forward user-agent header to upstream providers

## [v0.3.61] — 2025-04-03

### Features

- **Header denylist** — denylist header forwarding with metrics tee on SSE stream

### Fixes

- **Graceful SSE termination** — handle abort signals cleanly, remove dead stream modification code
- **Pure passthrough** — strip all stream modification from both proxy and server
- **Thinking block rewrite** — rewrite thinking blocks instead of dropping, preserving SDK index continuity

## [v0.3.60] — 2025-04-02

### Features

- **Activity progress bar UX** — improved GUI progress bar experience

## [v0.3.59] — 2025-04-01

### Fixes

- **Y8.content crash prevention** — event-level thinking block filter and null object sanitization in SSE stream
- **HTTP/2 streaming reliability** — null object sanitization for robust streaming

## [v0.3.58] — 2025-03-31

### Features

- **Per-model session connections** — dedicated HTTP/2 connections per model for session isolation (#180)

## [v0.3.57] — 2025-03-30

### Fixes

- **Hedge cancellation** — suppress "socket closed unexpectedly" on hedge cancellation
- **Circuit breaker** — fix false positives and health probe bugs (#179)

## [v0.3.56] — 2025-03-29

### Fixes

- **Config validation** — allow `weight: 0` as "disabled" sentinel with warning; reject in distribution round-robin (#175)
- **Stream state isolation** — isolate stream state per hedge copy to prevent shared mutable race (#174)
- **Duplicate event elimination** — remove duplicate SSE events from proxy pipeline

## [v0.3.55] — 2025-03-28

### Fixes

- **Config hot-reload** — live config reload without restart
- **SSE event dedup** — eliminate duplicate events in server-sent event stream

---

## [v0.3.38] — 2025-03-15

### New Features

- **Config file location choice** — Wizard init now supports project-level `./modelweaver.yaml` with routing-only overlays. Auto-detects existing configs and offers menu choice. Added `--global`/`--path` flags to `init` subcommand. Config loading merges project `modelRouting` over global config. (#94)

### Bug Fixes

- **Stream state machine race conditions** (#98, #99) — Replaced `setInterval` stall poll with one-shot `setTimeout`. Added `_stallFired` guard to prevent `handleStall` re-entry. `nextState()` now rejects invalid transitions instead of allowing them. Terminal state guards in all `setImmediate` blocks in `server.ts` and data handler.
- **Daemon log-analysis bugs** (#82) — Fixed circuit-breaker test assertions for 401 counting. Fixed hot-reload test to await async `setConfig`.
- **4 verified daemon issues** (#93) — Fixed agent leaks on config errors and hot-reload races. Optimized metrics prune with incremental min-key tracking. Resolved spurious `start→start` and `streaming→streaming` state warnings. Fixed cache clearing order during config swap.
- **GUI progress bar stall** — Fixed dismissal with CSS `transitionend` + fallback. Added `complete`/`error` WebSocket events for timeout and error paths. Removed `MAX_VISIBLE_BARS` cap.
- **GUI recent requests** — Sort by timestamp (newest first).

[Full Changelog](https://github.com/kianwoon/modelweaver/compare/v0.3.35...v0.3.67)
