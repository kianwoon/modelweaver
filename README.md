<p align="center">
  <img src="gui/icons/icon.png" alt="ModelWeaver" width="96" />
</p>

# ModelWeaver

Multi-provider model orchestration proxy for Claude Code. Route different agent roles to different model providers with automatic fallback, exact model routing, config hot-reload, and crash recovery.

[![CI](https://github.com/kianwoon/modelweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/kianwoon/modelweaver/actions/workflows/ci.yml) [![CodeQL](https://github.com/kianwoon/modelweaver/actions/workflows/codeql.yml/badge.svg)](https://github.com/kianwoon/modelweaver/actions/workflows/codeql.yml) [![Release](https://github.com/kianwoon/modelweaver/actions/workflows/release.yml/badge.svg)](https://github.com/kianwoon/modelweaver/actions/workflows/release.yml) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0) [![GitHub stars](https://img.shields.io/github/stars/kianwoon/modelweaver?style=social)](https://github.com/kianwoon/modelweaver/stargazers)


<img width="358" height="479" alt="Screenshot 2026-03-20 at 5 11 55 AM" src="https://github.com/user-attachments/assets/a973a707-0cd7-4701-8d19-f6cd028f6c56" />


## How It Works

ModelWeaver sits between Claude Code and upstream model providers as a local HTTP proxy. It inspects the `model` field in each Anthropic Messages API request and routes it to the best-fit provider.

```
Claude Code  ──→  ModelWeaver  ──→  Anthropic (primary)
                   (localhost)   ──→  OpenRouter (fallback)
                   │
              1. Match exact model name (modelRouting)
              2. Match tier via substring (tierPatterns)
              3. Fallback on 429 / 5xx errors
```

## Features

- **Tier-based routing** — route by model family (sonnet/opus/haiku) using substring pattern matching
- **Exact model routing** — route specific model names to dedicated providers (checked first)
- **Automatic fallback** — transparent failover on rate limits (429) and server errors (5xx)
- **Model name rewriting** — each provider in the chain can use a different model name
- **Interactive setup wizard** — guided configuration with API key validation
- **Config hot-reload** — changes to config file are picked up automatically, no restart needed
- **Daemon mode** — run as a background process with start/stop/status/remove commands
- **Crash recovery** — auto-restarts on crash with rate limiting (max 5 restarts/60s)
- **Multiple auth types** — supports `x-api-key` (Anthropic) and `Bearer` token auth
- **Per-provider timeouts** — configurable timeout with AbortController
- **Structured logging** — JSON logs with request IDs for tracing
- **Env var substitution** — config references like `${API_KEY}` resolved from environment
- **Circuit breaker** — per-provider circuit breaker with closed/open/half-open states, prevents hammering unhealthy providers
- **Adaptive fallback** — on 429 rate limits, automatically races remaining providers simultaneously instead of sequential fallback
- **Connection pooling** — per-provider undici Agent dispatcher with configurable pool size, closes old agents on config reload
- **Health endpoint** — `/api/status` returns circuit breaker state and uptime
- **Adaptive request hedging** — sends multiple copies of requests when a provider shows high latency variance (CV > 0.5), returns the fastest response
- **TTFB timeout** — fails slow providers before full timeout elapses (configurable per provider)
- **Observability endpoints** — `/api/metrics/summary` (aggregated stats), `/api/circuit-breaker` (per-provider state), `/api/hedging/stats` (hedge win/loss)
- **Weighted distribution** — route to multiple providers simultaneously with weight-based distribution
- **Desktop GUI** — native app with one-command launch (`modelweaver gui`), auto-downloads from GitHub Releases

## Prerequisites

- **Node.js** 20 or later — [Install Node.js](https://nodejs.org)
- `npx` — included with Node.js (no separate install needed)

## Installation

ModelWeaver requires no permanent install — `npx` downloads and runs it on the fly. But if you prefer a global install:

```bash
npm install -g @kianwoon/modelweaver
```

After that, replace `npx @kianwoon/modelweaver` with `modelweaver` in all commands below.

## Quick Start

### 1. Run the setup wizard

```bash
npx @kianwoon/modelweaver init
```

The wizard guides you through:
- Selecting from 6 preset providers (Anthropic, OpenRouter, Together AI, GLM/Z.ai, Minimax, Fireworks)
- Testing API keys to verify connectivity
- Setting up model routing tiers
- Creating `~/.modelweaver/config.yaml` and `~/.modelweaver/.env` for configuration

### 2. Start ModelWeaver

```bash
# Foreground (see logs in terminal)
npx @kianwoon/modelweaver

# Background daemon (auto-restarts on crash)
npx @kianwoon/modelweaver start
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
npx @kianwoon/modelweaver status            # Show daemon status
npx @kianwoon/modelweaver remove            # Stop daemon + remove PID and log files
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

## Daemon Mode

Run ModelWeaver as a background process that survives terminal closure and auto-recovers from crashes.

```bash
npx @kianwoon/modelweaver start             # Start (forks monitor + daemon)
npx @kianwoon/modelweaver status            # Check if running
npx @kianwoon/modelweaver stop               # Graceful stop (SIGTERM → SIGKILL after 5s)
npx @kianwoon/modelweaver remove             # Stop + remove PID file + log file
```

**How it works**: `start` forks a lightweight monitor process that owns the PID file. The monitor spawns the actual daemon worker. If the worker crashes, the monitor auto-restarts it after a 2-second delay (up to 5 restarts per 60-second window to prevent crash loops).

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

providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    apiKey: ${ANTHROPIC_API_KEY}  # Env var substitution
    timeout: 30000                # Request timeout in ms  (default: 30000)
    ttfbTimeout: 15000            # TTFB timeout in ms (default: 15000)
    poolSize: 10                  # Connection pool size (default: varies by provider)
    authType: anthropic           # "anthropic" | "bearer"  (default: anthropic)
    circuitBreaker:               # Per-provider circuit breaker
      threshold: 5                # Failures before opening circuit (default: 5)
      cooldown: 30000             # Cooldown before half-open (default: 30000ms)
    concurrentLimit: 10           # Max concurrent requests (default: unlimited)
  openrouter:
    baseUrl: https://openrouter.ai/api
    apiKey: ${OPENROUTER_API_KEY}
    authType: bearer
    timeout: 60000

# Tier-based routing (substring pattern matching)
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

# Exact model name routing (checked FIRST, before tier patterns)
modelRouting:
  "glm-5-turbo":
    - provider: anthropic               # Route to specific provider
  "MiniMax-M2.7":
    - provider: openrouter
      model: minimax/MiniMax-M2.7        # With model name rewrite
```

### Routing priority

1. **Exact model name** (`modelRouting`) — if the request model matches exactly, use that route
2. **Weighted distribution** — if the model has `weight` entries, requests are distributed across providers proportionally
3. **Tier pattern** (`tierPatterns` + `routing`) — substring match the model name against patterns, then use the tier's provider chain
4. **No match** — returns 502 with a descriptive error listing configured tiers and model routes

### Provider chain behavior

- **First provider is primary**, rest are fallbacks
- **Fallback triggers** on: 429 (rate limit), 5xx (server error), network timeout
- **Adaptive race mode** — when a 429 is received, remaining providers are raced simultaneously (not sequentially) for faster recovery
- **Circuit breaker** — providers that repeatedly fail are temporarily skipped (auto-recovers after cooldown)
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

Or just re-run `npx @kianwoon/modelweaver init` — it automatically signals the running daemon to reload.

## API

### Health check

```bash
curl http://localhost:3456/api/status
```

Returns circuit breaker state for all providers and server uptime.

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
npm test             # Run tests (205 tests)
npm run build        # Build for production (tsup)
npm run dev          # Run in dev mode (tsx)
```

## License

Apache-2.0
