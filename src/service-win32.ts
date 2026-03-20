// src/service-win32.ts — Windows startup folder service management
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

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

function getVbsContent(): string {
  const __dirname = dirname(new URL(import.meta.url).pathname);
  const entryScript = join(__dirname, "..", "dist", "index.js");
  const workDir = process.cwd();

  return `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d ""${workDir}"" && ""${process.execPath}"" ""${entryScript}"" start", 0, False
`;
}

export function isInstalled(): boolean {
  return existsSync(VBS_PATH);
}

export function install(): void {
  // Create startup folder if needed
  if (!existsSync(STARTUP_FOLDER)) {
    mkdirSync(STARTUP_FOLDER, { recursive: true });
  }

  // Write VBS script to startup folder
  writeFileSync(VBS_PATH, getVbsContent(), "utf-8");

  console.log(`  Windows startup entry installed: ${VBS_PATH}`);
  console.log(`  Auto-starts on login (startup folder)`);
}

export function uninstall(): void {
  try {
    unlinkSync(VBS_PATH);
  } catch {
    // File doesn't exist — nothing to do
  }

  console.log(`  Windows startup entry uninstalled: ${VBS_PATH}`);
}
