import { Logger } from "iii-sdk";

type LogFn = (message: string, context?: Record<string, unknown>) => void;

export function createLogger(module: string): Record<"info" | "warn" | "error" | "debug", LogFn> {
  const logger = new Logger();
  return {
    info: (message, context) =>
      logger.info(message, context ? { module, ...context } : { module }),
    warn: (message, context) =>
      logger.warn(message, context ? { module, ...context } : { module }),
    error: (message, context) =>
      logger.error(message, context ? { module, ...context } : { module }),
    debug: (message, context) =>
      logger.info(message, context ? { module, level: "debug", ...context } : { module, level: "debug" }),
  };
}
