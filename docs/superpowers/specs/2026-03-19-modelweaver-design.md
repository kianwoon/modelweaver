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

### Path Handling

ModelWeaver appends the incoming request path (e.g., `/v1/messages`) to the provider's `baseUrl`. Query parameters are forwarded as-is. The outbound URL is constructed as: `{provider.baseUrl}{incoming.path}`.

### What ModelWeaver Does NOT Do

- No format translation (providers speak Anthropic format natively)
- No state between requests (stateless)
- No response body modification
- No retry on non-retriable errors (4xx)
- Note: request body IS modified when `model` override is configured (see below)

### Model Override (Exception to Passthrough)

When a routing entry specifies a `model` override, ModelWeaver:
1. Parses the request JSON body
2. Replaces the `model` field with the override value
3. Re-serializes the body
4. Updates the `Content-Length` header accordingly

This is the only case where the request body is modified. When `model` override is omitted, the original body is forwarded unchanged.

### Header Handling

| Category | Headers | Behavior |
|---|---|---|
| **Forwarded as-is** | `anthropic-version`, `anthropic-beta`, `content-type`, `accept` | Passed to upstream without modification |
| **Rewritten** | `x-api-key` | Replaced with the provider-specific key from config env var |
| **Rewritten** | `host` | Set to match the upstream provider's hostname |
| **Rewritten** | `content-length` | Updated if model override modifies the body |
| **Added by ModelWeaver** | `x-request-id` | UUID for request traceability across logs |

## Configuration

### Config File

Location (checked in order):
1. `./modelweaver.yaml` (project-local)
2. `~/.modelweaver/config.yaml` (user-global)

**First file found wins. Files are not merged.** If a project-local config exists, the global config is completely ignored.

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
- `${VAR}` interpolation applies to all string fields (not just `apiKey`)
- On startup, ModelWeaver validates all referenced env vars are set and non-empty; fails fast with clear error if missing or empty
- `apiKey` is required for every provider — missing `apiKey` field is a validation error
- The `x-api-key` header is rewritten per-provider for each outbound request

### Tier Pattern Matching

- Model names are matched against `tierPatterns` using **case-sensitive substring matching** (`String.includes`)
- The model name is tested against all patterns for all tiers
- **First tier whose patterns contain any match wins** — tier order in config determines priority
- If no tier matches, return HTTP 502 with Anthropic-format error body (see Error Responses)

### Startup Validation

On startup, ModelWeaver validates:
1. All `${VAR}` references resolve to non-empty environment variables
2. All `provider` names referenced in `routing` exist in the `providers` section
3. All tiers defined in `routing` have at least one entry in `tierPatterns`
4. Server port is a valid number (1-65535)
5. All `baseUrl` values are valid URLs

Any validation failure prints a clear error message and exits with code 1.

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

### Fallback Chain Behavior (Generalized)

```
For each provider in chain (ordered):
  1. If no SSE bytes sent yet:
     ├── Success (200) → pipe SSE stream to Claude Code ✓
     ├── Retriable error → log → try next provider
     └── Non-retriable error → log → return error to Claude Code ✗
  2. If SSE bytes already sent (mid-stream):
     └── Any failure → forward the error/termination to Claude Code as-is ✗
       (Cannot fallback mid-stream — Claude Code expects coherent SSE sequence)

All providers exhausted:
  └── Return 502 with Anthropic-format error body to Claude Code ✗
```

**Mid-stream failure**: Fallback only applies before any SSE bytes have been sent to Claude Code. Once the upstream provider has returned HTTP 200 and SSE events have started streaming, a connection failure mid-stream is forwarded directly to Claude Code. Claude Code already handles reconnection logic internally.

### Error Responses

All error responses returned to Claude Code follow the Anthropic error format:

```json
{
  "type": "error",
  "error": {
    "type": "<error_type>",
    "message": "<human-readable description>"
  }
}
```

Error types used:
- `invalid_request_error` — no matching tier for model name
- `authentication_error` — wrapped from upstream 401
- `overloaded_error` — all providers in chain exhausted (502)
- `api_error` — unexpected errors

### Logging

- Each request gets a unique UUID (also sent as `x-request-id` header) for traceability
- Log entries include: request ID, model, matched tier, provider attempted, latency, status
- Structured JSON logging (stdout)
- Log levels: INFO (default), DEBUG (`--verbose` flag)

### SSE Error Detection (Known Limitation)

MVP only inspects HTTP status codes for error classification. Some providers may return HTTP 200 with error events inside the SSE stream payload (e.g., `event: error` with error data). ModelWeaver does **not** inspect SSE event payloads for errors — it relies solely on the HTTP status code. This is a known limitation for future improvement.

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
| `@hono/node-server` | Node.js adapter for Hono |
| `yaml` | YAML config file parsing |
| `zod` | Config schema validation |
| `dotenv` | Load .env file for `${VAR}` resolution |

### Runtime & Build

- **Runtime**: Node.js 18+ (LTS)
- **Module format**: ESM (`"type": "module"` in package.json)
- **Dev**: `tsx` for running TypeScript directly
- **Build**: `tsup` for production bundling (single output file)
- **Package manager**: npm (publishing target)

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
- SSE payload error detection (currently HTTP status code only)
- Graceful shutdown with in-flight request drain

### Graceful Shutdown

ModelWeaver handles `SIGTERM` and `SIGINT` by stopping acceptance of new requests and exiting immediately. In-flight SSE streams are terminated without graceful drain. This is acceptable for a local dev tool — users can restart and re-run their Claude Code command.
