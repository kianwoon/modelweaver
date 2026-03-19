// src/daemon.ts — Daemon lifecycle management for background mode
import { fork, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  createWriteStream,
} from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MODELWEAVER_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".modelweaver"
);

export function getPidPath(): string {
  return join(MODELWEAVER_DIR, "modelweaver.pid");
}

export function getLogPath(): string {
  return join(MODELWEAVER_DIR, "modelweaver.log");
}

// ---------------------------------------------------------------------------
// Directory & PID helpers
// ---------------------------------------------------------------------------

export function ensureDir(): void {
  if (!existsSync(MODELWEAVER_DIR)) {
    mkdirSync(MODELWEAVER_DIR, { recursive: true });
  }
}

export function writePidFile(pid: number): void {
  ensureDir();
  writeFileSync(getPidPath(), `${pid}\n`);
}

export function readPidFile(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const content = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
}

// ---------------------------------------------------------------------------
// Worker PID helpers (used by monitor to track daemon child)
// ---------------------------------------------------------------------------

export function getWorkerPidPath(): string {
  return join(MODELWEAVER_DIR, "modelweaver.worker.pid");
}

export function writeWorkerPidFile(pid: number): void {
  ensureDir();
  writeFileSync(getWorkerPidPath(), `${pid}\n`);
}

export function readWorkerPidFile(): number | null {
  const pidPath = getWorkerPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const content = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removeWorkerPidFile(): void {
  const pidPath = getWorkerPidPath();
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence without sending signal
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Daemon status
// ---------------------------------------------------------------------------

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  message: string;
}

export function statusDaemon(): DaemonStatus {
  const pid = readPidFile();
  if (pid === null) {
    return { running: false, message: "ModelWeaver is not running (no PID file found)" };
  }
  if (isProcessAlive(pid)) {
    return { running: true, pid, message: `ModelWeaver is running (PID ${pid})` };
  }
  // Stale PID file — process is dead but file remains
  removePidFile();
  return { running: false, message: `ModelWeaver is not running (stale PID file cleaned up)` };
}

// ---------------------------------------------------------------------------
// Daemon start
// ---------------------------------------------------------------------------

export interface DaemonStartResult {
  success: boolean;
  pid?: number;
  message: string;
  logPath: string;
}

export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port);
  });
}

export async function startDaemon(
  configPath?: string,
  port?: number,
  verbose?: boolean,
): Promise<DaemonStartResult> {
  // Check if already running
  const currentStatus = statusDaemon();
  if (currentStatus.running) {
    return {
      success: false,
      pid: currentStatus.pid,
      message: `ModelWeaver is already running (PID ${currentStatus.pid})`,
      logPath: getLogPath(),
    };
  }

  // Check if port is already in use (only when port is explicitly provided)
  if (port && await isPortInUse(port)) {
    return {
      success: false,
      message: `Port ${port} is already in use. Is ModelWeaver or another process running on it?`,
      logPath: getLogPath(),
    };
  }

  // Resolve the entry script path
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Use dist/index.js (built output) — works with both npx and direct node
  const entryScript = join(__dirname, "index.js");

  // Build args — spawn a monitor process; monitor spawns the actual daemon child
  const childArgs: string[] = [entryScript, "--monitor"];
  if (configPath) childArgs.push("--config", configPath);
  if (port) childArgs.push("--port", String(port));
  if (verbose) childArgs.push("--verbose");

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  // Allow parent to exit independently
  child.unref();

  // Wait briefly for child to start and write PID file
  // (child process writes PID file in its startup sequence)
  let pid: number | undefined;
  for (let i = 0; i < 20; i++) {
    const checkPid = readPidFile();
    if (checkPid !== null) {
      pid = checkPid;
      break;
    }
    // Sleep 100ms
    await new Promise(r => setTimeout(r, 100));
  }

  if (!pid) {
    return {
      success: false,
      message: "Daemon started but PID file was not created. Check logs at " + getLogPath(),
      logPath: getLogPath(),
    };
  }

  return {
    success: true,
    pid,
    message: `ModelWeaver started in background (PID ${pid})`,
    logPath: getLogPath(),
  };
}

// ---------------------------------------------------------------------------
// Daemon stop
// ---------------------------------------------------------------------------

export interface DaemonStopResult {
  success: boolean;
  message: string;
}

export async function stopDaemon(): Promise<DaemonStopResult> {
  const pid = readPidFile();
  if (pid === null) {
    return { success: false, message: "ModelWeaver is not running (no PID file found)" };
  }

  if (!isProcessAlive(pid)) {
    // Monitor is dead — check for orphaned worker and kill it
    const workerPid = readWorkerPidFile();
    if (workerPid !== null && isProcessAlive(workerPid)) {
      try {
        process.kill(workerPid, "SIGTERM");
      } catch {
        // Already dead
      }
      const workerDeadline = Date.now() + 5000;
      while (Date.now() < workerDeadline) {
        if (!isProcessAlive(workerPid)) break;
        await new Promise(r => setTimeout(r, 100));
      }
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {
        // Already dead
      }
      removeWorkerPidFile();
    }
    removePidFile();
    return { success: false, message: "ModelWeaver is not running (stale PID file cleaned up)" };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { success: false, message: `Failed to stop daemon (PID ${pid})` };
  }

  // Wait up to 5 seconds for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removePidFile();
      return { success: true, message: `ModelWeaver stopped (PID ${pid})` };
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // Force kill if still running
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already dead
  }

  removePidFile();
  return { success: true, message: `ModelWeaver force-stopped (PID ${pid})` };
}

// ---------------------------------------------------------------------------
// Remove (stop + cleanup)
// ---------------------------------------------------------------------------

export function removeLogFile(): void {
  const logPath = getLogPath();
  if (existsSync(logPath)) {
    unlinkSync(logPath);
  }
}

export async function removeDaemon(): Promise<DaemonStopResult> {
  const stopResult = await stopDaemon();
  removeLogFile();
  removeWorkerPidFile();
  return {
    success: stopResult.success || stopResult.message.includes("not running"),
    message: stopResult.success
      ? "ModelWeaver stopped and cleaned up (PID file + log file removed)"
      : stopResult.message.includes("not running")
        ? "ModelWeaver is not running. Log file cleaned up."
        : stopResult.message,
  };
}

// ---------------------------------------------------------------------------
// Debounced watcher
// ---------------------------------------------------------------------------

export function createDebouncedReload(
  callback: () => void,
  debounceMs: number = 300,
): { reload: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    reload() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        callback();
      }, debounceMs);
    },
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
