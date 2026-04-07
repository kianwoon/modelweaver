<p align="center">
  <img src="gui/icons/icon.png" alt="ModelWeaver" width="96" />
</p>

# ModelWeaver

Multi-provider LLM proxy for Claude Code. Route different agent roles to different model providers with automatic fallback, racing, circuit breakers, and a native desktop GUI.

[![CI](https://github.com/kianwoon/modelweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/kianwoon/modelweaver/actions/workflows/ci.yml) [![CodeQL](https://github.com/kianwoon/modelweaver/actions/workflows/codeql.yml/badge.svg)](https://github.com/kianwoon/modelweaver/actions/workflows/codeql.yml) [![Release](https://github.com/kianwoon/modelweaver/actions/workflows/release.yml/badge.svg)](https://github.com/kianwoon/modelweaver/actions/workflows/release.yml) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0) [![npm](https://img.shields.io/npm/v/@kianwoon/modelweaver)](https://www.npmjs.com/package/@kianwoon/modelweaver) [![GitHub stars](https://img.shields.io/github/stars/kianwoon/modelweaver?style=social)](https://github.com/kianwoon/modelweaver/stargazers)

<img width="376" height="986" alt="Screenshot 2026-04-06 at 7 31 49 PM" src="https://github.com/user-attachments/assets/7aafc2e2-a358-4fec-bc08-478f68dc24fd" />



## What's New — v0.3.69

- **Smart request routing** — classify message content by complexity and route to the appropriate model tier automatically (#97)
- **Session pool timer leak fix** — `closeAll()` now clears the `sweepTimer` interval (#199)
- **Tauri GUI crash protection** — defensive `if let` replaces unsafe `.unwrap()` in setup (#200)
- **WS reconnect timer cleanup** — prevent dual polling on reconnect (#198)
- **Monitor signal handler** — defensive exit handler prevents double-signal crashes (#197)
- **Per-model connection pools** — each model gets its own HTTP/2 connection for TCP isolation (#186)
- **GOAWAY-aware retry** — graceful HTTP/2 drain no longer marks pool as "failed" (#188)

[View all releases](https://github.com/kianwoon/modelweaver/releases) · [Full changelog](CHANGELOG.md)

---

## How It Works

ModelWeaver sits between Claude Code and upstream model providers as a local HTTP proxy. It inspects the `model` field in each Anthropic Messages API request and routes it to the best-fit provider.

```
Claude Code  ──→  ModelWeaver  ──→  Anthropic (primary)
                   (localhost)   ──→  OpenRouter (fallback)
                   │
              0. Classify message content → tier override? (smartRouting)
              1. Match exact model name (modelRouting)
              2. Match tier via substring (tierPatterns)
              3. Fallback on 429 / 5xx errors
              4. Race remaining providers on 429
```

## Features

- **Smart request routing** — classify request complexity by message content (regex keyword scoring) and override the model tier automatically
- **Tier-based routing** — route by model family (sonnet/opus/haiku) using substring pattern matching
- **Exact model routing** — route specific model names to dedicated providers (checked first)
- **Automatic fallback** — transparent failover on rate limits (429) and server errors (5xx)
- **Adaptive racing** — on 429, automatically races remaining providers simultaneously
- **Model name rewriting** — each provider in the chain can use a different model name
- **Weighted distribution** — spread traffic across providers by weight percentage
- **Circuit breaker** — per-provider circuit breaker with closed/open/half-open states, prevents hammering unhealthy providers
- **Request hedging** — sends multiple copies when a provider shows high latency variance (CV > 0.5), returns the fastest response
- **TTFB timeout** — fails slow providers before full timeout elapses (configurable per provider)
- **Stall detection** — detects stalled streams and aborts them, triggering fallback
- **Connection pooling** — per-provider undici Agent dispatcher with configurable pool size
- **Per-model connection pools** — isolate HTTP/2 connections per model via `modelPools` config for TCP-level isolation
- **Connection retry** — automatic retry with exponential backoff for stale connections, TTFB timeouts, and GOAWAY drains
- **Session agent pooling** — reuses HTTP/2 agents across requests within the same session for connection affinity
- **Adaptive TTFB** — dynamically adjusts TTFB timeout based on observed latency history
- **GOAWAY-aware retry** — graceful HTTP/2 GOAWAY drain no longer marks pool as "failed"
- **Stream buffering** — optional time-based and size-based SSE buffering (`streamBufferMs`, `streamBufferBytes`)
- **Health scores** — per-provider health scoring based on latency and error rates
- **Provider error tracking** — per-provider error counts with status code breakdown, displayed in GUI in real-time
- **Concurrent limits** — cap concurrent requests per provider
- **Interactive setup wizard** — guided configuration with API key validation, hedging config, and provider editing
- **Config hot-reload** — changes to config file are picked up automatically, no restart needed
- **Daemon mode** — background process with auto-restart, launchd integration, and reload support
- **Desktop GUI** — native Tauri app with real-time progress bars, provider health, error breakdown, and recent request history

## Why ModelWeaver

### Uninterrupted Coding Sessions

Claude Code sessions die when the API returns 429 or 5xx — you lose context, wait, and retry manually. With multiple subagents (Explore, Plan, code review) firing simultaneously, one rate limit can cascade into multiple failed agents.

- **429 → instant race**: Instead of waiting for retry-after, all remaining providers are raced simultaneously. Recovery in <2s vs 30-60s wait.
- **Circuit breaker (3 failures in 60s → open)**: A degraded provider stops receiving traffic within seconds, not minutes. Auto-recovers via half-open probing.
- **Connection retry (exponential backoff, up to 5 retries)**: Stale HTTP/2 connections, TTFB timeouts, and GOAWAY frames are retried transparently before escalating to fallback.
- **Global backoff**: If ALL providers are unhealthy, returns 503 immediately instead of wasting 30+ seconds trying each one sequentially.

### Cost Optimization Without Quality Loss

Running everything through Anthropic API at Tier 1/2 rates gets expensive. A full Claude Code session with multiple subagents can generate 50-100+ API calls.

- **Weighted routing with health blending**: `finalWeight = (1-0.3) * staticWeight + 0.3 * healthScore`. Traffic distribution automatically shifts toward healthier providers when a provider degrades.
- **Tier-based routing**: Haiku-tier Explore agents (cheap, fast) never accidentally hit Opus-tier pricing. Sonnet coding agents don't burn expensive Opus tokens.
- **Model rewriting per provider**: The same `claude-sonnet-4-6` model name can route to different models on different providers — zero config changes in Claude Code.

### Fast Responses Even With Unstable Providers

Some providers have extreme latency variance (CV 1.5-4.0). A request that normally takes 3 seconds might take 30 seconds, freezing your coding session.

- **Request hedging (CV > 0.5 triggers)**: Sends 2-4 copies of the same request simultaneously and returns the fastest response. Production data shows providers with CV 1.5-4.0 benefit significantly from hedging.
- **Adaptive TTFB**: Dynamically adjusts the "time to first byte" timeout based on each provider's observed latency history. No false positives on slow-but-healthy providers, fast failure on stuck ones.
- **Stall detection (default 15s)**: If a streaming response stops sending data mid-stream, it aborts and falls back immediately.
- **Health-score reordering**: Providers with health scores below 0.5 are deprioritized to the end of fallback chains automatically. Score = `0.7 * successRate + 0.3 * latencyScore` (5-minute rolling window).
- **Session agent pooling**: Reuses HTTP/2 connections across requests within the same session. Eliminates TCP+TLS handshake overhead per request — critical when subagents fire 10+ requests in rapid succession.

### Operational Visibility

When coding through a proxy, you're normally blind to why responses are slow or failing.

- **Desktop GUI**: Real-time progress bars showing which provider handled each request, response time, and whether hedging fired.
- **Health scores API**: `curl /api/health-scores` shows per-provider scores (0-1). A score of 0.3 means the provider is failing ~50% of requests.
- **Error breakdown**: Per-provider error counts with status code breakdown. Spot patterns (e.g., a provider returning 502s consistently).
- **Circuit breaker state**: See which providers are open/closed/half-open in real-time.

### Zero-Downtime Configuration

- **Hot-reload (300ms debounce)**: Edit `config.yaml` and the daemon picks up changes automatically. No restart, no killed in-flight requests.
- **SIGHUP reload**: After rebuilding from source, `modelweaver reload` restarts the worker without killing the monitor.

### Summary

| Pain Point | Feature | Advantage |
|---|---|---|
| 429 rate limits kill sessions | Adaptive racing on 429 | <2s recovery vs 30-60s wait |
| Provider downtime | Fallback chains + circuit breaker | Automatic failover, no manual intervention |
| High latency variance | Hedging (CV > 0.5) + adaptive TTFB | 3-5s responses even with 30s tail latency |
| Expensive API bills | Weighted distribution + tier routing | Traffic to cheapest acceptable provider |
| Blind to failures | GUI + health scores + error tracking | Know exactly what's failing and why |
| Stale connections | Connection retry + GOAWAY handling | Transparent recovery, no visible errors |
| Config changes need restart | Hot-reload (300ms debounce) | Change weights mid-session, zero downtime |
| Connection overhead per request | Session agent pooling (HTTP/2 reuse) | Faster sequential requests from subagents |

## Prerequisites

- **Node.js** 20 or later — [Install Node.js](https://nodejs.org)
- `npx` — included with Node.js (no separate install needed)

## Installation

ModelWeaver requires no permanent install — `npx` downloads and runs it on the fly. But if you prefer a global install:

```bash
npm install -g @kianwoon/modelweaver
```

After that, replace `npx @kianwoon/modelweaver` with `modelweaver` (or the shorter `mw`) in all commands below.

## Quick Start

### 1. Run the setup wizard

```bash
npx @kianwoon/modelweaver init
```

The wizard guides you through:
- Selecting from 6 preset providers (Anthropic, OpenRouter, Together AI, GLM/Z.ai, Minimax, Fireworks)
- Testing API keys to verify connectivity
- Setting up model routing tiers and hedging config
- Creating `~/.modelweaver/config.yaml` and `~/.modelweaver/.env`

### 2. Start ModelWeaver

```bash
# Foreground (see logs in terminal)
npx @kianwoon/modelweaver

# Background daemon (auto-restarts on crash)
npx @kianwoon/modelweaver start

# Install as launchd service (auto-start at login)
npx @kianwoon/modelweaver install
```

### 3. Point Claude Code to ModelWeaver

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=unused-but-required
claude
```

## CLI Commands

```bash
npx @kianwoon/modelweaver init              # Interactive setup wizard
npx @kianwoon/modelweaver start             # Start as background daemon
npx @kianwoon/modelweaver stop              # Stop background daemon
npx @kianwoon/modelweaver status            # Show daemon status + service state
npx @kianwoon/modelweaver remove            # Stop daemon + remove PID and log files
npx @kianwoon/modelweaver reload            # Reload daemon worker (after rebuild)
npx @kianwoon/modelweaver install           # Install launchd service (auto-start at login)
npx @kianwoon/modelweaver uninstall         # Uninstall launchd service
npx @kianwoon/modelweaver gui               # Launch desktop GUI (auto-downloads binary)
npx @kianwoon/modelweaver [options]         # Run in foreground
```

### CLI Options

```
  -p, --port <number>      Server port                    (default: from config)
  -c, --config <path>      Config file path               (auto-detected)
  -v, --verbose            Enable debug logging           (default: off)
  -h, --help               Show help
```

### Init Options

```
  --global                 Edit global config only
  --path <file>            Write config to a specific file
```

## Daemon Mode

Run ModelWeaver as a background process that survives terminal closure and auto-recovers from crashes.

```bash
npx @kianwoon/modelweaver start             # Start (forks monitor + daemon)
npx @kianwoon/modelweaver status            # Check if running
npx @kianwoon/modelweaver reload            # Reload worker after rebuild
npx @kianwoon/modelweaver stop              # Graceful stop (SIGTERM → SIGKILL after 5s)
npx @kianwoon/modelweaver remove            # Stop + remove PID file + log file
npx @kianwoon/modelweaver install           # Install launchd service
npx @kianwoon/modelweaver uninstall         # Uninstall launchd service
```

**How it works**: `start` forks a lightweight monitor process that owns the PID file. The monitor spawns the actual daemon worker. If the worker crashes, the monitor auto-restarts it with exponential backoff starting at 500ms (up to 10 attempts). After 60 seconds of stable running, the restart counter resets.

```
modelweaver.pid        → Monitor process (handles signals, watches child)
  └── modelweaver.worker.pid → Daemon worker (runs HTTP server)
```

**Files**:
- `~/.modelweaver/modelweaver.pid` — monitor PID
- `~/.modelweaver/modelweaver.worker.pid` — worker PID
- `~/.modelweaver/modelweaver.log` — daemon output log

## Desktop GUI

ModelWeaver ships a native desktop GUI built with Tauri. No Rust toolchain needed — the binary is auto-downloaded from GitHub Releases.

```bash
npx @kianwoon/modelweaver gui
```

First run downloads the latest binary for your platform (~10-30 MB). Subsequent launches use the cached version.

**GUI features:**
- Real-time progress bars with provider name and model info
- Provider health cards with error counts and status code breakdown
- Recent request history sorted by timestamp
- Config validation error banner
- Auto-reconnect on daemon restart

**Supported platforms:**

| Platform | Format |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Linux (x86_64) | `.AppImage` |
| Windows (x86_64) | `.msi` |

**Cached files** are stored in `~/.modelweaver/gui/` with version tracking — new versions download automatically on the next `gui` launch.

## Configuration

### Config file locations

Checked in order (first found wins):
1. `./modelweaver.yaml` (project-local)
2. `~/.modelweaver/config.yaml` (user-global)

### Full config schema

```yaml
server:
  port: 3456                  # Server port          (default: 3456)
  host: localhost             # Bind address         (default: localhost)
  streamBufferMs: 0           # Time-based stream flush threshold  (default: disabled)
  streamBufferBytes: 0        # Size-based stream flush threshold  (default: disabled)
  globalBackoffEnabled: true  # Global backoff on repeated failures (default: true)
  unhealthyThreshold: 0.5     # Health score below which provider is unhealthy (default: 0.5, 0–1)
  maxBodySizeMB: 10           # Max request body size in MB        (default: 10, 1–100)
  sessionIdleTtlMs: 600000    # Session agent pool idle TTL in ms  (default: 600000 / 10min, min: 60000)
  disableThinking: false      # Strip thinking blocks from requests (default: false)

# Adaptive request hedging
hedging:
  speculativeDelay: 500       # ms before starting backup providers  (default: 500)
  cvThreshold: 0.5            # latency CV threshold for hedging    (default: 0.5)
  maxHedge: 4                 # max concurrent copies per request    (default: 4)

providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    apiKey: ${ANTHROPIC_API_KEY}  # Env var substitution
    timeout: 20000                # Request timeout in ms  (default: 20000)
    ttfbTimeout: 8000             # TTFB timeout in ms     (default: 8000)
    stallTimeout: 15000           # Stall detection timeout (default: 15000)
    poolSize: 10                  # Connection pool size   (default: 10)
    concurrentLimit: 10           # Max concurrent requests (default: unlimited)
    connectionRetries: 3          # Retries for stale connections (default: 3, max: 10)
    staleAgentThresholdMs: 30000  # Mark pooled agent stale after idle ms (optional)
    modelPools:                   # Per-model pool size overrides (optional)
      "claude-sonnet-4-20250514": 20
    modelLimits:                  # Per-provider token limits (optional)
      maxOutputTokens: 16384
    authType: anthropic           # "anthropic" | "bearer"  (default: anthropic)
    circuitBreaker:               # Per-provider circuit breaker (optional)
      failureThreshold: 3         # Failures before opening circuit (alias: threshold, default: 3)
      windowSeconds: 60           # Time window for failure count  (default: 60)
      cooldownSeconds: 30         # Cooldown in seconds (alias: cooldown, also in seconds, default: 30)
      rateLimitCooldownSeconds: 10  # Shorter cooldown for 429 rate limits (optional)
  openrouter:
    baseUrl: https://openrouter.ai/api
    apiKey: ${OPENROUTER_API_KEY}
    authType: bearer
    timeout: 60000

# Exact model name routing (checked FIRST, before tier patterns)
modelRouting:
  "glm-5-turbo":
    - provider: anthropic
  "MiniMax-M2.7":
    - provider: openrouter
      model: minimax/MiniMax-M2.7        # With model name rewrite
  # Weighted distribution example:
  # "claude-sonnet-4":
  #   - provider: anthropic
  #     weight: 70
  #   - provider: openrouter
  #     weight: 30

# Tier-based routing (fallback chain)
routing:
  sonnet:
    - provider: anthropic
      model: claude-sonnet-4-20250514      # Optional: rewrite model name
    - provider: openrouter
      model: anthropic/claude-sonnet-4      # Fallback
  opus:
    - provider: anthropic
      model: claude-opus-4-20250514
  haiku:
    - provider: anthropic
      model: claude-haiku-4-5-20251001

# Pattern matching: model name includes any string → matched to tier
tierPatterns:
  sonnet: ["sonnet", "3-5-sonnet", "3.5-sonnet"]
  opus: ["opus", "3-opus", "3.5-opus"]
  haiku: ["haiku", "3-haiku", "3.5-haiku"]

# Smart request routing — classify message content and override model tier
# When enabled, analyzes the last user message against regex patterns.
# If cumulative score >= escalationThreshold, routes to the classified tier
# instead of the model requested. Disabled by default.
# smartRouting:
#   enabled: true
#   escalationThreshold: 2    # minimum score to trigger tier override
#   patterns:
#     "1":                     # Tier 1 — best model (e.g., opus-tier)
#       - pattern: "architect|design system|from scratch"
#         score: 3
#       - pattern: "debug|troubleshoot|investigate|root cause"
#         score: 2
#     "2":                     # Tier 2 — good model (e.g., sonnet-tier)
#       - pattern: "explain|summarize|compare"
#         score: 2
#       - pattern: "write.*test|refactor|review"
#         score: 2
# Requires matching routing entries: routing.tier1, routing.tier2 (tier3 optional)
# Graceful degradation: if classified tier has no providers, tries next tier down
```

### Routing priority

1. **Smart content routing** (`smartRouting`) — if enabled and message content matches classification patterns, override to the classified tier (bypasses all other routing)
2. **Exact model name** (`modelRouting`) — if the request model matches exactly, use that route
3. **Weighted distribution** — if the model has `weight` entries, requests are distributed across providers proportionally
4. **Tier pattern** (`tierPatterns` + `routing`) — substring match the model name against patterns, then use the tier's provider chain
5. **No match** — returns 502 with a descriptive error listing configured tiers and model routes

### Provider chain behavior

- **First provider is primary**, rest are fallbacks
- **Fallback triggers** on: 429 (rate limit), 5xx (server error), network timeout, stream stall
- **Adaptive race mode** — when a 429 is received, remaining providers are raced simultaneously (not sequentially) for faster recovery
- **Circuit breaker** — providers that repeatedly fail are temporarily skipped (auto-recovers after cooldown, configurable window)
- **No fallback on**: 4xx (bad request, auth failure, forbidden) — returned immediately
- **Model rewriting**: each provider entry can override the `model` field in the request body

### Supported providers

| Provider | Auth Type | Base URL |
|---|---|---|
| Anthropic | `x-api-key` | `https://api.anthropic.com` |
| OpenRouter | Bearer | `https://openrouter.ai/api` |
| Together AI | Bearer | `https://api.together.xyz` |
| GLM (Z.ai) | `x-api-key` | `https://api.z.ai/api/anthropic` |
| Minimax | `x-api-key` | `https://api.minimax.io/anthropic` |
| Fireworks | Bearer | `https://api.fireworks.ai/inference/v1` |

Any OpenAI/Anthropic-compatible API works — just set `baseUrl` and `authType` appropriately.

### Config hot-reload

In daemon mode, ModelWeaver watches the config file for changes and reloads automatically (debounced 300ms). You can also send a manual reload signal:

```bash
kill -SIGHUP $(cat ~/.modelweaver/modelweaver.pid)
```

Or use the CLI:

```bash
npx @kianwoon/modelweaver reload
```

Re-running `npx @kianwoon/modelweaver init` also signals the running daemon to reload.

## API

### Health check

```bash
curl http://localhost:3456/api/status
```

Returns circuit breaker state for all providers and server uptime.

### Version

```bash
curl http://localhost:3456/api/version
```

Returns the running ModelWeaver version.

### Connection pool status

```bash
curl http://localhost:3456/api/pool
```

Returns active connection pool state for all providers.

### Health scores

```bash
curl http://localhost:3456/api/health-scores
```

Returns per-provider health scores based on latency and error rates.

### Session pool status

```bash
curl http://localhost:3456/api/sessions
```

Returns session agent pool statistics.

## Observability

```bash
# Aggregated request metrics (by model, provider, error type)
curl http://localhost:3456/api/metrics/summary

# Per-provider circuit breaker state
curl http://localhost:3456/api/circuit-breaker

# Hedging win/loss statistics
curl http://localhost:3456/api/hedging/stats
```

## How Claude Code Uses Model Tiers

Claude Code sends different model names for different agent roles:

| Agent Role | Model Tier | Typical Model Name |
|---|---|---|
| Main conversation, coding | Sonnet | `claude-sonnet-4-20250514` |
| Explore (codebase search) | Haiku | `claude-haiku-4-5-20251001` |
| Plan (analysis) | Sonnet | `claude-sonnet-4-20250514` |
| Complex subagents | Opus | `claude-opus-4-20250514` |
| GLM/Z.ai models | Exact routing | `glm-5-turbo` |
| MiniMax models | Exact routing | `MiniMax-M2.7` |

ModelWeaver uses the model name to determine which agent tier is calling, then routes accordingly.

## Development

```bash
npm install          # Install dependencies
npm test             # Run tests (307 tests)
npm run build        # Build for production (tsup)
npm run dev          # Run in dev mode (tsx)
```

## License

Apache-2.0
