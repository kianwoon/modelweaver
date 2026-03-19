# ModelWeaver

Multi-provider model orchestration proxy for Claude Code. Route different agent roles (planning, coding, research, review) to different model providers based on what each model does best.

## How It Works

ModelWeaver sits between Claude Code and upstream model providers as a local HTTP proxy. It inspects the `model` field in each Anthropic Messages API request, matches it to an agent tier (sonnet/opus/haiku), and routes to the best-fit provider with automatic fallback on failure.

```
Claude Code  ──→  ModelWeaver  ──→  Anthropic (primary)
                   (localhost)   ──→  OpenRouter (fallback)
                   │
              Inspects model field
              Routes by tier
              Falls back on error
```

## Quick Start

### 1. Create a config file

```bash
cp modelweaver.example.yaml modelweaver.yaml
```

```yaml
server:
  port: 3456

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

### 2. Set provider API keys

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENROUTER_API_KEY=sk-or-...
```

### 3. Start ModelWeaver

```bash
npx modelweaver
```

```
ModelWeaver v0.1.0
Config: ./modelweaver.yaml
Listening: http://localhost:3456

Routes:
  sonnet   → anthropic (primary), openrouter (fallback)
  opus     → anthropic (primary), openrouter (fallback)
  haiku    → anthropic (primary), openrouter (fallback)
```

### 4. Point Claude Code to ModelWeaver

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=unused-but-required
claude
```

## CLI Options

```
npx modelweaver [options]

  -p, --port <number>      Server port                    (default: 3456)
  -c, --config <path>      Config file path               (auto-detected)
  -v, --verbose            Enable debug logging           (default: off)
  -h, --help               Show help
```

## Configuration

### Config File Locations

Checked in order (first found wins):
1. `./modelweaver.yaml` (project-local)
2. `~/.modelweaver/config.yaml` (user-global)

### Routing

Each model name is matched against `tierPatterns` using case-sensitive substring matching. The first tier whose patterns contain a match wins. The ordered list under that tier defines the provider fallback chain.

- **Provider chain order matters** — first provider is primary, rest are fallbacks
- **Model override** — use the `model` field to rewrite the model name per provider (different providers may use different model names)
- **Fallback triggers** — 429 (rate limit) and 5xx errors
- **No fallback on** — 4xx errors (bad request, auth failure, forbidden)

### API Keys

API keys are stored as environment variables only. Config references them with `${VAR_NAME}` syntax. ModelWeaver validates all keys are set on startup and fails fast if any are missing.

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
# Install dependencies
npm install

# Run tests
npm test

# Run in dev mode
npm run dev

# Build for production
npm run build
```

## License

Apache-2.0
