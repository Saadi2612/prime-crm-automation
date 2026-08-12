import pino from "pino";
import { config } from "../config/index.js";
import { redact, redactString } from "./redact.js";

/**
 * Structured JSON logging. Every line carries a run id, and every line emitted
 * inside a job carries the job id, so a single run can be reconstructed from
 * `grep runId` alone.
 *
 * All values pass through `redact()` on the way out — that is deliberate
 * belt-and-braces: callers are expected to log identifiers, and the redactor
 * catches them when they forget.
 */

export interface LogContext {
  runId: string;
  jobId?: string;
  step?: string;
  [key: string]: unknown;
}

const base = pino({
  level: config.logLevel,
  base: undefined, // drop pid/hostname noise
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  hooks: {
    logMethod(args, method) {
      const [first, ...rest] = args;
      if (typeof first === "object" && first !== null) {
        const message = typeof rest[0] === "string" ? redactString(rest[0]) : rest[0];
        return method.apply(this, [redact(first) as object, message, ...rest.slice(1)] as never);
      }
      if (typeof first === "string") {
        return method.apply(this, [redactString(first), ...rest] as never);
      }
      return method.apply(this, args as never);
    },
  },
});

export type Logger = pino.Logger;

export function createLogger(context: LogContext): Logger {
  return base.child(context as Record<string, unknown>);
}

export const rootLogger = base;
