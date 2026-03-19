# Contributing to ModelWeaver

Thanks for your interest in contributing. This guide covers what you need to get started.

## Prerequisites

- **Node.js** >= 18 (ESM is required)
- **npm** (bundled with Node.js)

## Setup

1. Fork the repository and clone your fork locally.
2. Install dependencies:

```bash
npm install
```

3. Verify everything works:

```bash
npm test
npm run build
```

## Development

Start the dev server with hot reload:

```bash
npm run dev
```

To test against real providers, create a `modelweaver.yaml` in the project root (or run `npx modelweaver init` to use the interactive wizard). Set the required API keys as environment variables, then start the server. The config file is auto-detected.

## Project Structure

```
src/
  index.ts      CLI entry point -- arg parsing, server startup, graceful shutdown
  server.ts     Hono app setup, request routing, error handling
  proxy.ts      Request forwarding, SSE streaming, fallback chains
  router.ts     Model name to tier matching (sonnet/opus/haiku)
  config.ts     YAML config loading, env var resolution, Zod validation
  types.ts      TypeScript interfaces and shared types
  logger.ts     Structured logging (info/warn/error/debug)
  presets.ts    Provider templates used by the init wizard
  init.ts       Interactive setup wizard (prompts-based)
tests/
  *.test.ts     Vitest test files (one per source module)
  helpers/      Shared test utilities (mock provider, etc.)
.github/workflows/
  ci.yml        CI pipeline: type check, build, test on Node 18/20/22
```

## Testing

Tests use Vitest. Run them with:

```bash
npm test          # single run
npm run test:watch  # watch mode
```

Test files live in `tests/` and mirror the source structure -- one `.test.ts` file per module. Shared helpers go in `tests/helpers/`. The `mock-provider` helper starts a local HTTP server that returns canned responses for integration tests.

When adding a feature, include tests that cover the happy path and relevant edge cases.

## Building

```bash
npm run build
```

tsup bundles the source to `dist/` as ESM. The output is what gets published and what the CLI entry point references.

## Code Style

- **TypeScript strict mode** is enabled. Do not use `any`.
- **ESM only** -- the project uses `"type": "module"`.
- **Import extensions**: use `.js` extensions for local imports:
  ```typescript
  import { foo } from './bar.js';
  ```
- **Node built-ins**: use the `node:` prefix:
  ```typescript
  import { readFileSync } from 'node:fs';
  ```
- **Config validation**: all config shapes are defined as Zod schemas in `config.ts`.
- **API keys**: never hardcode keys. Use the `${ENV_VAR}` syntax in config, resolved at runtime.
- No linter or formatter is configured yet, so follow the patterns you see in the existing code.

## Pull Requests

1. Branch off `main`.
2. Make your changes and add tests.
3. Ensure `npm test` and `npm run build` pass locally.
4. Open a PR with a clear description of what changed and why.
5. CI must pass before merge. The pipeline runs type checking, the build, and the full test suite on Node 18, 20, and 22.

Keep PRs focused. If a change spans multiple concerns, consider splitting into separate PRs.

## Adding a New Provider

Adding a new provider is a single-step process. Open `src/presets.ts` and add a new entry to the `PRESETS` array following the `ProviderPreset` interface:

```typescript
{
  id: "my-provider",           // machine-readable key used in config
  name: "My Provider",          // display name shown in the init wizard
  baseUrl: "https://api.example.com",
  envKey: "MY_PROVIDER_API_KEY", // suggested environment variable
  authType: "bearer",           // "bearer" or "anthropic"
  models: {
    sonnet: "model-id-for-sonnet-tier",
    opus: "model-id-for-opus-tier",
    haiku: "model-id-for-haiku-tier",
  },
}
```

The init wizard will automatically offer the new provider. No other files need to change.

## License

By contributing, you agree that your code will be licensed under the [Apache-2.0](https://opensource.org/licenses/Apache-2.0) license.
