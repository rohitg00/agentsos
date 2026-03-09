import { getContext } from "iii-sdk";

type LogFn = (message: string, context?: Record<string, unknown>) => void;

export function createLogger(module: string): Record<"info" | "warn" | "error" | "debug", LogFn> {
  function emit(level: string, message: string, context?: Record<string, unknown>): void {
    const data = context ? { module, ...context } : { module };

    try {
      const logger = getContext().logger;
      if (logger) {
        (logger as any)[level]?.(message, data) ?? logger.info(message, data);
        return;
      }
    } catch {}

    const entry = { timestamp: new Date().toISOString(), level, module, message, ...context };
    const line = JSON.stringify(entry);
    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  return {
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
    debug: (msg, ctx) => emit("debug", msg, ctx),
  };
}
