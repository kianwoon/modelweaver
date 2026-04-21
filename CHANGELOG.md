# Changelog

All notable changes to ModelWeaver.

## [v0.3.83] — 2026-04-22

### Fixes

- **Empty response detection** — detect upstream `end_turn` responses with 0 output tokens and no content, then trigger fallback retry with the next provider in the chain (#248)
- **Context trim duplicate instruction** — prevent injecting duplicate system instructions when the original task instruction is already present after trimming (#247)
- **Accurate needsInstruction check** — fix `needsInstruction` to correctly detect when synthetic SSE events lack the `input_tokens` field (#247)

## [v0.3.82] — 2026-04-21

### Fixes

- **Hint boundary alignment** — ensure continuation hints are injected at the correct message boundary, not mid-conversation (#247)
- **Fallback on trim failure** — if context trimming produces an invalid message array, fall back to the original untrimmed messages (#247)

## [v0.3.81] — 2026-04-20

### Fixes

- **5 context trimming bugfixes** — fix off-by-one message boundary, preserve `tool_result` pairs, handle empty message arrays, prevent trimming during streaming, and validate message role sequences (#246)

## [v0.3.80] — 2026-04-19

### Fixes

- **Skip context trim during active tool chains** — avoid trimming conversation history while a multi-step tool chain is in progress, preventing broken `tool_use`→`tool_result` sequences (#245)

## [v0.3.79] — 2026-04-18

### Fixes

- **Inject continuation hint on trim** — when context is trimmed, inject a synthetic assistant message hinting the model to continue, preventing agent stalls from lost conversation state (#244)

## [v0.3.78] — 2026-04-17

### Features

- **Turn-aware context trimming** — trim context at conversation turn boundaries instead of arbitrary message counts, preserving complete `user`/`assistant` exchanges and `tool_use`/`tool_result` pairs (#243)

## [v0.3.77] — 2026-04-16

### Fixes

- **Preserve original task instruction** — when trimming context, keep the original task/system instruction at the top of the message array instead of losing it (#242)

## [v0.3.76] — 2026-04-15

### Fixes

- **Safe message boundary alignment** — ensure context trimming cuts at valid message boundaries (always after an `assistant` turn), preventing malformed request arrays (#241)

## [v0.3.75] — 2026-04-14

### Features

- **Per-provider context message trimming** �� new `maxContextMessages` provider option limits outgoing conversation history to the most recent N messages, reducing token waste on long sessions (#239)

### Fixes

- **Stream state race** — fix truncated responses when using OpenAI-compatible upstream providers caused by eager Transform streams
- **Versioned URL construction** — OpenAI adapter handles versioned base URLs (e.g., `/v4`) without double-prefixing

## [v0.3.69] — 2026-04-07

### Features

- **Smart request-to-model-tier classification** — keyword-scoring classifier routes requests to appropriate model tiers based on message content complexity. Configurable via `smartRouting` config with regex patterns and score thresholds (#97)
- **Configurable connection retries** — new `connectionRetries` provider option (default: 5) with separate TTFB retry cap (#188)
- **Configurable stale agent threshold** — new `staleAgentThresholdMs` provider option (default: 30000ms) for session pool agent freshness (#188)

### Fixes

- **GUI build cache invalidation** — added `cargo:rerun-if-changed` directives to `gui/build.rs` to prevent stale frontend blobs without requiring `cargo clean` (#208)

## [v0.3.68] — 2026-04-07

### Docs

- **README polish** — added "Why ModelWeaver" section with developer advantage analysis (#205)
- **"What's New" section** — added changelog highlights to README header (#204)

## [v0.3.67] — 2026-04-07

### Fixes

- **Session pool timer leak** — `closeAll()` now clears the `sweepTimer` interval, preventing accumulated timers during hot-reload cycles (#199)
- **Tauri GUI panic protection** — replaced unsafe `.unwrap()` calls in setup with defensive `if let` + `let _ =`, preventing GUI crashes when the webview window isn't ready (#200)
- **WS reconnect timer cleanup** — clear stale `reconnectTimer` in WebSocket close handler to prevent dual polling (#198)
- **Monitor exit handler** — add defensive exit handler in SIGTERM/SIGINT to prevent double-signal crashes (#197)
- **Session pool hot-reload** — update pool TTL and stale threshold on config hot-reload (#191)
- **setMaxListeners guard** — floor decrement to prevent negative values (#190)
- **Daemon shutdown** — call `destroy()` on shutdown and remove dead `gui` field from `parseArgs` (#189)
- **GUI stats bar** — fix missing cache tokens and precision loss in stats display (#187)

## [v0.3.66] — 2026-04-06

### Fixes

- **GOAWAY code 0 discrimination** — graceful HTTP/2 drain no longer marks pool as "failed" (#188)
- **Configurable stale agent threshold** — raised default from 10s to 30s, matching keepAliveTimeout to stop the evict-cold-start-slow-TTFB churn loop (#188)
- **TTFB retry cap** — TTFB timeouts capped at 2 retries (vs 5 for socket errors), reducing worst-case from 360s to 180s per provider (#188)

## [v0.3.65] — 2026-04-06

### Features

- **Per-model connection pool isolation** — each model gets its own `undici.Agent`, preventing TCP contention between concurrent streams. New `modelPools` config schema with per-model breakdown in pool stats (#186)

## [v0.3.64] — 2026-04-05

### Fixes

- **TTFB timeout floor** — respect configured `ttfbTimeout` as minimum, not ceiling. Adaptive TTFB was clamping user-configured timeouts down to observed p95

## [v0.3.63] — 2026-04-05

### Features

- **Upstream keep-alive sync** — sync upstream keep-alive timeouts with server-side settings for consistent connection management

## [v0.3.62] — 2026-04-04

### Features

- **Claude Code timeout optimization** — optimize connection timeouts for maximum performance with Claude Code sessions

### Fixes

- **Header forwarding revert** — restore allowlist header forwarding; denylist caused ZlibError in some providers
- **User-agent forwarding** — forward user-agent header to upstream providers

## [v0.3.61] — 2026-04-03

### Features

- **Header denylist** — denylist header forwarding with metrics tee on SSE stream

### Fixes

- **Graceful SSE termination** — handle abort signals cleanly, remove dead stream modification code
- **Pure passthrough** — strip all stream modification from both proxy and server
- **Thinking block rewrite** — rewrite thinking blocks instead of dropping, preserving SDK index continuity

## [v0.3.60] — 2026-04-02

### Features

- **Activity progress bar UX** — improved GUI progress bar experience

## [v0.3.59] — 2026-04-01

### Fixes

- **Y8.content crash prevention** — event-level thinking block filter and null object sanitization in SSE stream
- **HTTP/2 streaming reliability** — null object sanitization for robust streaming

## [v0.3.58] — 2026-03-31

### Features

- **Per-model session connections** — dedicated HTTP/2 connections per model for session isolation (#180)

## [v0.3.57] — 2026-03-30

### Fixes

- **Hedge cancellation** — suppress "socket closed unexpectedly" on hedge cancellation
- **Circuit breaker** — fix false positives and health probe bugs (#179)

## [v0.3.56] — 2026-03-29

### Fixes

- **Config validation** — allow `weight: 0` as "disabled" sentinel with warning; reject in distribution round-robin (#175)
- **Stream state isolation** — isolate stream state per hedge copy to prevent shared mutable race (#174)
- **Duplicate event elimination** — remove duplicate SSE events from proxy pipeline

## [v0.3.55] — 2026-03-28

### Fixes

- **Config hot-reload** — live config reload without restart
- **SSE event dedup** — eliminate duplicate events in server-sent event stream

---

## [v0.3.38] — 2026-03-15

### New Features

- **Config file location choice** — Wizard init now supports project-level `./modelweaver.yaml` with routing-only overlays. Auto-detects existing configs and offers menu choice. Added `--global`/`--path` flags to `init` subcommand. Config loading merges project `modelRouting` over global config. (#94)

### Bug Fixes

- **Stream state machine race conditions** (#98, #99) — Replaced `setInterval` stall poll with one-shot `setTimeout`. Added `_stallFired` guard to prevent `handleStall` re-entry. `nextState()` now rejects invalid transitions instead of allowing them. Terminal state guards in all `setImmediate` blocks in `server.ts` and data handler.
- **Daemon log-analysis bugs** (#82) — Fixed circuit-breaker test assertions for 401 counting. Fixed hot-reload test to await async `setConfig`.
- **4 verified daemon issues** (#93) — Fixed agent leaks on config errors and hot-reload races. Optimized metrics prune with incremental min-key tracking. Resolved spurious `start→start` and `streaming→streaming` state warnings. Fixed cache clearing order during config swap.
- **GUI progress bar stall** — Fixed dismissal with CSS `transitionend` + fallback. Added `complete`/`error` WebSocket events for timeout and error paths. Removed `MAX_VISIBLE_BARS` cap.
- **GUI recent requests** — Sort by timestamp (newest first).

[Full Changelog](https://github.com/kianwoon/modelweaver/compare/v0.3.35...v0.3.67)
