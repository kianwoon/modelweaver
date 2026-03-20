// src/settings.ts — Read/write/merge Claude Code settings.json
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, renameSync } from "node:fs";
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
  try {
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    console.warn("[settings] Malformed settings.json, starting fresh");
    return {};
  }
}

/**
 * Backup existing settings.json to settings.json.bak.
 * Returns true if backup was created, false if no file to backup.
 */
export function backupSettings(): boolean {
  if (!existsSync(SETTINGS_PATH)) return false;
  console.log("[settings] Backing up existing settings to .bak");
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
  const tmpPath = SETTINGS_PATH + ".tmp";
  try {
    writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, SETTINGS_PATH);
  } catch {
    // Clean up temp file if rename failed
    try { renameSync(tmpPath, SETTINGS_PATH); } catch { /* ignore */ }
  }
}
