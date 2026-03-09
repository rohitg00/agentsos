import { getContext } from "iii-sdk";

interface LogContext {
  [key: string]: unknown;
}

interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
}

export function createLogger(module: string): Logger {
  function trySDKLogger() {
    try {
      return getContext().logger;
    } catch {
      return null;
    }
  }

  function emit(level: string, message: string, context?: LogContext): void {
    const sdkLogger = trySDKLogger();
    const data = context ? { module, ...context } : { module };

    if (sdkLogger) {
      switch (level) {
        case "error": sdkLogger.error(message, data); break;
        case "warn": sdkLogger.warn(message, data); break;
        case "debug": sdkLogger.debug(message, data); break;
        default: sdkLogger.info(message, data); break;
      }
    } else {
      const entry = { timestamp: new Date().toISOString(), level, module, message, ...context };
      const line = JSON.stringify(entry);
      if (level === "error") {
        process.stderr.write(line + "\n");
      } else {
        process.stdout.write(line + "\n");
      }
    }
  }

  return {
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
    debug: (msg, ctx) => emit("debug", msg, ctx),
  };
}
