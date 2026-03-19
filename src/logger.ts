// src/logger.ts
export type LogLevel = "info" | "debug" | "error";

export interface Logger {
  info: (message: string, data?: Record<string, unknown>) => void;
  debug: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

export function createLogger(level: LogLevel): Logger {
  const levels = { debug: 0, info: 1, error: 2 } as const;

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
    error: (msg, data?) => log("error", msg, data),
  };
}
