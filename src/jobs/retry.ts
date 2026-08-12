import { config } from "../config/index.js";
import type { Logger } from "../evidence/logger.js";
import { classifyUnknownError, HarnessError } from "./errors.js";

/**
 * Retry with exponential backoff — for read-only steps only.
 *
 * `safeToRepeat` is a required argument rather than an option with a default,
 * because the dangerous case is the one where somebody forgot to think about
 * it. Navigating, probing and searching are safe to repeat. Submitting a form
 * is not, and no amount of backoff makes it so: a retry after an unknown
 * outcome is how one lead becomes two.
 *
 * Even for safe steps, only INFRA failures are retried. A selector break or an
 * application rejection will fail identically on every attempt; retrying them
 * just delays the report and burns the budget.
 */

export interface RetryOptions {
  step: string;
  /** Must be true for any retry to happen. State-changing steps pass false. */
  safeToRepeat: boolean;
  logger: Logger;
  maxAttempts?: number;
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, so parallel runs do not resynchronise. */
export function backoffDelay(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, 30_000);
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxAttempts = options.safeToRepeat ? (options.maxAttempts ?? config.maxRetries) : 1;
  const baseDelayMs = options.baseDelayMs ?? config.retryBaseDelayMs;

  let lastError: HarnessError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const harnessError = classifyUnknownError(options.step, error);
      lastError = harnessError;

      const canRetry = options.safeToRepeat && harnessError.retryable && attempt < maxAttempts;

      options.logger.warn(
        {
          step: options.step,
          attempt,
          maxAttempts,
          category: harnessError.category,
          willRetry: canRetry,
          error: harnessError.message,
        },
        "Step failed",
      );

      if (!canRetry) throw harnessError;

      await sleep(backoffDelay(attempt, baseDelayMs));
    }
  }

  throw lastError ?? new Error(`Retry loop for ${options.step} exited without a result`);
}
