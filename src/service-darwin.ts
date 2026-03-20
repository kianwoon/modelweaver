// src/service-darwin.ts — macOS launchd service management
export const platform = "darwin";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const LABEL = "com.modelweaver.daemon";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
const LOG_DIR = join(homedir(), ".modelweaver", "logs");

function getPlistContent(): string {
  // Resolve the entry script path relative to this source file
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const nodePath = join(__dirname, "index.js");
  const workDir = process.cwd();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${nodePath}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${workDir}</string>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stderr.log</string>
</dict>
</plist>`;
}

export function isInstalled(): boolean {
  return existsSync(PLIST_PATH);
}

export function getPlistPath(): string {
  return PLIST_PATH;
}

export function getLabel(): string {
  return LABEL;
}

export function install(): void {
  // Create log directory
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }

  // Create LaunchAgents directory if needed
  if (!existsSync(PLIST_DIR)) {
    mkdirSync(PLIST_DIR, { recursive: true });
  }

  // Write plist file
  writeFileSync(PLIST_PATH, getPlistContent(), "utf-8");

  // Load into launchd immediately (start the service now)
  try {
    execFileSync("launchctl", ["load", PLIST_PATH], { stdio: "pipe" });
    console.log(`  launchd service installed and started: ${PLIST_PATH}`);
  } catch (err) {
    console.error(`  Failed to load service: ${(err as Error).message}`);
    console.log(`  Plist written to ${PLIST_PATH}`);
    console.log(`  Try manually: launchctl load ${PLIST_PATH}`);
  }

  console.log(`  Auto-starts on login (RunAtLoad enabled)`);
  console.log(`  Logs: ${LOG_DIR}/stdout.log and ${LOG_DIR}/stderr.log`);
}

export function uninstall(): void {
  // Unload from launchd if currently loaded
  try {
    execFileSync("launchctl", ["unload", PLIST_PATH], { stdio: "pipe" });
  } catch {
    // Not loaded — that's fine
  }

  // Remove plist file
  try {
    unlinkSync(PLIST_PATH);
  } catch {
    // File doesn't exist — nothing to do
  }

  console.log(`  launchd service uninstalled: ${PLIST_PATH}`);
}
