// src/monitor.ts — Monitor mode: spawns daemon child, auto-restarts on crash
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { writePidFile, removePidFile, removeWorkerPidFile, getPidPath } from "./daemon.js";

export async function startMonitor(args: {
  config?: string;
  port?: number;
  verbose: boolean;
}): Promise<void> {
  // Monitor writes its own PID to modelweaver.pid
  // Clean up any stale PID file left by a previous run
  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
  await writePidFile(process.pid);

  const entryScript =
    process.argv[1] || pathJoin(dirname(fileURLToPath(import.meta.url)), "index.js");

  // Prevent monitor from crashing on unexpected errors
  process.on("uncaughtException", (err) => {
    console.error(`[monitor] Uncaught exception: ${err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[monitor] Unhandled rejection: ${reason}`);
  });

  const MAX_RESTART_ATTEMPTS = 10;
  const INITIAL_BACKOFF_MS = 1000;
  const MAX_BACKOFF_MS = 30000;
  const STABLE_RUN_MS = 60000;
  let restartCount = 0;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;
  let reloading = false;
  let child: ReturnType<typeof spawn> | null = null;

  function spawnDaemon(): void {
    const childArgs: string[] = [entryScript, "--daemon"];
    if (args.config) childArgs.push("--config", args.config);
    if (args.port) childArgs.push("--port", String(args.port));
    if (args.verbose) childArgs.push("--verbose");

    child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    // NOTE: do NOT child.unref() here — the monitor must stay alive to watch the child

    // Start stability timer — if worker lives this long, reset restart counter
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (restartCount > 0) {
        console.error(
          `[monitor] Worker stable for ${STABLE_RUN_MS}ms, resetting restart counter`,
        );
      }
      restartCount = 0;
      stableTimer = null;
    }, STABLE_RUN_MS);

    child.on("exit", async (code) => {
      child = null;

      // Clear stability timer — worker died before becoming stable
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }

      await removeWorkerPidFile();
      if (code === 0 && !reloading) {
        // Clean shutdown — monitor exits too
        await removePidFile();
        process.exit(0);
      }
      reloading = false;

      // Don't restart if we're shutting down
      if (shuttingDown) {
        console.error("[monitor] Worker exited during shutdown, monitor exiting");
        await removePidFile();
        process.exit(0);
      }

      // Crash — apply exponential backoff restart
      const attempt = restartCount;
      if (attempt >= MAX_RESTART_ATTEMPTS) {
        console.error(
          `[monitor] Max restart attempts exhausted (${MAX_RESTART_ATTEMPTS}), monitor exiting`,
        );
        await removePidFile();
        process.exit(1);
      }

      const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      restartCount++;
      console.error(
        `[monitor] Worker died (code ${code}), restarting in ${backoff}ms (attempt ${restartCount}/${MAX_RESTART_ATTEMPTS})`,
      );

      restartTimer = setTimeout(spawnDaemon, backoff);
    });
  }

  // SIGTERM from `stop` → kill child, then exit cleanly
  // Does NOT register a second `exit` listener on the child. Instead, relies on
  // the existing child exit handler (registered in spawnDaemon) which already
  // checks `shuttingDown` and performs cleanup + process.exit(0).
  process.on("SIGTERM", () => {
    shuttingDown = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      // Child exit handler will clean up pid files and call process.exit(0).
      // Safety: if child doesn't exit within 5 s, force exit.
      setTimeout(() => {
        console.error("[monitor] Child did not exit within 5 s, forcing exit");
        process.exit(0);
      }, 5000);
    } else {
      // Child already dead — clean up and exit.
      removePidFile().then(() => process.exit(0));
    }
  });

  // SIGINT (Ctrl-C) — same pattern as SIGTERM.
  process.on("SIGINT", () => {
    shuttingDown = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      // Child exit handler will clean up pid files and call process.exit(0).
      // Safety: if child doesn't exit within 5 s, force exit.
      setTimeout(() => {
        console.error("[monitor] Child did not exit within 5 s, forcing exit");
        process.exit(0);
      }, 5000);
    } else {
      // Child already dead — clean up and exit.
      removePidFile().then(() => process.exit(0));
    }
  });

  // SIGHUP from `reload` → gracefully kill current worker so monitor restarts it
  // Note: SIGHUP is POSIX-only; this handler is a no-op on Windows.
  process.on("SIGHUP", () => {
    console.log("[monitor] Received reload signal, restarting worker...");
    reloading = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    // Reset restart count — this is an intentional restart, not a crash
    restartCount = 0;
  });

  spawnDaemon();
}
