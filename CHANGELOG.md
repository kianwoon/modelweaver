## What's Changed (v0.3.36 → v0.3.38)

### New Features
- **Config file location choice** — Wizard init now supports project-level `./modelweaver.yaml` with routing-only overlays. Auto-detects existing configs and offers menu choice. Added `--global`/`--path` flags to `init` subcommand. Config loading merges project `modelRouting` over global config. (#94)

### Bug Fixes
- **Stream state machine race conditions** (#98, #99) — Replaced `setInterval` stall poll with one-shot `setTimeout`. Added `_stallFired` guard to prevent `handleStall` re-entry. `nextState()` now rejects invalid transitions instead of allowing them. Terminal state guards in all `setImmediate` blocks in `server.ts` and data handler.
- **Daemon log-analysis bugs** (#82) — Fixed circuit-breaker test assertions for 401 counting. Fixed hot-reload test to await async `setConfig`.
- **4 verified daemon issues** (#93) — Fixed agent leaks on config errors and hot-reload races. Optimized metrics prune with incremental min-key tracking. Resolved spurious `start→start` and `streaming→streaming` state warnings. Fixed cache clearing order during config swap.
- **GUI progress bar stall** — Fixed dismissal with CSS `transitionend` + fallback. Added `complete`/`error` WebSocket events for timeout and error paths. Removed `MAX_VISIBLE_BARS` cap.
- **GUI recent requests** — Sort by timestamp (newest first).

**Full Changelog**: https://github.com/kianwoon/modelweaver/compare/v0.3.35...v0.3.38
