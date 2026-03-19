# Settings.json Auto-Configuration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Have `modelweaver init` automatically configure `~/.claude/settings.json` so Claude Code routes through the ModelWeaver proxy with the correct model IDs — eliminating manual editing errors.

**Architecture:** A new `src/settings.ts` module handles reading/writing/merging Claude Code's `~/.claude/settings.json`. The init wizard gains a new step after writing config files that presents available models and writes the settings. The key fields are `env.ANTHROPIC_BASE_URL` (proxy endpoint), `env.ANTHROPIC_AUTH_TOKEN` (API key), `env.ANTHROPIC_DEFAULT_*_MODEL` (tier alias overrides), and optionally `model` (default model selection).

**Tech Stack:** TypeScript, Node.js `fs` for file I/O, `prompts` library for interactive wizard, existing test infrastructure (vitest)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/settings.ts` (new) | Read/write/merge `~/.claude/settings.json` — pure functions, no prompts |
| `src/init.ts` (modify) | New wizard step + integration with settings module |
| `tests/settings.test.ts` (new) | Unit tests for settings read/write/merge |
| `modelweaver.example.yaml` (modify) | Update comments to mention settings.json auto-config |

---

## Chunk 1: Settings Module (`src/settings.ts` + tests)

### Task 1: Create `src/settings.ts` — types and constants

**Files:**
- Create: `src/settings.ts`

- [ ] **Step 1: Write types and path constant**

```typescript
// src/settings.ts — Read/write/merge Claude Code settings.json
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// --- Types ---

export interface ClaudeSettings {
  env?: Record<string, string>;
  model?: string;
  [key: string]: unknown;
}

export interface SettingsWriteOptions {
  baseUrl: string;       // e.g., "http://localhost:3456"
  authToken: string;     // API key for the primary provider
  defaultModel?: string; // top-level model override
  tierModels?: {         // tier alias overrides
    sonnet?: string;
    opus?: string;
    haiku?: string;
  };
}

// --- Paths ---

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const BACKUP_PATH = join(CLAUDE_DIR, "settings.json.bak");

// --- Public API ---

export function getSettingsPath(): string {
  return SETTINGS_PATH;
}

/**
 * Read ~/.claude/settings.json. Returns empty object if file doesn't exist.
 */
export function readSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  const raw = readFileSync(SETTINGS_PATH, "utf-8");
  return JSON.parse(raw) as ClaudeSettings;
}

/**
 * Backup existing settings.json to settings.json.bak.
 * Returns true if backup was created, false if no file to backup.
 */
export function backupSettings(): boolean {
  if (!existsSync(SETTINGS_PATH)) return false;
  copyFileSync(SETTINGS_PATH, BACKUP_PATH);
  return true;
}

/**
 * Merge model-routing fields into existing settings, preserving everything else.
 *
 * Strategy:
 * - Deep-merge `env` (overwrite only our keys, leave user's keys untouched)
 * - Set top-level `model` only if provided
 * - Preserve all other top-level keys (permissions, hooks, etc.)
 */
export function mergeSettings(
  existing: ClaudeSettings,
  options: SettingsWriteOptions
): ClaudeSettings {
  const result: ClaudeSettings = { ...existing };

  // Deep-merge env
  result.env = { ...(existing.env || {}) };

  // Our keys to set
  const envKeys: Record<string, string> = {
    ANTHROPIC_BASE_URL: options.baseUrl,
    ANTHROPIC_AUTH_TOKEN: options.authToken,
  };

  for (const [key, value] of Object.entries(envKeys)) {
    result.env[key] = value;
  }

  // Tier alias overrides (only set if provided)
  if (options.tierModels) {
    const tierEnvMap: Record<string, string> = {
      sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
      opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
      haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    };
    for (const [tier, envKey] of Object.entries(tierEnvMap)) {
      const modelValue = options.tierModels[tier as keyof typeof options.tierModels];
      if (modelValue) {
        result.env[envKey] = modelValue;
      }
    }
  }

  // Top-level model override
  if (options.defaultModel) {
    result.model = options.defaultModel;
  }

  return result;
}

/**
 * Write settings to ~/.claude/settings.json.
 * Creates the directory if it doesn't exist.
 */
export function writeSettings(settings: ClaudeSettings): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
```

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

### Task 2: Create `tests/settings.test.ts` — unit tests

**Files:**
- Create: `tests/settings.test.ts`

- [ ] **Step 1: Write all tests**

```typescript
// tests/settings.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readSettings,
  backupSettings,
  mergeSettings,
  writeSettings,
  getSettingsPath,
} from "../src/settings.js";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

const SETTINGS_PATH = getSettingsPath();
const BACKUP_PATH = join(dirname(SETTINGS_PATH), "settings.json.bak");

// Helper: capture and restore settings
function captureOriginal(): string | null {
  return existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, "utf-8") : null;
}

function restoreOriginal(original: string | null): void {
  if (existsSync(BACKUP_PATH)) unlinkSync(BACKUP_PATH);
  if (original === null) {
    if (existsSync(SETTINGS_PATH)) unlinkSync(SETTINGS_PATH);
  } else {
    writeSettings(JSON.parse(original));
  }
}

describe("settings module", () => {
  let original: string | null;

  beforeEach(() => {
    original = captureOriginal();
  });

  afterEach(() => {
    restoreOriginal(original);
  });

  describe("readSettings", () => {
    it("returns empty object when no settings file exists", () => {
      if (existsSync(SETTINGS_PATH)) unlinkSync(SETTINGS_PATH);
      expect(readSettings()).toEqual({});
    });

    it("parses existing settings.json correctly", () => {
      const testSettings = { env: { TEST_KEY: "test-value" }, model: "opus" };
      writeSettings(testSettings);
      const result = readSettings();
      expect(result.env?.TEST_KEY).toBe("test-value");
      expect(result.model).toBe("opus");
    });
  });

  describe("backupSettings", () => {
    it("creates .bak file when settings.json exists", () => {
      writeSettings({ model: "test" });
      const result = backupSettings();
      expect(result).toBe(true);
      expect(existsSync(BACKUP_PATH)).toBe(true);
    });

    it("returns false when no settings.json exists", () => {
      if (existsSync(SETTINGS_PATH)) unlinkSync(SETTINGS_PATH);
      expect(backupSettings()).toBe(false);
      expect(existsSync(BACKUP_PATH)).toBe(false);
    });

    it("backup content matches original", () => {
      const testSettings = { env: { KEY: "value" }, model: "sonnet" };
      writeSettings(testSettings);
      backupSettings();
      const backup = JSON.parse(readFileSync(BACKUP_PATH, "utf-8"));
      expect(backup).toEqual(testSettings);
    });
  });

  describe("mergeSettings", () => {
    it("adds env keys to empty settings", () => {
      const result = mergeSettings({}, {
        baseUrl: "http://localhost:3456",
        authToken: "sk-test",
      });
      expect(result.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:3456");
      expect(result.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    });

    it("preserves existing env keys not managed by modelweaver", () => {
      const existing = {
        env: {
          MY_CUSTOM_VAR: "keep-this",
          ANTHROPIC_BASE_URL: "http://old-url",
        },
        permissions: { allow: ["*"] },
      };
      const result = mergeSettings(existing, {
        baseUrl: "http://localhost:3456",
        authToken: "sk-test",
      });
      expect(result.env?.MY_CUSTOM_VAR).toBe("keep-this");
      expect(result.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:3456");
      expect(result.permissions).toEqual({ allow: ["*"] });
    });

    it("sets tier alias models when provided", () => {
      const result = mergeSettings({}, {
        baseUrl: "http://localhost:3456",
        authToken: "sk-test",
        tierModels: {
          sonnet: "glm-5-turbo",
          opus: "glm-5-turbo",
          haiku: "glm-5-turbo",
        },
      });
      expect(result.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5-turbo");
      expect(result.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5-turbo");
      expect(result.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5-turbo");
    });

    it("does not set tier alias when value is undefined", () => {
      const existing = { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4" } };
      const result = mergeSettings(existing, {
        baseUrl: "http://localhost:3456",
        authToken: "sk-test",
        tierModels: { opus: "glm-5-turbo" },
      });
      // sonnet was not provided in tierModels, so it should be preserved
      expect(result.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4");
      expect(result.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5-turbo");
    });

    it("sets top-level model when provided", () => {
      const result = mergeSettings({}, {
        baseUrl: "http://localhost:3456",
        authToken: "sk-test",
        defaultModel: "opus[1m]",
      });
      expect(result.model).toBe("opus[1m]");
    });

    it("preserves top-level model when not provided", () => {
      const existing = { model: "sonnet" };
      const result = mergeSettings(existing, {
        baseUrl: "http://localhost:3456",
        authToken: "sk-test",
      });
      expect(result.model).toBe("sonnet");
    });

    it("preserves non-env top-level keys (hooks, permissions, etc)", () => {
      const existing = {
        model: "old-model",
        includeCoAuthoredBy: false,
        enableAllProjectMcpServers: true,
        permissions: { allow: ["read"] },
        hooks: { PreToolUse: [{ matcher: "test", hooks: [] }] },
      };
      const result = mergeSettings(existing, {
        baseUrl: "http://localhost:3456",
        authToken: "sk-test",
        defaultModel: "opus[1m]",
      });
      expect(result.includeCoAuthoredBy).toBe(false);
      expect(result.enableAllProjectMcpServers).toBe(true);
      expect(result.permissions).toEqual({ allow: ["read"] });
      expect(result.hooks).toEqual(existing.hooks);
      expect(result.model).toBe("opus[1m]");
    });
  });

  describe("writeSettings + readSettings round-trip", () => {
    it("writes and reads back correctly", () => {
      const settings = {
        env: {
          ANTHROPIC_BASE_URL: "http://localhost:3456",
          ANTHROPIC_AUTH_TOKEN: "sk-test",
          CUSTOM: "preserved",
        },
        model: "opus[1m]",
        permissions: { allow: ["*"] },
      };
      writeSettings(settings);
      const read = readSettings();
      expect(read).toEqual(settings);
    });

    it("creates directory if it doesn't exist", () => {
      // Settings path is always ~/.claude/ which should exist,
      // but writeSettings calls mkdirSync with recursive: true
      const settings = { env: { TEST: "value" } };
      writeSettings(settings);
      expect(existsSync(SETTINGS_PATH)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/settings.test.ts -v`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/settings.ts tests/settings.test.ts
git commit -m "feat: add settings.json read/write/merge module"
```

---

## Chunk 2: Init Wizard Integration

### Task 3: Add model selection step to init wizard

**Files:**
- Modify: `src/init.ts:132-181` (configureRouting function)
- Modify: `src/init.ts:252-348` (runInit function)

- [ ] **Step 1: Add import for settings module at top of `src/init.ts`**

Add after line 6 (`import { join } from 'node:path';`):

```typescript
import { readSettings, backupSettings, mergeSettings, writeSettings, getSettingsPath } from './settings.js';
```

- [ ] **Step 2: Add `collectAvailableModels()` helper function**

Add after the `configureServer()` function (after line 193):

```typescript
function collectAvailableModels(
  routing: Record<string, RoutingTier[]>,
): { id: string; source: string }[] {
  const models: { id: string; source: string }[] = [];

  // Collect unique primary models from each tier
  for (const [tier, entries] of Object.entries(routing)) {
    if (entries.length > 0 && !models.some((m) => m.id === entries[0].model)) {
      models.push({ id: entries[0].model, source: `${tier} tier` });
    }
  }

  return models;
}
```

- [ ] **Step 3: Add `configureClaudeCodeSettings()` wizard step**

Add after `collectAvailableModels()`:

```typescript
interface SettingsConfig {
  defaultModel: string;
  tierModels: { sonnet?: string; opus?: string; haiku?: string };
}

async function configureClaudeCodeSettings(
  routing: Record<string, RoutingTier[]>,
  providers: ConfiguredProvider[],
  server: { port: number; host: string },
): Promise<SettingsConfig | null> {
  const availableModels = collectAvailableModels(routing);
  if (availableModels.length === 0) return null;

  console.log();

  // Step A: Ask to configure
  const { configure } = await prompts(
    {
      type: 'confirm',
      name: 'configure',
      message: 'Configure Claude Code to use ModelWeaver automatically?',
      initial: true,
    },
    CANCEL,
  );

  if (!configure) return null;

  // Step B: Select default model
  const { defaultModel } = await prompts(
    {
      type: 'select',
      name: 'defaultModel',
      message: 'Select default model for Claude Code:',
      choices: availableModels.map((m) => ({
        title: m.id,
        description: m.source,
        value: m.id,
      })),
    },
    CANCEL,
  );

  // Step C: Ask about tier alias mapping
  console.log();
  const { mapAliases } = await prompts(
    {
      type: 'confirm',
      name: 'mapAliases',
      message: 'Map tier aliases? (e.g., when Claude Code uses /sonnet, send a specific model)',
      initial: false,
    },
    CANCEL,
  );

  const tierModels: { sonnet?: string; opus?: string; haiku?: string } = {};

  if (mapAliases) {
    const tiers = ['sonnet', 'opus', 'haiku'] as const;
    for (const tier of tiers) {
      const { tierModel } = await prompts(
        {
          type: 'select',
          name: 'tierModel',
          message: `[${tier}] When Claude Code uses ${tier}, send model:`,
          choices: availableModels.map((m) => ({
            title: m.id,
            description: m.source,
            value: m.id,
          })),
        },
        CANCEL,
      );
      tierModels[tier] = tierModel as string;
    }
  }

  return { defaultModel: defaultModel as string, tierModels };
}
```

- [ ] **Step 4: Integrate settings step into `runInit()`**

After the existing "Step 7 — Write files" block (after line 331 `writeEnvFile(configured);`), add:

```typescript
  // Step 8 — Configure Claude Code settings.json
  const settingsConfig = await configureClaudeCodeSettings(routing, configured, server);

  if (settingsConfig) {
    // Use the primary provider's API key for the auth token
    const primaryProvider = configured[0];
    const baseUrl = server.host === 'localhost'
      ? `http://localhost:${server.port}`
      : `http://${server.host}:${server.port}`;

    const didBackup = backupSettings();
    if (didBackup) {
      console.log(`  Backed up existing settings to settings.json.bak`);
    }

    const existing = readSettings();
    const merged = mergeSettings(existing, {
      baseUrl,
      authToken: primaryProvider.apiKey,
      defaultModel: settingsConfig.defaultModel,
      tierModels: settingsConfig.tierModels,
    });
    writeSettings(merged);

    check(`Claude Code settings updated at ${getSettingsPath()}`);
    console.log(`    Proxy endpoint: ${baseUrl}`);
    console.log(`    Default model:  ${settingsConfig.defaultModel}`);
    if (Object.keys(settingsConfig.tierModels).length > 0) {
      for (const [tier, model] of Object.entries(settingsConfig.tierModels)) {
        console.log(`    ${tier.padEnd(8)} → ${model}`);
      }
    }
    console.log();
    console.log(`  ${GREEN}Restart Claude Code to apply changes.${RESET}`);
  }
```

- [ ] **Step 5: Update the success banner**

Replace the success banner (lines 333-347) with a simplified version since settings are now auto-configured:

```typescript
  console.log(`
\x1B[1m\x1B[36m\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551  ModelWeaver is configured!                   \u2551
\u2551                                                \u2551
${settingsConfig
  ? `\u2551  Claude Code settings have been updated.       \u2551\u2551                                                \u2551\u2551  Just restart Claude Code to get started.     \u2551`
  : `\u2551  To use with Claude Code:                      \u2551\u2551                                                \u2551\u2551  Terminal 1:                                   \u2551\u2551    modelweaver                                 \u2551\u2551                                                \u2551\u2551  Terminal 2:                                   \u2551\u2551    export ANTHROPIC_BASE_URL=\\                 \u2551\u2551      http://localhost:${String(server.port).padEnd(20)}\u2551\u2551    claude                                      \u2551`
}
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\x1B[0m
`);
```

**Note:** `settingsConfig` is currently scoped inside `runInit`. Move its declaration before the settings step so it's accessible in the banner. The declaration should be at the top of `runInit()` alongside the other variables (around line 263):

```typescript
  let settingsConfig: SettingsConfig | null = null;
```

Then in the settings block, assign to it:
```typescript
  settingsConfig = await configureClaudeCodeSettings(routing, configured, server);
```

- [ ] **Step 6: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Run existing tests to verify no regressions**

Run: `npm test`
Expected: All 76+ tests pass

- [ ] **Step 8: Commit**

```bash
git add src/init.ts
git commit -m "feat: add Claude Code settings.json auto-config to init wizard"
```

---

## Chunk 3: Example Config & Final Verification

### Task 4: Update `modelweaver.example.yaml`

**Files:**
- Modify: `modelweaver.example.yaml`

- [ ] **Step 1: Add comment about settings.json auto-config**

Add at the top of the file, after any existing comments:

```yaml
# ModelWeaver Configuration
# Run 'npx modelweaver init' to auto-configure this file AND
# ~/.claude/settings.json for seamless Claude Code integration.
```

- [ ] **Step 2: Commit**

```bash
git add modelweaver.example.yaml
git commit -m "docs: mention settings.json auto-config in example"
```

### Task 5: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass (76 existing + ~14 new = 90+)

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Build**

Run: `npx tsup`
Expected: Build success

---

## What this does NOT do (out of scope)

- Does NOT manage project-level settings (`.claude/settings.json`)
- Does NOT handle Claude Code restarts (user must restart manually)
- Does NOT validate that Claude Code is installed
- Does NOT remove settings on uninstall
- Does NOT configure `modelRouting` in init wizard (separate future feature)
