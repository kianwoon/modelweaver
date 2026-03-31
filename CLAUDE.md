# ModelWeaver — Project CLAUDE.md

> Inherits from global `~/.claude/CLAUDE.md`.

## Project Overview

LLM proxy with Tauri GUI. Routes requests to multiple upstream providers with fallback chains, racing, and circuit breakers.

- **Package**: `@kianwoon/modelweaver`
- **Main**: `dist/index.js` (TypeScript → tsup)
- **GUI**: Tauri app in `gui/` (Rust backend + HTML/CSS/JS frontend)

## Build & Restart (MANDATORY after any code change)

After modifying `src/**/*.ts` or `gui/frontend/**`:

```bash
# 1. Rebuild daemon
npm run build

# 2. Restart daemon
npx modelweaver stop
npx modelweaver order
```

After modifying `gui/frontend/**` (HTML/CSS/JS):

```bash
# 1. Clean Rust artifacts (MUST — Tauri embeds frontend as a brotli blob at compile time.
#    Cargo caches this embedding, so regular rebuilds skip frontend changes!)
cd gui && cargo clean

# 2. Rebuild GUI app bundle from scratch
npx tauri build --bundles app
```

## Commit / Push / NPM Publish Workflow

```bash
# 1. Stage specific files (never git add -A)
git add <files>

# 2. Commit
git commit -m "<type>: <description>"

# 3. Push
git push

# 4. Bump version and publish npm
npm version patch --no-git-tag-version
npm run build
npm publish --access public

# 5. Commit version bump
git add package.json package-lock.json
git commit -m "chore: bump version to $(node -p "require('./package.json').version")"
git push
```

## Project Structure

| Path | Purpose |
|------|---------|
| `src/server.ts` | Hono HTTP server, request routing, WebSocket broadcast |
| `src/proxy.ts` | Provider forwarding, fallback chains, racing, TTFB timeout |
| `src/config.ts` | YAML config parsing, Zod schemas |
| `src/types.ts` | TypeScript interfaces (ProviderConfig, StreamEvent, etc.) |
| `gui/frontend/` | Tauri GUI (HTML/CSS/JS — embedded at build time via `gui/build.rs`) |
| `gui/src/` | Rust Tauri backend |
| `tests/` | Vitest tests |

## Key Patterns

- **Provider timeout**: 30s default (`timeout` field)
- **TTFB timeout**: 15s default (`ttfbTimeout` field) — fails slow providers before total timeout
- **Fallback chain**: sequential by default, switches to race mode on 429
- **Circuit breaker**: per-provider, configurable thresholds
- **Progress bar**: WebSocket events (`start` → `streaming` → `complete`/`error`)

## Conventions

- Commit messages: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- GUI frontend is **embedded at build time** as a brotli blob — `cargo clean` is required before rebuilding to pick up CSS/HTML/JS changes (regular rebuild uses cached blob)
- Never commit `.env` or secrets
