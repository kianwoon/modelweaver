// src/index.ts
import { serve } from "@hono/node-server";
import { createApp } from "./server.js";
import { loadConfig } from "./config.js";
import type { LogLevel } from "./logger.js";
import { MetricsStore } from "./metrics.js";
import { attachWebSocket } from "./ws.js";

function parseArgs(argv: string[]): { port?: number; config?: string; verbose: boolean; help: boolean; daemon: boolean; monitor: boolean } {
  const args: { port?: number; config?: string; verbose: boolean; help: boolean; daemon: boolean; monitor: boolean } = { verbose: false, help: false, daemon: false, monitor: false };
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
  init                    Run interactive setup wizard
  start                   Start as background daemon
  stop                    Stop background daemon
  status                  Show daemon status
  remove                  Stop daemon and remove PID + log files

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
    const { runInit } = await import('./init.js');
    await runInit();
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
    const result = statusDaemon();
    console.log(`  ${result.message}`);
    process.exit(0);
  }

  // Handle 'remove' subcommand — stop + clean up PID and log files
  if (process.argv[2] === 'remove') {
    const { removeDaemon } = await import('./daemon.js');
    const result = await removeDaemon();
    console.log(`  ${result.message}`);
    process.exit(result.success ? 0 : 1);
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
    writePidFile(process.pid);

    const entryScript = process.argv[1] || pathJoin(dirname(fileURLToPath(import.meta.url)), "index.js");

    const MAX_RESTARTS = 5;
    const RATE_WINDOW_MS = 60_000;
    const RESTART_DELAY_MS = 2_000;
    let restartTimestamps: number[] = [];
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

      child.on("exit", (code) => {
        removeWorkerPidFile();
        if (code === 0) {
          // Clean shutdown — monitor exits too
          removePidFile();
          process.exit(0);
        }
        // Crash — check rate limit before restarting
        const now = Date.now();
        restartTimestamps = restartTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
        if (restartTimestamps.length >= MAX_RESTARTS) {
          // Too many restarts — give up
          removePidFile();
          process.exit(1);
        }
        restartTimestamps.push(now);
        setTimeout(spawnDaemon, RESTART_DELAY_MS);
      });
    }

    // SIGTERM from `stop` → kill child, then exit
    process.on("SIGTERM", () => {
      if (child) {
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
      }
      removePidFile();
      removeWorkerPidFile();
      process.exit(0);
    });

    process.on("SIGINT", () => {
      if (child) {
        try { child.kill("SIGTERM"); } catch { /* already dead */ }
      }
      removePidFile();
      removeWorkerPidFile();
      process.exit(0);
    });

    spawnDaemon();
    return;
  }

  // --- Daemon mode ---
  if (args.daemon) {
    const { removeWorkerPidFile, writeWorkerPidFile, createDebouncedReload, getLogPath } = await import('./daemon.js');
    const { reloadConfig } = await import('./config.js');
    const { createWriteStream } = await import('node:fs');
    const { createLogger } = await import('./logger.js');
    const logger = createLogger(logLevel);

    // Write worker PID file (monitor owns modelweaver.pid)
    writeWorkerPidFile(process.pid);

    // Redirect stdout/stderr to log file
    const logStream = createWriteStream(getLogPath(), { flags: 'a' });
    process.stdout.write = logStream.write.bind(logStream) as typeof process.stdout.write;
    process.stderr.write = logStream.write.bind(logStream) as typeof process.stderr.write;

    // Create app with mutable config
    const handle = createApp(config, logLevel, metricsStore);

    // Hot-reload: watch config file for changes
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
        const { watchFile } = await import('node:fs');
        watchFile(configPath, { interval: 500 }, () => {
          debounced.reload();
        });
      } catch {
        // fs.watchFile not available — hot-reload disabled
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
    const shutdown = () => {
      removeWorkerPidFile();
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
  console.log(`\n  ModelWeaver v0.1.0`);
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
