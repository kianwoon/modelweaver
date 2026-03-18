# ModelWeaver Design Specification

**Date**: 2026-03-19
**Status**: Approved
**Scope**: MVP — Core routing only

## Overview

ModelWeaver is a multi-provider model orchestration proxy for Claude Code CLI. It sits between Claude Code and upstream model providers, routing each request to the best-fit provider based on the model tier (sonnet/opus/haiku) extracted from the request's `model` field. It supports automatic fallback chains when providers fail.

## Problem

Claude Code CLI uses a single model provider for all agent roles — planning, coding, research, and review all go through the same provider and model. This forces a one-model-for-everything approach, preventing users from:

- Using cheaper/faster models for lightweight agent tasks (e.g., Haiku for Explore searches)
- Using stronger reasoning models for critical steps (e.g., Opus for complex analysis)
- Falling back to alternative providers during outages or rate limits

## Solution

A local HTTP proxy that:

1. Receives Anthropic Messages API requests from Claude Code
2. Inspects the `model` field to determine the agent tier
3. Routes to the configured provider chain for that tier
4. Forwards the request as-is (no format translation — providers offer Anthropic-compatible endpoints)
5. Pipes the SSE stream back to Claude Code in real-time
6. Falls back to the next provider on retriable errors

## Architecture

### Data Flow

```
Claude Code ──→ ModelWeaver ──→ Provider A (Anthropic-compatible endpoint)
                  │               Provider B (fallback)
                  │               Provider C (fallback)
                  │
            Inspects `model` field
            Matches to tier via substring patterns
            Routes to first healthy provider in chain
            Falls back on retriable errors
```

### Request Lifecycle

1. Claude Code sends `POST /v1/messages` with `model: "claude-sonnet-4-20250514"`
2. ModelWeaver extracts model name, matches to tier (sonnet/opus/haiku) via substring patterns
3. Looks up tier's provider chain from config
4. Rewrites `x-api-key` header to provider-specific key from env vars
5. Forwards request (headers + body unchanged) to first provider's base URL
6. Pipes SSE stream back to Claude Code in real-time
7. On retriable error → tries next provider in chain → streams from fallback
8. All providers exhausted → returns 502 to Claude Code

### What ModelWeaver Does NOT Do

- No request body modification (passthrough)
- No format translation (providers speak Anthropic format natively)
- No state between requests (stateless)
- No response body modification
- No retry on non-retriable errors (4xx)

## Configuration

### Config File

Location (checked in order):
1. `./modelweaver.yaml` (project-local)
2. `~/.modelweaver/config.yaml` (user-global)

### Schema

```yaml
server:
  port: 3456           # default: 3456
  host: localhost       # default: localhost

providers:
  <provider-name>:
    baseUrl: <url>                      # Anthropic-compatible API base URL
    apiKey: ${ENV_VAR_NAME}             # env var reference (required)
    timeout: 30000                       # connection timeout in ms (default: 30000)

routing:
  <tier-name>:
    - provider: <provider-name>         # first match in chain
      model: <optional-override>        # if omitted, forwards original model name
    - provider: <provider-name>         # fallback
      model: <optional-override>

tierPatterns:
  <tier-name>:
    - <substring-to-match>              # matched against incoming model name
    - <substring-to-match>
```

### Example Config

```yaml
server:
  port: 3456
  host: localhost

providers:
  anthropic:
    baseUrl: https://api.anthropic.com
    apiKey: ${ANTHROPIC_API_KEY}
  openrouter:
    baseUrl: https://openrouter.ai/api
    apiKey: ${OPENROUTER_API_KEY}

routing:
  sonnet:
    - provider: anthropic
      model: claude-sonnet-4-20250514
    - provider: openrouter
      model: anthropic/claude-sonnet-4
  opus:
    - provider: anthropic
      model: claude-opus-4-20250514
    - provider: openrouter
      model: anthropic/claude-opus-4
  haiku:
    - provider: anthropic
      model: claude-haiku-4-5-20251001
    - provider: openrouter
      model: anthropic/claude-haiku-4

tierPatterns:
  sonnet: ["sonnet", "3-5-sonnet", "3.5-sonnet"]
  opus: ["opus", "3-opus", "3.5-opus"]
  haiku: ["haiku", "3-haiku", "3.5-haiku"]
```

### API Key Management

- API keys are stored as environment variables only — never in config files
- Config references env vars using `${VAR_NAME}` syntax
- On startup, ModelWeaver validates all referenced env vars are set; fails fast with clear error if missing
- The `x-api-key` header is rewritten per-provider for each outbound request

## Error Handling

### Retriable Errors (trigger fallback)

- `429` — Rate limited
- `5xx` — Server error
- Network timeout
- Connection refused / DNS failure

### Non-Retriable Errors (fail immediately)

- `400` — Bad request
- `401` — Authentication error (config problem)
- `403` — Forbidden

### Fallback Chain Behavior

```
Request → Provider #1
  ├── Success (200) → stream response ✓
  ├── Retriable error → log → try Provider #2
  └── Non-retriable error → log → return error to Claude Code ✗

Provider #2 (fallback)
  ├── Success (200) → stream response ✓
  └── Any error → log → return 502 to Claude Code ✗
```

### Logging

- Each request gets a unique UUID for traceability
- Log entries include: request ID, model, matched tier, provider attempted, latency, status
- Structured JSON logging (stdout)
- Log levels: INFO (default), DEBUG (`--verbose` flag)

## Core Components

```
src/
├── server.ts          # HTTP server, receives requests from Claude Code
├── router.ts          # Model name → tier → provider chain resolution
├── proxy.ts           # Forwards request to upstream, pipes SSE stream back
├── config.ts          # Loads & validates YAML config, resolves env vars
├── logger.ts          # Structured logging (request ID, tier, provider, latency)
└── index.ts           # Entry point, CLI arg parsing, wires everything together
```

| Component | Responsibility |
|---|---|
| `server.ts` | Parse path/headers, hand off to router, return SSE stream |
| `router.ts` | Match model→tier via substring patterns, return ordered provider chain |
| `proxy.ts` | Forward req to provider URL, pipe SSE stream, detect retriable vs non-retriable errors |
| `config.ts` | Load YAML, resolve `${VAR}` env references, validate schema with Zod |
| `logger.ts` | Structured JSON logging per-request with UUID correlation |
| `index.ts` | CLI arg parsing, load config, validate env vars, start server |

## Dependencies

| Package | Purpose |
|---|---|
| `hono` | Lightweight HTTP framework with native SSE support (~14KB) |
| `yaml` | YAML config file parsing |
| `zod` | Config schema validation |
| `dotenv` | Load .env file for `${VAR}` resolution |

## CLI Interface

```
$ npx modelweaver [options]

Options:
  -p, --port <number>      Server port                    (default: 3456)
  -c, --config <path>      Config file path               (auto-detected)
  -v, --verbose            Enable debug logging           (default: off)
  -h, --help               Show help
```

### Startup Output

```
ModelWeaver v0.1.0
Config: ./modelweaver.yaml
Listening: http://localhost:3456

Routes:
  sonnet → anthropic (primary), openrouter (fallback)
  opus   → anthropic (primary), openrouter (fallback)
  haiku  → anthropic (primary), openrouter (fallback)
```

## Integration with Claude Code

```bash
# Terminal 1: Start ModelWeaver
$ export ANTHROPIC_API_KEY=sk-ant-...
$ export OPENROUTER_API_KEY=sk-or-...
$ npx modelweaver

# Terminal 2: Point Claude Code to ModelWeaver
$ export ANTHROPIC_BASE_URL=http://localhost:3456
$ export ANTHROPIC_API_KEY=unused-but-required
$ claude
```

Note: `ANTHROPIC_API_KEY` in Terminal 2 is required by Claude Code but ignored by ModelWeaver. ModelWeaver uses provider-specific keys from environment variables referenced in config.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Routing signal | `model` field inspection | Claude Code already sends tier-specific model names per agent role |
| API format | Anthropic-native passthrough | Providers offer Anthropic-compatible endpoints; no translation needed |
| Config format | YAML | Human-readable, supports comments, easy to version-control |
| API key storage | Environment variables only | No secrets in config files; safe to commit config |
| Fallback strategy | Ordered provider chain | Simple, predictable; first healthy provider wins |
| State management | Stateless | No persistence needed; kill process = clean stop |
| HTTP framework | Hono | Lightweight, fast, native SSE, TypeScript-first |
| SSE handling | Stream piping (no buffering) | Real-time passthrough required for Claude Code's tool loop |

## Out of Scope (MVP)

- Cost tracking / budget controls
- Rate limiting
- Response caching
- Per-conversation routing
- OpenAI format translation
- Dashboard / web UI
- Authentication on the ModelWeaver endpoint itself
