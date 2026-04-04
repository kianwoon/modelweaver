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
    // Use Singapore time (Asia/Singapore) for all log timestamps
    const sgDate = new Date();
    const sgTimestamp = sgDate.toLocaleString("en-SG", { timeZone: "Asia/Singapore", hour12: false }) + "." + String(sgDate.getMilliseconds()).padStart(3, "0");
    const entry = {
      timestamp: sgTimestamp,
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
