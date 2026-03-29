// src/entry-path.ts — Robust entry script resolution for bundled environments.
// tsup code-splits into chunks, so import.meta.url may point to e.g. dist/daemon-*.js
// instead of dist/index.js. process.argv[1] always holds the actual entry point.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveEntryScript(): string {
  // process.argv[1] is always the actual script Node was invoked with
  if (process.argv[1]) return process.argv[1];
  // Fallback: resolve relative to this module (works in dist/ layout)
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}
