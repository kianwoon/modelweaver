// tests/daemon.test.ts
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Override HOME before importing daemon module (MODELWEAVER_DIR is evaluated at import time)
const ORIG_HOME = process.env.HOME;
const TEST_HOME = join(tmpdir(), `mw-daemon-test-${Date.now()}`);
process.env.HOME = TEST_HOME;

// Now import — the module will use TEST_HOME
const {
  getPidPath,
  getLogPath,
  ensureDir,
  writePidFile,
  readPidFile,
  removePidFile,
  removeLogFile,
  removeDaemon,
  getWorkerPidPath,
  writeWorkerPidFile,
  readWorkerPidFile,
  removeWorkerPidFile,
  isProcessAlive,
  statusDaemon,
  createDebouncedReload,
  _setConfigPortOverride,
} = await import("../src/daemon.js");

// Prevent daemon tests from scanning real config/port
_setConfigPortOverride(0);

// Create the temp directory
mkdirSync(join(TEST_HOME, ".modelweaver"), { recursive: true });

// Restore HOME after all tests and clean up
afterAll(() => {
  _setConfigPortOverride(null);
  process.env.HOME = ORIG_HOME;
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("daemon", () => {
  describe("paths", () => {
    it("getPidPath returns correct path", () => {
      expect(getPidPath()).toBe(join(TEST_HOME, ".modelweaver", "modelweaver.pid"));
    });

    it("getLogPath returns correct path", () => {
      expect(getLogPath()).toBe(join(TEST_HOME, ".modelweaver", "modelweaver.log"));
    });
  });

  describe("PID file operations", () => {
    beforeEach(async () => {
      // Clean up any existing PID file
      await removePidFile();
    });

    afterEach(async () => {
      await removePidFile();
    });

    it("writePidFile and readPidFile round-trip", async () => {
      await writePidFile(12345);
      expect(await readPidFile()).toBe(12345);
    });

    it("readPidFile returns null when no file exists", async () => {
      expect(await readPidFile()).toBeNull();
    });

    it("removePidFile removes the file", async () => {
      await writePidFile(12345);
      expect(await readPidFile()).toBe(12345);
      await removePidFile();
      expect(await readPidFile()).toBeNull();
    });

    it("readPidFile returns null for garbage content", async () => {
      const { writeFileSync } = await import("node:fs");
      await ensureDir();
      writeFileSync(getPidPath(), "not-a-number\n");
      expect(await readPidFile()).toBeNull();
    });
  });

  describe("isProcessAlive", () => {
    it("returns true for current process", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for impossible PID", () => {
      expect(isProcessAlive(999999999)).toBe(false);
    });
  });

  describe("statusDaemon", () => {
    beforeEach(async () => {
      await removePidFile();
    });

    afterEach(async () => {
      await removePidFile();
    });

    it("returns not running when no PID file and nothing on port", async () => {
      // Pass port=0 to skip port-based fallback detection in tests
      const status = await statusDaemon(0);
      expect(status.running).toBe(false);
      expect(status.message).toContain("not running");
    });

    it("returns running with current PID", async () => {
      await writePidFile(process.pid);
      const status = await statusDaemon();
      expect(status.running).toBe(true);
      expect(status.pid).toBe(process.pid);
      expect(status.message).toContain("running");
    });

    it("cleans up stale PID file", async () => {
      await writePidFile(999999999); // impossible PID
      const status = await statusDaemon();
      expect(status.running).toBe(false);
      expect(status.message).toContain("stale");
      // PID file should have been removed
      expect(await readPidFile()).toBeNull();
    });
  });

  describe("createDebouncedReload", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("debounces rapid calls", () => {
      const callback = vi.fn();
      const debounced = createDebouncedReload(callback, 300);

      // Rapid fire 5 calls
      debounced.reload();
      debounced.reload();
      debounced.reload();
      debounced.reload();
      debounced.reload();

      expect(callback).not.toHaveBeenCalled();

      // Advance past debounce time
      vi.advanceTimersByTime(300);

      expect(callback).toHaveBeenCalledTimes(1);
      debounced.dispose();
    });

    it("resets timer on each call", () => {
      const callback = vi.fn();
      const debounced = createDebouncedReload(callback, 300);

      debounced.reload();
      vi.advanceTimersByTime(200);
      debounced.reload(); // Reset timer
      vi.advanceTimersByTime(200); // Not enough
      expect(callback).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100); // Now 300ms since last reset
      expect(callback).toHaveBeenCalledTimes(1);

      debounced.dispose();
    });

    it("dispose cancels pending callback", () => {
      const callback = vi.fn();
      const debounced = createDebouncedReload(callback, 300);

      debounced.reload();
      debounced.dispose();

      vi.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("worker PID file operations", () => {
    beforeEach(async () => {
      await removeWorkerPidFile();
    });

    afterEach(async () => {
      await removeWorkerPidFile();
    });

    it("writeWorkerPidFile and readWorkerPidFile round-trip", async () => {
      await writeWorkerPidFile(54321);
      expect(await readWorkerPidFile()).toBe(54321);
    });

    it("readWorkerPidFile returns null when no file exists", async () => {
      expect(await readWorkerPidFile()).toBeNull();
    });

    it("removeWorkerPidFile removes the file", async () => {
      await writeWorkerPidFile(54321);
      expect(await readWorkerPidFile()).toBe(54321);
      await removeWorkerPidFile();
      expect(await readWorkerPidFile()).toBeNull();
    });

    it("getWorkerPidPath returns correct path", () => {
      expect(getWorkerPidPath()).toBe(join(TEST_HOME, ".modelweaver", "modelweaver.worker.pid"));
    });
  });

  describe("removeLogFile", () => {
    beforeEach(async () => {
      // Clean up any existing log file
      await removeLogFile();
    });

    afterEach(async () => {
      await removeLogFile();
    });

    it("removes log file if it exists", async () => {
      await ensureDir();
      writeFileSync(getLogPath(), "test log content\n");
      expect(existsSync(getLogPath())).toBe(true);
      await removeLogFile();
      expect(existsSync(getLogPath())).toBe(false);
    });

    it("does nothing if log file does not exist", async () => {
      await expect(removeLogFile()).resolves.not.toThrow();
    });
  });

  describe("removeDaemon", () => {
    beforeEach(async () => {
      await removePidFile();
      await removeLogFile();
      await removeWorkerPidFile();
    });

    afterEach(async () => {
      await removePidFile();
      await removeLogFile();
      await removeWorkerPidFile();
    });

    it("reports not running or cleaned up and removes log file", async () => {
      await ensureDir();
      writeFileSync(getLogPath(), "old log\n");
      await writeWorkerPidFile(12345);

      const result = await removeDaemon();
      expect(result.success).toBe(true);
      // Message may say "not running" (normal case) or "stopped" (if port-based
      // fallback found a process on the configured port during the test)
      expect(
        result.message.includes("not running") || result.message.includes("stopped")
      ).toBe(true);
      expect(existsSync(getLogPath())).toBe(false);
      expect(existsSync(getWorkerPidPath())).toBe(false);
    });

    it("cleans up even with no log file", async () => {
      const result = await removeDaemon();
      expect(result.success).toBe(true);
      expect(result.message).toContain("not running");
    });
  });
});
