import { platform } from "node:os";

interface PlatformService {
  install(): void | Promise<void>;
  uninstall(): void;
  isInstalled(): boolean;
}

let _service: PlatformService | null = null;

export async function getService(): Promise<PlatformService> {
  if (_service) return _service;

  let mod: { install: () => void | Promise<void>; uninstall: () => void; isInstalled: () => boolean };
  switch (platform()) {
    case "darwin":
      mod = await import("./service-darwin.js");
      break;
    case "linux":
      mod = await import("./service-linux.js");
      break;
    case "win32":
      mod = await import("./service-win32.js");
      break;
    default:
      throw new Error(
        `Platform "${platform()}" is not supported. Supported: macOS (darwin), Linux, Windows`
      );
  }
  _service = { install: mod.install, uninstall: mod.uninstall, isInstalled: mod.isInstalled };
  return _service;
}
