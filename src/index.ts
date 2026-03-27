// src/index.ts
import { createAdaptorServer } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { createApp } from "./server.js";
import { loadConfig } from "./config.js";
import type { LogLevel } from "./logger.js";
import { MetricsStore } from "./metrics.js";
import { latencyTracker } from "./hedging.js";
import { attachWebSocket, closeWebSocket } from "./ws.js";
import { startMonitor } from "./monitor.js";

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
  reload                  Reload daemon worker (load fresh code after build)
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
        dotenv.config({ path: p, quiet: true, override: true });
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
    try {
      const { getService } = await import('./service.js');
      const svc = await getService();
      const installed = svc.isInstalled();
      if (installed) {
        console.log(`  Service: installed`);
      } else {
        console.log(`  Service: not installed (run "modelweaver install" to enable auto-start)`);
      }
    } catch (err) {
      console.log(`  Service: ${err instanceof Error ? err.message : String(err)}`);
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

  // Handle 'install' subcommand — install platform service
  if (process.argv[2] === 'install') {
    try {
      const { getService } = await import('./service.js');
      const svc = await getService();
      await svc.install();
    } catch (err) {
      console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Handle 'uninstall' subcommand — uninstall platform service
  if (process.argv[2] === 'uninstall') {
    try {
      const { getService } = await import('./service.js');
      const svc = await getService();
      svc.uninstall();
    } catch (err) {
      console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Handle 'gui' subcommand
  if (process.argv[2] === 'gui') {
    const { launchGui } = await import('./gui-launcher.js');
    await launchGui();
    process.exit(0);
  }

  // Handle 'reload' subcommand
  if (process.argv[2] === 'reload') {
    const { reloadDaemon } = await import('./daemon.js');
    await reloadDaemon(args.port);
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
    const result = await loadConfig(args.config);
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
    await startMonitor(args);
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
      const debounced = createDebouncedReload(async () => {
        try {
          const newConfig = await reloadConfig(configPath);
          await handle.setConfig(newConfig);
          latencyTracker.prune([...newConfig.providers.keys()]);
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

    // SIGUSR1 triggers config hot-reload
    // Note: SIGUSR1 is POSIX-only; this handler is a no-op on Windows.
    process.on('SIGUSR1', async () => {
      try {
        const newConfig = await reloadConfig(configPath!);
        await handle.setConfig(newConfig);
        latencyTracker.prune([...newConfig.providers.keys()]);
        logger.info("Config reloaded (SIGUSR1)", { path: configPath });
      } catch (err) {
        logger.error("Config reload failed (SIGUSR1)", { error: (err as Error).message });
      }
    });

    // Start server — register error handler BEFORE listen() so EADDRINUSE is caught
    const server = createAdaptorServer({
      fetch: handle.app.fetch,
      hostname: host,
      port,
      serverOptions: {
        requestTimeout: 300_000,   // 5 min max total request time (covers long SSE streams)
        headersTimeout: 10_000,    // 10s to receive headers
        keepAliveTimeout: 30_000,  // 30s keep-alive (matches undici agent)
      },
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`Port ${port} already in use, exiting for monitor restart`, { port });
        process.exit(1);
      }
    });
    server.listen(port, host);
    attachWebSocket(server as any, metricsStore);

    // Graceful shutdown
    const shutdown = async () => {
      if (configWatcher) {
        configWatcher.close();
        configWatcher = null;
      }
      closeWebSocket();
      await handle.closeAgents();
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

  // Start server — register error handler BEFORE listen() so EADDRINUSE is caught
  const server = createAdaptorServer({
    fetch: handle.app.fetch,
    hostname: host,
    port,
    serverOptions: {
      requestTimeout: 300_000,   // 5 min max total request time (covers long SSE streams)
      headersTimeout: 10_000,    // 10s to receive headers
      keepAliveTimeout: 30_000,  // 30s keep-alive (matches undici agent)
    },
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} already in use, exiting for monitor restart`);
      process.exit(1);
    }
  });
  server.listen(port, host);
  attachWebSocket(server as any, metricsStore);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n  Shutting down...");
    closeWebSocket();
    await handle.closeAgents();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
