// src/daemon.ts — Daemon lifecycle management for background mode
import { spawn, execFile } from "node:child_process";
import { access, readFile, writeFile, unlink, mkdir } from "node:fs/promises";
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

export async function ensureDir(): Promise<void> {
  try {
    await access(MODELWEAVER_DIR);
  } catch {
    await mkdir(MODELWEAVER_DIR, { recursive: true });
  }
}

export async function writePidFile(pid: number): Promise<void> {
  await ensureDir();
  await writeFile(getPidPath(), `${pid}\n`);
}

export async function readPidFile(): Promise<number | null> {
  const pidPath = getPidPath();
  try {
    const content = await readFile(pidPath, "utf-8");
    const pid = parseInt(content.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export async function removePidFile(): Promise<void> {
  const pidPath = getPidPath();
  try {
    await unlink(pidPath);
  } catch {
    // File doesn't exist — nothing to do
  }
}

// ---------------------------------------------------------------------------
// Worker PID helpers (used by monitor to track daemon child)
// ---------------------------------------------------------------------------

export function getWorkerPidPath(): string {
  return join(MODELWEAVER_DIR, "modelweaver.worker.pid");
}

export async function writeWorkerPidFile(pid: number): Promise<void> {
  await ensureDir();
  await writeFile(getWorkerPidPath(), `${pid}\n`);
}

export async function readWorkerPidFile(): Promise<number | null> {
  const pidPath = getWorkerPidPath();
  try {
    const content = await readFile(pidPath, "utf-8");
    const pid = parseInt(content.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export async function removeWorkerPidFile(): Promise<void> {
  const pidPath = getWorkerPidPath();
  try {
    await unlink(pidPath);
  } catch {
    // File doesn't exist — nothing to do
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
// Port-based process discovery (fallback when PID file is missing)
// ---------------------------------------------------------------------------

/** Find PIDs of processes listening on the given TCP port via lsof (async). */
export function findPidsOnPort(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf-8",
      timeout: 3000,
    }, (err, out) => {
      if (err) {
        // lsof returns non-zero when nothing is listening on the port
        resolve([]);
        return;
      }
      const trimmed = (out || "").trim();
      resolve(trimmed ? trimmed.split("\n").map(Number).filter((n) => !isNaN(n)) : []);
    });
  });
}

/** Attempt to load the configured port from the config file (dynamic import to avoid circular deps). */
async function getConfigPort(): Promise<number | null> {
  try {
    const { loadConfig } = await import("./config.js");
    const { config } = loadConfig();
    return config.server.port;
  } catch {
    // Config file missing or invalid — fall back to default
    return 3456;
  }
}

/**
 * Kill a process tree: send SIGTERM, wait up to `timeoutMs`, then SIGKILL.
 * Handles the process and any known child (worker PID file).
 */
async function killProcessTree(pids: number[], timeoutMs: number = 5000): Promise<boolean> {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((p) => !isProcessAlive(p))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Force kill anything still alive
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Daemon status
// ---------------------------------------------------------------------------

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  message: string;
}

export async function statusDaemon(portOverride?: number): Promise<DaemonStatus> {
  const pid = await readPidFile();
  if (pid === null) {
    // PID file missing — try to find the process by configured port
    const port = portOverride ?? await getConfigPort();
    if (port !== null && port > 0) {
      const portPids = await findPidsOnPort(port);
      if (portPids.length > 0) {
        const livePids = portPids.filter((p) => isProcessAlive(p));
        if (livePids.length > 0) {
          return {
            running: true,
            pid: livePids[0],
            message: `ModelWeaver is running (PID ${livePids[0]}, detected on port ${port}; PID file missing)`,
          };
        }
      }
    }
    return { running: false, message: "ModelWeaver is not running (no PID file found)" };
  }
  if (isProcessAlive(pid)) {
    return { running: true, pid, message: `ModelWeaver is running (PID ${pid})` };
  }
  // Stale PID file — process is dead but file remains
  await removePidFile();
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
  // Check if already running (now uses port-based fallback too)
  const currentStatus = await statusDaemon(port);
  if (currentStatus.running) {
    return {
      success: false,
      pid: currentStatus.pid,
      message: `ModelWeaver is already running (PID ${currentStatus.pid})`,
      logPath: getLogPath(),
    };
  }

  // Check if port is already in use
  const effectivePort = port ?? await getConfigPort() ?? 3456;
  if (await isPortInUse(effectivePort)) {
    return {
      success: false,
      message: `Port ${effectivePort} is already in use. Is ModelWeaver or another process running on it?`,
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
    const checkPid = await readPidFile();
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

export async function stopDaemon(portOverride?: number): Promise<DaemonStopResult> {
  const pid = await readPidFile();
  if (pid === null) {
    // PID file missing — try to find the process by configured port
    const port = portOverride ?? await getConfigPort();
    if (port !== null) {
      const portPids = await findPidsOnPort(port);
      const livePids = portPids.filter((p) => isProcessAlive(p));
      if (livePids.length > 0) {
        // Also include the worker PID file if present
        const workerPid = await readWorkerPidFile();
        const pidsToKill = [...livePids];
        if (workerPid !== null && isProcessAlive(workerPid) && !pidsToKill.includes(workerPid)) {
          pidsToKill.push(workerPid);
        }
        await killProcessTree(pidsToKill);
        await removeWorkerPidFile();
        return {
          success: true,
          message: `ModelWeaver stopped (found on port ${port}, PIDs ${livePids.join(", ")}; PID file was missing)`,
        };
      }
    }
    return { success: false, message: "ModelWeaver is not running (no PID file found)" };
  }

  if (!isProcessAlive(pid)) {
    // Monitor is dead — check for orphaned worker and kill it
    const workerPid = await readWorkerPidFile();
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
      await removeWorkerPidFile();
    }
    await removePidFile();
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
      await removePidFile();
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

  await removePidFile();
  return { success: true, message: `ModelWeaver force-stopped (PID ${pid})` };
}

// ---------------------------------------------------------------------------
// Remove (stop + cleanup)
// ---------------------------------------------------------------------------

export async function removeLogFile(): Promise<void> {
  const logPath = getLogPath();
  try {
    await unlink(logPath);
  } catch {
    // File doesn't exist — nothing to do
  }
}

export async function removeDaemon(): Promise<DaemonStopResult> {
  const stopResult = await stopDaemon();
  await removeLogFile();
  await removeWorkerPidFile();
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
