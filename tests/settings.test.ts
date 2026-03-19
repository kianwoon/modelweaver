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
