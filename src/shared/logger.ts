interface LogContext {
  agentId?: string;
  sessionId?: string;
  functionId?: string;
  duration?: number;
  [key: string]: unknown;
}

interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
}

export function createLogger(module: string): Logger {
  function emit(level: string, message: string, context?: LogContext): void {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
    };
    if (context) {
      for (const [k, v] of Object.entries(context)) {
        if (v !== undefined) entry[k] = v;
      }
    }
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
    debug: (msg, ctx) => {
      if (process.env.LOG_LEVEL === "debug") emit("debug", msg, ctx);
    },
  };
}
