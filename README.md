# ModelWeaver

[![CI](https://github.com/kianwoon/modelweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/kianwoon/modelweaver/actions/workflows/ci.yml)
[![CodeQL](https://github.com/kianwoon/modelweaver/actions/workflows/codeql.yml/badge.svg)](https://github.com/kianwoon/modelweaver/actions/workflows/codeql.yml)
[![Release](https://github.com/kianwoon/modelweaver/actions/workflows/release.yml/badge.svg)](https://github.com/kianwoon/modelweaver/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub stars](https://img.shields.io/github/stars/kianwoon/modelweaver?style=social)](https://github.com/kianwoon/modelweaver/stargazers)

Multi-provider model orchestration proxy for Claude Code. Route different agent roles (planning, coding, research, review) to different model providers with automatic fallback, exact model routing, config hot-reload, and crash recovery.

<img width="357" height="476" alt="Screenshot 2026-03-20 at 4 13 13 AM" src="https://github.com/user-attachments/assets/94293920-d9ee-481d-87f7-2f4ca506a162" />


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
- **Desktop GUI** — native app with one-command launch (`modelweaver gui`), auto-downloads from GitHub Releases

## Quick Start

### 1. Run the setup wizard

```bash
npx modelweaver init
```

The wizard guides you through:
- Selecting from 6 preset providers (Anthropic, OpenRouter, Together AI, GLM/Z.ai, Minimax, Fireworks)
- Testing API keys to verify connectivity
- Setting up model routing tiers
- Auto-configuring `~/.claude/settings.json` for Claude Code integration

### 2. Start ModelWeaver

```bash
# Foreground (see logs in terminal)
npx modelweaver

# Background daemon (auto-restarts on crash)
npx modelweaver start
```

### 3. Point Claude Code to ModelWeaver

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=unused-but-required
claude
```

## CLI Commands

```bash
npx modelweaver init              # Interactive setup wizard
npx modelweaver start             # Start as background daemon
npx modelweaver stop              # Stop background daemon
npx modelweaver status            # Show daemon status
npx modelweaver remove            # Stop daemon + remove PID and log files
npx modelweaver gui               # Launch desktop GUI (auto-downloads binary)
npx modelweaver [options]         # Run in foreground
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
npx modelweaver start             # Start (forks monitor + daemon)
npx modelweaver status            # Check if running
npx modelweaver stop               # Graceful stop (SIGTERM → SIGKILL after 5s)
npx modelweaver remove             # Stop + remove PID file + log file
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
npx modelweaver gui
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
    authType: anthropic           # "anthropic" | "bearer"  (default: anthropic)
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
2. **Tier pattern** (`tierPatterns` + `routing`) — substring match the model name against patterns, then use the tier's provider chain
3. **No match** — returns 502 with a descriptive error listing configured tiers and model routes

### Provider chain behavior

- **First provider is primary**, rest are fallbacks
- **Fallback triggers** on: 429 (rate limit), 5xx (server error), network timeout
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
kill -SIGUSR1 $(cat ~/.modelweaver/modelweaver.pid)
```

Or just re-run `npx modelweaver init` — it automatically signals the running daemon to reload.

## How Claude Code Uses Model Tiers

Claude Code sends different model names for different agent roles:

| Agent Role | Model Tier | Typical Model Name |
|---|---|---|
| Main conversation, coding | Sonnet | `claude-sonnet-4-20250514` |
| Explore (codebase search) | Haiku | `claude-haiku-4-5-20251001` |
| Plan (analysis) | Sonnet | `claude-sonnet-4-20250514` |
| Complex subagents | Opus | `claude-opus-4-20250514` |

ModelWeaver uses the model name to determine which agent tier is calling, then routes accordingly.

## Development

```bash
npm install          # Install dependencies
npm test             # Run tests (113 tests)
npm run build        # Build for production (tsup)
npm run dev          # Run in dev mode (tsx)
```

## License

Apache-2.0
