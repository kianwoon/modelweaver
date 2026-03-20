// src/logger.ts
export type LogLevel = "info" | "debug" | "warn" | "error";

export interface Logger {
  info: (message: string, data?: Record<string, unknown>) => void;
  debug: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

export function createLogger(level: LogLevel): Logger {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;

  function log(lvl: LogLevel, message: string, data?: Record<string, unknown>) {
    if (levels[lvl] < levels[level]) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level: lvl,
      message,
      ...data,
    };
    process.stdout.write(JSON.stringify(entry) + "\n");
  }

  return {
    info: (msg, data?) => log("info", msg, data),
    debug: (msg, data?) => log("debug", msg, data),
    warn: (msg, data?) => log("warn", msg, data),
    error: (msg, data?) => log("error", msg, data),
  };
}
