// src/daemon.ts — Daemon lifecycle management for background mode
import { spawn, execFile, execFileSync } from "node:child_process";
import { access, readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveEntryScript } from "./entry-path.js";
import { createServer } from "node:net";

function isWindows(): boolean {
  return process.platform === "win32";
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MODELWEAVER_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".modelweaver"
);

/** Override for getConfigPort — used by tests to prevent port scanning */
let _configPortOverride: number | null = null;

/** Set a config port override (0 = skip port-based discovery). Used by tests. */
export function _setConfigPortOverride(port: number | null): void {
  _configPortOverride = port;
}

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
  // Use 'w' (overwrite) instead of 'wx' (exclusive create).
  // The caller (startMonitor) already removes stale PID files before calling
  // this, but launchd's KeepAlive can respawn the monitor between the unlink
  // and write — causing 'wx' to silently fail. Overwrite is always correct here.
  await writeFile(getPidPath(), `${pid}\n`, 'utf-8');
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

/** Find PIDs of processes listening on the given TCP port via lsof (async).
 *  NOTE: lsof is unavailable on Windows — port-based discovery silently skips on that platform.
 */
/** Find the monitor PID from a list by checking process args for --monitor. */
async function findMonitorPid(pids: number[]): Promise<number | null> {
  if (pids.length === 0) return null;
  const { execFileSync } = await import("node:child_process");
  for (const pid of pids) {
    try {
      const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 });
      if (out.includes("--monitor")) return pid;
    } catch { /* skip */ }
  }
  return null;
}

export function findPidsOnPort(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    if (isWindows()) {
      try {
        execFile("netstat", ["-ano"], { encoding: "utf-8", timeout: 3000 }, (err, out) => {
          if (err) { resolve([]); return; }
          const pids: number[] = [];
          for (const line of (out || "").split("\n")) {
            if (line.includes("LISTENING") && line.includes(`:${port}`)) {
              const parts = line.trim().split(/\s+/);
              const pid = parseInt(parts[parts.length - 1], 10);
              if (!isNaN(pid) && pid > 0) pids.push(pid);
            }
          }
          resolve(pids);
        });
      } catch {
        resolve([]);
        return;
      }
      return;
    }
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
export async function getConfigPort(configPath?: string | null): Promise<number | null> {
  if (_configPortOverride !== null) return _configPortOverride;
  try {
    const { loadConfig } = await import("./config.js");
    const { config } = await loadConfig(configPath ?? undefined);
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
    try {
      // Try process group kill first (kills all children)
      process.kill(-pid, "SIGTERM");
    } catch {
      // Fall back to individual kill if process group doesn't exist
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((p) => !isProcessAlive(p))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Force kill anything still alive
  for (const pid of pids) {
    if (isWindows()) {
      try {
        execFileSync("taskkill", ["/F", "/PID", String(pid), "/T"], { stdio: "ignore" });
      } catch {
        // taskkill may fail if process already exited
      }
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Fall back to individual kill if process group doesn't exist
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
    }
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
      success: true,
      pid: currentStatus.pid,
      message: `ModelWeaver is already running (PID ${currentStatus.pid})`,
      logPath: getLogPath(),
    };
  }

  // Determine effective port for port-wait logic
  const effectivePort = port ?? await getConfigPort() ?? 3456;

  // Wait for port to be fully free (old worker may linger briefly after stop)
  for (let i = 0; i < 20; i++) {
    if (!(await isPortInUse(effectivePort))) break;
    await new Promise(r => setTimeout(r, 100));
  }

  // Check if port is still in use after wait
  if (await isPortInUse(effectivePort)) {
    return {
      success: false,
      message: `Port ${effectivePort} is already in use. Is ModelWeaver or another process running on it?`,
      logPath: getLogPath(),
    };
  }

  // Resolve the entry script path
  const entryScript = resolveEntryScript();

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

  // Re-enable launchd KeepAlive so it auto-restarts the daemon if killed
  await reloadLaunchdService();

  return {
    success: true,
    pid,
    message: `ModelWeaver started in background (PID ${pid})`,
    logPath: getLogPath(),
  };
}

// ---------------------------------------------------------------------------
// Reload launchd service (macOS) — re-enables KeepAlive after stop unloads it
// ---------------------------------------------------------------------------

async function reloadLaunchdService(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    const { existsSync } = await import("node:fs");
    const plistPath = join(
      process.env.HOME || process.env.USERPROFILE || "",
      "Library", "LaunchAgents", "com.modelweaver.daemon.plist"
    );
    if (existsSync(plistPath)) {
      const { execFileSync } = await import("node:child_process");
      execFileSync("launchctl", ["load", plistPath], { stdio: "pipe" });
      console.warn("[daemon] Reloaded launchd service — KeepAlive re-enabled");
    }
  } catch {
    // Not macOS or plist missing — skip
  }
}

// ---------------------------------------------------------------------------
// Daemon stop
// ---------------------------------------------------------------------------

export interface DaemonStopResult {
  success: boolean;
  message: string;
}

export async function stopDaemon(portOverride?: number): Promise<DaemonStopResult> {
  // Unload launchd service FIRST to prevent KeepAlive from respawning
  // the daemon while we're trying to stop/rebuild it. Without this,
  // launchd immediately restarts `node dist/index.js start` after we kill
  // the monitor — loading stale code and disrupting the rebuild process.
  if (process.platform === "darwin") {
    try {
      const { execFileSync } = await import('node:child_process');
      const plistPath = join(
        process.env.HOME || process.env.USERPROFILE || "",
        "Library", "LaunchAgents", "com.modelweaver.daemon.plist"
      );
      execFileSync("launchctl", ["unload", plistPath], { stdio: "pipe" });
      console.warn("[daemon] Unloaded launchd service to prevent auto-restart during stop");
    } catch {
      // Not loaded or not macOS — that's fine
    }
  }

  const pid = await readPidFile();
  if (pid === null) {
    // PID file missing — try to find the process by configured port
    const port = portOverride ?? await getConfigPort();
    if (port !== null && port > 0) {
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
    return { success: true, message: "ModelWeaver is not running" };
  }

  if (!isProcessAlive(pid)) {
    // Monitor is dead — check for orphaned worker and kill it
    const workerPid = await readWorkerPidFile();
    if (workerPid !== null && isProcessAlive(workerPid)) {
      await killProcessTree([workerPid]);
      await removeWorkerPidFile();
    }
    await removePidFile();
    return { success: true, message: "ModelWeaver is not running (stale PID file cleaned up)" };
  }

  // Read worker PID for the wait loop (do NOT kill it yet — see below).
  const workerPid = await readWorkerPidFile();

  // Kill MONITOR first to prevent respawn race condition.
  // If we kill the worker first, the monitor's child.on('exit') handler
  // queues a setTimeout(spawnDaemon, backoff) before it receives SIGTERM —
  // creating an orphaned worker if the timer fires in that gap. Killing the
  // monitor first sets its `shuttingDown` flag, so when it kills the child
  // in its own SIGTERM handler, the child's exit handler skips the restart.
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { success: false, message: `Failed to stop daemon (PID ${pid})` };
  }
  // Wait for BOTH to die
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const monitorDead = !isProcessAlive(pid);
    const workerDead = workerPid === null || !isProcessAlive(workerPid);
    if (monitorDead && workerDead) {
      await removePidFile();
      await removeWorkerPidFile();
      return { success: true, message: `ModelWeaver stopped (monitor PID ${pid}, worker PID ${workerPid})` };
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // Force kill anything still running
  if (workerPid !== null && isProcessAlive(workerPid)) {
    try {
      if (isWindows()) {
        execFileSync("taskkill", ["/F", "/PID", String(workerPid), "/T"], { stdio: "ignore" });
      } else {
        process.kill(workerPid, "SIGKILL");
      }
    } catch { /* already dead */ }
  }
  if (isProcessAlive(pid)) {
    try {
      if (isWindows()) {
        execFileSync("taskkill", ["/F", "/PID", String(pid), "/T"], { stdio: "ignore" });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch { /* already dead */ }
  }

  await removePidFile();
  await removeWorkerPidFile();
  return { success: true, message: `ModelWeaver force-stopped (monitor PID ${pid}, worker PID ${workerPid})` };
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
// Daemon reload (SIGHUP to monitor → restart worker with fresh code)
// ---------------------------------------------------------------------------

export async function reloadDaemon(portOverride?: number): Promise<void> {
  const pid = await readPidFile();
  if (pid === null) {
    // PID file missing — try to find the monitor by configured port
    const port = portOverride ?? await getConfigPort();
    if (port !== null && port > 0) {
      const portPids = await findPidsOnPort(port);
      const livePids = portPids.filter((p) => isProcessAlive(p));
      if (livePids.length > 0) {
        // Find the MONITOR process (has --monitor in argv) — only the monitor
        // handles SIGHUP for reload. Sending SIGHUP to the worker would crash it.
        const monitorPid = await findMonitorPid(livePids);
        if (monitorPid) {
          try { process.kill(monitorPid, "SIGHUP"); } catch { /* ignore */ }
          console.log(`  Sent reload signal to monitor (PID ${monitorPid}) on port ${port}.`);
          return;
        }
        // Fallback: send SIGHUP to first PID (might be monitor or worker)
        try {
          if (isWindows()) {
            console.log(`  Windows detected — reload signal not supported. Use 'modelweaver stop && modelweaver start' instead.`);
          } else {
            process.kill(livePids[0], "SIGHUP");
          }
          console.log(`  Sent reload signal to PID ${livePids[0]} on port ${port} (PID file missing, guessed monitor).`);
        } catch { /* ignore */ }
        return;
      }
    }
    console.log("  Daemon is not running.");
    return;
  }

  if (!isProcessAlive(pid)) {
    await removePidFile();
    console.log("  Daemon is not running (stale PID file cleaned up).");
    return;
  }

  try {
    if (isWindows()) {
      // Windows has no SIGHUP — kill the worker directly so monitor restarts it
      const workerPid = await readWorkerPidFile();
      if (workerPid !== null) {
        process.kill(workerPid, "SIGTERM");
        console.log(`  Killed worker (PID ${workerPid}) on Windows — monitor will restart it.`);
      } else {
        console.log("  No worker PID file found — cannot reload.");
      }
    } else {
      process.kill(pid, "SIGHUP");
      console.log(`  Sent reload signal to daemon (PID ${pid}).`);
    }
  } catch {
    console.log("  Failed to send reload signal — daemon may not be running.");
  }
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
