// src/service-linux.ts — Linux systemd user service management
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

export const platform = "linux";

const SERVICE_DIR = join(homedir(), ".config", "systemd", "user");
const SERVICE_PATH = join(SERVICE_DIR, "modelweaver.service");

function getServiceContent(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const entryScript = join(__dirname, "..", "dist", "index.js");
  const workDir = process.cwd();

  return `[Unit]
Description=modelweaver daemon

[Service]
ExecStart=${process.execPath} ${entryScript} --monitor
WorkingDirectory=${workDir}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

export function isInstalled(): boolean {
  return existsSync(SERVICE_PATH);
}

export function install(): void {
  // Create service directory if needed
  if (!existsSync(SERVICE_DIR)) {
    mkdirSync(SERVICE_DIR, { recursive: true });
  }

  // Write unit file
  writeFileSync(SERVICE_PATH, getServiceContent(), "utf-8");

  // Reload systemd, enable and start the service
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
    execFileSync("systemctl", ["--user", "enable", "modelweaver.service"], { stdio: "pipe" });
    execFileSync("systemctl", ["--user", "start", "modelweaver.service"], { stdio: "pipe" });
    console.log(`  systemd user service installed and started: ${SERVICE_PATH}`);
  } catch (err) {
    console.error(`  Failed to start service: ${(err as Error).message}`);
    console.log(`  Service file written to ${SERVICE_PATH}`);
    console.log(`  Try manually: systemctl --user daemon-reload && systemctl --user enable --now modelweaver.service`);
  }

  console.log(`  Auto-starts on login and auto-restarts if stopped (user-level systemd)`);
}

export function uninstall(): void {
  // Stop and disable the service
  try {
    execFileSync("systemctl", ["--user", "stop", "modelweaver.service"], { stdio: "pipe" });
  } catch {
    // Not running — that's fine
  }

  try {
    execFileSync("systemctl", ["--user", "disable", "modelweaver.service"], { stdio: "pipe" });
  } catch {
    // Not enabled — that's fine
  }

  // Remove unit file
  try {
    unlinkSync(SERVICE_PATH);
  } catch {
    // File doesn't exist — nothing to do
  }

  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
  } catch {
    // Reload failed — non-critical
  }

  console.log(`  systemd user service uninstalled: ${SERVICE_PATH}`);
}
