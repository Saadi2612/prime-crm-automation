/**
 * Failure taxonomy.
 *
 * These three categories exist because they demand different responses, and
 * collapsing them is how automation quietly corrupts data:
 *
 *  SELECTOR_BREAK — the page loaded fine, but an element we require is absent.
 *      The CRM's UI changed. Retrying cannot help; a human must fix the
 *      selector. Never retried.
 *
 *  APP_ERROR      — the page loaded, the element was there, and the application
 *      rejected our input (validation message, permission denied). The payload
 *      is wrong, not the harness. Never retried with the same input.
 *
 *  INFRA          — timeout, connection reset, browser crash. Nothing is known
 *      about the application state. Safe to retry *only* for steps that are
 *      idempotent by construction.
 *
 * AMBIGUOUS_WRITE is deliberately separate from all three: the submit fired but
 * the confirmation could not be read. That is not a failure to retry, it is a
 * question only a human can answer.
 */

export type FailureCategory =
  | "SELECTOR_BREAK"
  | "APP_ERROR"
  | "INFRA"
  | "AMBIGUOUS_WRITE"
  | "VALIDATION";

export class HarnessError extends Error {
  readonly category: FailureCategory;
  readonly step: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    category: FailureCategory,
    step: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "HarnessError";
    this.category = category;
    this.step = step;
    this.details = options.details ?? {};
    // Only INFRA is retryable by default, and the runner still gates that on
    // whether the individual step declared itself safe to repeat.
    this.retryable = options.retryable ?? category === "INFRA";
  }
}

export class SelectorBreakError extends HarnessError {
  constructor(step: string, testId: string, options: { url?: string; cause?: unknown } = {}) {
    super(
      "SELECTOR_BREAK",
      step,
      `Element [data-testid="${testId}"] not found on a page that loaded successfully`,
      { retryable: false, details: { testId, url: options.url }, cause: options.cause },
    );
    this.name = "SelectorBreakError";
  }
}

export class ApplicationError extends HarnessError {
  constructor(step: string, message: string, details: Record<string, unknown> = {}) {
    super("APP_ERROR", step, message, { retryable: false, details });
    this.name = "ApplicationError";
  }
}

export class InfrastructureError extends HarnessError {
  constructor(step: string, message: string, options: { cause?: unknown } = {}) {
    super("INFRA", step, message, { retryable: true, cause: options.cause });
    this.name = "InfrastructureError";
  }
}

export class AmbiguousWriteError extends HarnessError {
  constructor(step: string, message: string, details: Record<string, unknown> = {}) {
    super("AMBIGUOUS_WRITE", step, message, { retryable: false, details });
    this.name = "AmbiguousWriteError";
  }
}

export class ValidationError extends HarnessError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("VALIDATION", "validate", message, { retryable: false, details });
    this.name = "ValidationError";
  }
}

/**
 * Classify a raw Playwright/Node error when no explicit category was assigned.
 * Timeouts and network faults are infrastructure; everything unrecognised is
 * treated as infrastructure too, but flagged so it shows up in the metrics as
 * something to categorise properly later.
 */
export function classifyUnknownError(step: string, error: unknown): HarnessError {
  if (error instanceof HarnessError) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (/timeout|timed out|exceeded/i.test(message)) {
    return new InfrastructureError(step, `Timed out: ${message}`, { cause: error });
  }
  if (/net::|ECONNREFUSED|ECONNRESET|ENOTFOUND|socket hang up|browser has been closed/i.test(message)) {
    return new InfrastructureError(step, `Network or browser fault: ${message}`, { cause: error });
  }

  return new InfrastructureError(step, `Unclassified failure: ${message}`, { cause: error });
}
