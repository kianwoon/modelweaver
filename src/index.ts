// src/index.ts
import { serve } from "@hono/node-server";
import { createApp } from "./server.js";
import { loadConfig } from "./config.js";
import type { LogLevel } from "./logger.js";

function parseArgs(argv: string[]): { port?: number; config?: string; verbose: boolean; help: boolean } {
  const args: { port?: number; config?: string; verbose: boolean; help: boolean } = { verbose: false, help: false };
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
    dotenv.config();
  } catch {
    // dotenv not installed or .env not present — continue without it
  }

  // Handle 'init' subcommand — dynamic import to avoid loading prompts for normal startup
  if (process.argv[2] === 'init') {
    const { runInit } = await import('./init.js');
    await runInit();
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

  // Create app
  const app = createApp(config, logLevel);

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
  serve({ fetch: app.fetch, hostname: host, port });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n  Shutting down...");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
