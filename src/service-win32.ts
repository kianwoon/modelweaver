// src/service-win32.ts — Windows startup folder service management
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveEntryScript } from "./entry-path.js";

export const platform = "win32";

const STARTUP_FOLDER = join(
  process.env.APPDATA || "",
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "Startup"
);
const VBS_PATH = join(STARTUP_FOLDER, "modelweaver.vbs");

function getEntryScript(): string {
  return resolveEntryScript();
}

function getVbsContent(): string {
  const entryScript = getEntryScript();
  const workDir = process.cwd();

  return `Set WshShell = CreateObject("WScript.Shell")
Do While True
  WshShell.Run "cmd /c cd /d ""${workDir}"" && ""${process.execPath}"" ""${entryScript}"" start", 0, True
  ' Wait 3 seconds before restarting
  WScript.Sleep 3000
Loop
`;
}

export function isInstalled(): boolean {
  return existsSync(VBS_PATH);
}

export async function install(): Promise<void> {
  // Create startup folder if needed
  if (!existsSync(STARTUP_FOLDER)) {
    mkdirSync(STARTUP_FOLDER, { recursive: true });
  }

  // Write VBS script to startup folder
  writeFileSync(VBS_PATH, getVbsContent(), "utf-8");

  console.log(`  Windows startup entry installed: ${VBS_PATH}`);
  console.log(`  Auto-starts on login and auto-restarts if stopped (startup folder watchdog)`);
  console.log("  Daemon will auto-restart if it crashes or is stopped");

  // Start daemon immediately (don't wait for next login)
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [getEntryScript(), "start"], { detached: true, stdio: "ignore" });
    child.unref();
    console.log("  Daemon started immediately.");
  } catch {
    console.log("  Warning: could not start daemon automatically.");
  }
}

export function uninstall(): void {
  try {
    unlinkSync(VBS_PATH);
  } catch {
    // File doesn't exist — nothing to do
  }

  console.log(`  Windows startup entry uninstalled: ${VBS_PATH}`);
}
