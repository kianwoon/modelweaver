// src/index.ts
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { createApp } from "./server.js";
import { loadConfig } from "./config.js";
import type { LogLevel } from "./logger.js";
import { MetricsStore } from "./metrics.js";
import { attachWebSocket } from "./ws.js";

// Read version from package.json at startup
const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;

function parseArgs(argv: string[]): { port?: number; config?: string; verbose: boolean; help: boolean; daemon: boolean; monitor: boolean; gui: boolean } {
  const args: { port?: number; config?: string; verbose: boolean; help: boolean; daemon: boolean; monitor: boolean; gui: boolean } = { verbose: false, help: false, daemon: false, monitor: false, gui: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "-p":
      case "--port":
        const portStr = argv[++i];
        if (!portStr || isNaN(parseInt(portStr, 10))) {
          console.error("Error: -p/--port requires a number");
          process.exit(1);
        }
        args.port = parseInt(portStr, 10);
        break;
      case "-c":
      case "--config":
        const configPath = argv[++i];
        if (!configPath) {
          console.error("Error: -c/--config requires a path");
          process.exit(1);
        }
        args.config = configPath;
        break;
      case "-v":
      case "--verbose":
        args.verbose = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--daemon":
        args.daemon = true;
        break;
      case "--monitor":
        args.monitor = true;
        break;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
ModelWeaver — Multi-provider model orchestration proxy for Claude Code

Usage: modelweaver [command] [options]

Commands:
  init [--quick]          Run interactive setup wizard (--quick for express mode)
  start                   Start as background daemon
  stop                    Stop background daemon
  status                  Show daemon status
  remove                  Stop daemon and remove PID + log files
  install                 Install launchd service (auto-start at login)
  uninstall               Uninstall launchd service
  gui                     Launch the GUI (downloads if needed)

Options:
  -p, --port <number>      Server port                    (default: from config)
  -c, --config <path>      Config file path               (auto-detected)
  -v, --verbose            Enable debug logging           (default: off)
  -h, --help               Show this help

Config locations (first found wins):
  ./modelweaver.yaml
  ~/.modelweaver/config.yaml
`);
}

async function main() {
  const args = parseArgs(process.argv);

  // Load .env file if present (created by modelweaver init)
  try {
    const dotenv = await import('dotenv');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    // Try cwd/.env first, then ~/.modelweaver/.env, then ~/.env
    const paths = [
      join(process.cwd(), '.env'),
      join(home, '.modelweaver', '.env'),
      join(home, '.env'),
    ];
    for (const p of paths) {
      if (existsSync(p)) {
        dotenv.config({ path: p });
        break;
      }
    }
  } catch {
    // dotenv not installed or .env not present — continue without it
  }

  // Handle 'init' subcommand — dynamic import to avoid loading prompts for normal startup
  if (process.argv[2] === 'init') {
    const quick = process.argv.includes('--quick') || process.argv.includes('-q');
    const { runInit } = await import('./init.js');
    await runInit({ quick });
    process.exit(0);
  }

  // Handle 'start' subcommand
  if (process.argv[2] === 'start') {
    const { startDaemon } = await import('./daemon.js');
    const result = await startDaemon(args.config, args.port, args.verbose);
    console.log(`  ${result.message}`);
    console.log(`  Log file: ${result.logPath}`);
    process.exit(result.success ? 0 : 1);
  }

  // Handle 'stop' subcommand
  if (process.argv[2] === 'stop') {
    const { stopDaemon } = await import('./daemon.js');
    const result = await stopDaemon();
    console.log(`  ${result.message}`);
    process.exit(result.success ? 0 : 1);
  }

  // Handle 'status' subcommand
  if (process.argv[2] === 'status') {
    const { statusDaemon } = await import('./daemon.js');
    const result = await statusDaemon();
    console.log(`  ${result.message}`);
    const { isInstalled, getPlistPath, getLabel } = await import('./launchd.js');
    if (isInstalled()) {
      console.log(`  launchd: installed (${getLabel()})`);
      console.log(`  plist: ${getPlistPath()}`);
    } else {
      console.log(`  launchd: not installed (run "modelweaver install" to enable auto-start)`);
    }
    process.exit(0);
  }

  // Handle 'remove' subcommand — stop + clean up PID and log files
  if (process.argv[2] === 'remove') {
    const { removeDaemon } = await import('./daemon.js');
    const result = await removeDaemon();
    console.log(`  ${result.message}`);
    process.exit(result.success ? 0 : 1);
  }

  // Handle 'install' subcommand — install launchd service
  if (process.argv[2] === 'install') {
    const { install: installLaunchd } = await import('./launchd.js');
    installLaunchd();
    process.exit(0);
  }

  // Handle 'uninstall' subcommand — uninstall launchd service
  if (process.argv[2] === 'uninstall') {
    const { uninstall: uninstallLaunchd } = await import('./launchd.js');
    uninstallLaunchd();
    process.exit(0);
  }

  // Handle 'gui' subcommand
  if (process.argv[2] === 'gui') {
    const { launchGui } = await import('./gui-launcher.js');
    await launchGui();
    process.exit(0);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Load config
  let config;
  let configPath;
  try {
    const result = loadConfig(args.config);
    config = result.config;
    configPath = result.configPath;
  } catch (error) {
    console.error(`Config error: ${(error as Error).message}`);
    process.exit(1);
  }

  // CLI port override
  const port = args.port || config.server.port;
  const host = config.server.host;
  const logLevel: LogLevel = args.verbose ? "debug" : "info";

  // Initialize metrics store
  const metricsStore = new MetricsStore();

  // --- Monitor mode (spawns daemon child, auto-restarts on crash) ---
  if (args.monitor) {
    const { spawn } = await import('node:child_process');
    const { writePidFile, removePidFile, removeWorkerPidFile, getLogPath } = await import('./daemon.js');
    const { dirname, join: pathJoin } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    // Monitor writes its own PID to modelweaver.pid
    await writePidFile(process.pid);

    const entryScript = process.argv[1] || pathJoin(dirname(fileURLToPath(import.meta.url)), "index.js");

    // Prevent monitor from crashing on unexpected errors
    process.on('uncaughtException', (err) => {
      console.error(`[monitor] Uncaught exception: ${err.message}`);
    });
    process.on('unhandledRejection', (reason) => {
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
          console.error(`[monitor] Worker stable for ${STABLE_RUN_MS}ms, resetting restart counter`);
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
        if (code === 0) {
          // Clean shutdown — monitor exits too
          await removePidFile();
          process.exit(0);
        }

        // Don't restart if we're shutting down
        if (shuttingDown) {
          console.error("[monitor] Worker exited during shutdown, monitor exiting");
          await removePidFile();
          process.exit(0);
        }

        // Crash — apply exponential backoff restart
        const attempt = restartCount;
        if (attempt >= MAX_RESTART_ATTEMPTS) {
          console.error(`[monitor] Max restart attempts exhausted (${MAX_RESTART_ATTEMPTS}), monitor exiting`);
          await removePidFile();
          process.exit(1);
        }

        const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
        restartCount++;
        console.error(`[monitor] Worker died (code ${code}), restarting in ${backoff}ms (attempt ${restartCount}/${MAX_RESTART_ATTEMPTS})`);

        restartTimer = setTimeout(spawnDaemon, backoff);
      });
    }

    // SIGTERM from `stop` → kill child, then exit cleanly
    process.on("SIGTERM", async () => {
      shuttingDown = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      if (child) {
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
      }
      await removePidFile();
      await removeWorkerPidFile();
      process.exit(0);
    });

    process.on("SIGINT", async () => {
      shuttingDown = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      if (child) {
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
      }
      await removePidFile();
      await removeWorkerPidFile();
      process.exit(0);
    });

    spawnDaemon();
    return;
  }

  // --- Daemon mode ---
  if (args.daemon) {
    const { removeWorkerPidFile, writeWorkerPidFile, createDebouncedReload, getLogPath } = await import('./daemon.js');
    const { reloadConfig } = await import('./config.js');
    const { createWriteStream, watch } = await import('node:fs');
    const { createLogger } = await import('./logger.js');
    const logger = createLogger(logLevel);

    // Prevent silent crashes from killing the daemon worker
    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception (daemon survived)', { error: err.message, stack: err.stack });
    });
    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection (daemon survived)', { reason: String(reason) });
    });

    // Write worker PID file (monitor owns modelweaver.pid)
    await writeWorkerPidFile(process.pid);

    // Redirect stdout/stderr to log file
    const logStream = createWriteStream(getLogPath(), { flags: 'a' });
    logStream.on('error', () => { /* ignore write errors to log file */ });
    process.stdout.write = logStream.write.bind(logStream) as typeof process.stdout.write;
    process.stderr.write = logStream.write.bind(logStream) as typeof process.stderr.write;

    // Create app with mutable config
    const handle = createApp(config, logLevel, metricsStore);

    // Hot-reload: watch config file for changes
    let configWatcher: ReturnType<typeof watch> | null = null;
    if (configPath) {
      const debounced = createDebouncedReload(() => {
        try {
          const newConfig = reloadConfig(configPath);
          handle.setConfig(newConfig);
          logger.info("Config reloaded", { path: configPath });
        } catch (err) {
          logger.error("Config reload failed — keeping old config", { error: (err as Error).message });
        }
      }, 300);

      try {
        configWatcher = watch(configPath, () => {
          debounced.reload();
        });
        configWatcher.on('error', () => {
          // fs.watch failed — silently disable hot-reload
          if (configWatcher) {
            configWatcher.close();
            configWatcher = null;
          }
        });
      } catch {
        // fs.watch not available — hot-reload disabled
      }
    }

    // SIGUSR1 for manual reload signal
    process.on('SIGUSR1', () => {
      try {
        const newConfig = reloadConfig(configPath!);
        handle.setConfig(newConfig);
        logger.info("Config reloaded (SIGUSR1)", { path: configPath });
      } catch (err) {
        logger.error("Config reload failed (SIGUSR1)", { error: (err as Error).message });
      }
    });

    // Start server
    const server = serve({ fetch: handle.app.fetch, hostname: host, port });
    attachWebSocket(server as any, metricsStore);

    // Graceful shutdown
    const shutdown = async () => {
      if (configWatcher) {
        configWatcher.close();
        configWatcher = null;
      }
      await removeWorkerPidFile();
      logStream.end();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return; // Don't fall through to foreground mode
  }

  // --- Foreground mode ---
  const handle = createApp(config, logLevel, metricsStore);

  // Print startup info
  console.log(`\n  ModelWeaver v${VERSION}`);
  console.log(`  Listening: http://${host}:${port}`);
  console.log(`  Config: ${configPath}\n`);

  console.log("  Routes:");
  for (const [tier, entries] of config.routing) {
    const providerList = entries
      .map((e, i) => `${e.provider}${i === 0 ? " (primary)" : " (fallback)"}`)
      .join(", ");
    console.log(`    ${tier.padEnd(8)} → ${providerList}`);
  }
  console.log();

  if (config.modelRouting.size > 0) {
    console.log("  Model Routes:");
    for (const [model, entries] of config.modelRouting) {
      const providerList = entries
        .map((e, i) => `${e.provider}${i === 0 ? " (primary)" : " (fallback)"}`)
        .join(", ");
      console.log(`    ${model.padEnd(20)} → ${providerList}`);
    }
    console.log();
  }

  // Start server
  const server = serve({ fetch: handle.app.fetch, hostname: host, port });
  attachWebSocket(server as any, metricsStore);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n  Shutting down...");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
