import { chromium, type Browser } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { config, loadCredentials, type Credentials } from "../config/index.js";
import { captureEvidence, ensureArtifactDir, saveTrace } from "../evidence/capture.js";
import { createLogger, type Logger } from "../evidence/logger.js";
import { RunMetrics } from "../evidence/metrics.js";
import { registerSecret, summarizePayload } from "../evidence/redact.js";
import { openSession, type SessionHandle } from "../session/index.js";
import { LeadsPage } from "../pages/leads.page.js";
import { toConfidenceMap, validateLead } from "../validate/confidence.js";
import type { LeadPayload } from "../validate/schema.js";
import { classifyUnknownError, ValidationError } from "./errors.js";
import { idempotencyKey, shortKey } from "./idempotency.js";
import { withRetry } from "./retry.js";
import { JobStore, type JobRecord } from "./store.js";

/**
 * Start tracing on a session's context, tolerating a context that is already
 * being traced. Returns whether we own the trace and must therefore stop it.
 */
async function startTracing(session: SessionHandle, logger: Logger): Promise<boolean> {
  try {
    await session.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    return true;
  } catch (error) {
    // "Tracing has been already started" — someone else owns it. Leave it alone.
    logger.debug(
      { step: "evidence.trace", error: String(error) },
      "Context is already being traced; not starting a second trace",
    );
    return false;
  }
}

/**
 * The job runner.
 *
 * Ordering here is the whole design. Cheap and reversible work happens first,
 * the irreversible write happens last, and every step before it can be repeated
 * safely:
 *
 *   validate → dedupe (local) → session → dedupe (CRM) → write → confirm
 *
 * Validation before the browser: no point burning a login on a payload that
 * cannot be submitted. Local dedupe before the session: no point logging in to
 * discover we already did this. CRM dedupe after the session but before the
 * write: the local database cannot see records created by anyone else.
 */

export interface RunOptions {
  payload: Record<string, unknown>;
  confidence?: Record<string, number>;
  credentials?: Credentials;
  store?: JobStore;
  runId?: string;
  logger?: Logger;
  /** Approving from the review queue resumes here, past the confidence gate. */
  resumeJobId?: string;
  /** Test hook: rename a testid to simulate the CRM's markup changing. */
  selectorOverrides?: Record<string, string>;
}

export interface RunResult {
  runId: string;
  job: JobRecord;
  metrics: ReturnType<RunMetrics["snapshot"]>;
  /** True when a duplicate was detected and no write was performed. */
  skippedDuplicate: boolean;
  artifactDir: string;
}

export class JobRunner {
  private readonly store: JobStore;
  private readonly ownsStore: boolean;

  constructor(store?: JobStore) {
    this.store = store ?? new JobStore();
    this.ownsStore = !store;
  }

  close(): void {
    if (this.ownsStore) this.store.close();
  }

  async run(options: RunOptions): Promise<RunResult> {
    const runId = options.runId ?? randomUUID();
    const credentials = options.credentials ?? loadCredentials();

    // Registering the secrets makes them unprintable for the rest of the process.
    registerSecret(credentials.password);
    registerSecret(credentials.totpSecret);

    const logger = options.logger ?? createLogger({ runId });
    const metrics = new RunMetrics(runId);
    const artifactDir = ensureArtifactDir(runId);

    logger.info({ step: "run.start", tenant: credentials.tenant }, "Run started");

    // ── 1. Validate before touching the browser ───────────────────────────
    let job: JobRecord;
    let payload: LeadPayload;
    let needsReview: boolean;

    try {
      const outcome = await metrics.time("validate", async () =>
        validateLead(options.payload, options.confidence ?? {}),
      );

      payload = outcome.payload;
      needsReview = outcome.needsReview;

      const key = idempotencyKey(credentials.tenant, payload);
      const jobLogger = logger.child({ idempotencyKey: shortKey(key) });

      jobLogger.info(
        {
          step: "validate",
          fields: summarizePayload(payload as Record<string, unknown>),
          minConfidence: outcome.minConfidence,
          lowConfidenceFields: outcome.lowConfidenceFields,
        },
        "Payload validated",
      );

      // ── 2. Local idempotency: have we seen this exact payload? ──────────
      const enqueued = this.store.enqueue({
        tenant: credentials.tenant,
        idempotencyKey: key,
        payload: payload as Record<string, unknown>,
        confidence: toConfidenceMap(outcome.fields),
        minConfidence: outcome.minConfidence,
      });
      job = enqueued.job;

      if (options.resumeJobId && options.resumeJobId !== job.id) {
        job = this.store.get(options.resumeJobId) ?? job;
      }

      metrics.jobStarted();

      const duplicate = this.checkLocalDuplicate(job, enqueued.created, logger);
      if (duplicate) {
        metrics.jobSkippedDuplicate(job.state);
        return this.finish(runId, job, metrics, logger, artifactDir, true);
      }

      // ── 3. Confidence gate ──────────────────────────────────────────────
      // Low confidence is not an error; it is a question for a person. Route it
      // to review *before* the write, never after.
      if (needsReview && job.state === "queued" && !options.resumeJobId) {
        job = this.store.transition(job.id, "running", { runId, reason: "run started" });
        job = this.store.transition(job.id, "awaiting_review", {
          runId,
          reason: `fields below the ${outcome.threshold} confidence threshold: ${outcome.lowConfidenceFields.join(", ")}`,
        });
        logger.info(
          { jobId: job.id, step: "review.route", lowConfidenceFields: outcome.lowConfidenceFields },
          "Routed to the review queue instead of writing",
        );
        metrics.jobAwaitingReview();
        return this.finish(runId, job, metrics, logger, artifactDir, false);
      }
    } catch (error) {
      const harnessError =
        error instanceof ValidationError ? error : classifyUnknownError("validate", error);
      logger.error(
        { step: "validate", category: harnessError.category, error: harnessError.message },
        "Validation failed",
      );
      metrics.jobFailed(harnessError.category, "failed");
      const snapshot = metrics.persist(logger);
      throw Object.assign(harnessError, { runId, metrics: snapshot });
    }

    // ── 4. Browser work ───────────────────────────────────────────────────
    return this.executeWithBrowser({
      runId,
      job,
      payload,
      credentials,
      logger,
      metrics,
      artifactDir,
      selectorOverrides: options.selectorOverrides,
    });
  }

  /**
   * Local duplicate check.
   *
   * A job that already reached `confirmed` must never be written again. A job
   * sitting in `submitted` is the ambiguous case: the write may have landed, so
   * it goes to a human rather than being repeated.
   */
  private checkLocalDuplicate(job: JobRecord, created: boolean, logger: Logger): boolean {
    if (created) return false;

    if (job.state === "confirmed") {
      logger.info(
        { jobId: job.id, step: "idempotency.local", resultRef: job.resultRef },
        "Duplicate blocked: this idempotency key is already confirmed",
      );
      return true;
    }

    if (job.state === "submitted") {
      logger.warn(
        { jobId: job.id, step: "idempotency.local" },
        "This key was already submitted with an unread outcome; reconciling rather than rewriting",
      );
      return false; // handled by the reconciliation path below
    }

    if (job.state === "awaiting_review" || job.state === "dead_letter") {
      logger.info(
        { jobId: job.id, step: "idempotency.local", state: job.state },
        "Job is waiting on a human; not resubmitting",
      );
      return true;
    }

    return false;
  }

  private async executeWithBrowser(context: {
    runId: string;
    job: JobRecord;
    payload: LeadPayload;
    credentials: Credentials;
    logger: Logger;
    metrics: RunMetrics;
    artifactDir: string;
    selectorOverrides?: Record<string, string>;
  }): Promise<RunResult> {
    const { runId, payload, credentials, logger, metrics } = context;
    let job = context.job;

    const jobLogger = logger.child({ jobId: job.id });
    const jobArtifactDir = ensureArtifactDir(runId, job.id);

    let browser: Browser | undefined;
    let session: SessionHandle | undefined;

    try {
      browser = await chromium.launch({ headless: config.headless });

      session = await metrics.time("session", async () =>
        openSession(browser as Browser, credentials, { logger: jobLogger }),
      );
      metrics.recordSessionReuse(session.reusedSession);

      // Tracing covers everything after the session is established, which is
      // where the interesting failures live. Under the Playwright test runner
      // the context may already be traced by the runner's own artifacts mode;
      // that is fine, we just must not start a second trace on it.
      session.traceOwned = await startTracing(session, jobLogger);

      const leads = new LeadsPage(session.page);
      const applyOverrides = context.selectorOverrides;

      // ── 4a. Recover a job that was already submitted ────────────────────
      if (job.state === "submitted") {
        return await this.reconcileSubmitted({
          runId,
          job,
          payload,
          leads,
          logger: jobLogger,
          metrics,
          session,
          artifactDir: jobArtifactDir,
        });
      }

      if (job.state === "queued") {
        job = this.store.transition(job.id, "running", {
          runId,
          reason: "browser work started",
          incrementAttempts: true,
          artifactDir: jobArtifactDir,
        });
      }

      // ── 4b. Navigate and check the CRM for an existing record ───────────
      await metrics.time("open-leads", async () =>
        withRetry(() => leads.open(), { step: "open-leads", safeToRepeat: true, logger: jobLogger }),
      );

      const existing = await metrics.time("idempotency.remote", async () =>
        withRetry(() => leads.findExistingLead(payload.full_name), {
          step: "idempotency.remote",
          safeToRepeat: true,
          logger: jobLogger,
        }),
      );

      if (existing) {
        jobLogger.info(
          { step: "idempotency.remote", resultRef: existing.id },
          "Duplicate blocked: the CRM already holds a matching record",
        );
        job = this.store.transition(job.id, "confirmed", {
          runId,
          reason: "matching record already present in the CRM",
          resultRef: existing.id,
          artifactDir: jobArtifactDir,
        });
        await captureEvidence(session.page, {
          runId,
          jobId: job.id,
          step: "idempotency.remote",
          label: "duplicate-detected",
          logger: jobLogger,
          extra: { resultRef: existing.id },
        });
        metrics.jobSkippedDuplicate("confirmed");
        return await this.finishWithSession(
          runId, job, metrics, jobLogger, jobArtifactDir, true, session,
        );
      }

      // ── 4c. Fill the form. Still fully reversible up to the submit. ─────
      await metrics.time("open-dialog", async () =>
        withRetry(() => leads.openCreateDialog(), {
          step: "open-dialog",
          safeToRepeat: true,
          logger: jobLogger,
        }),
      );

      await metrics.time("fill-form", async () => {
        if (applyOverrides?.["lead-full-name"]) {
          // Test hook for the deliberate selector-break case: look for a testid
          // the CRM does not have, on a page that loaded perfectly.
          const brokenPage = new LeadsPage(session!.page, "fill-form");
          await (brokenPage as unknown as {
            requireTestId: (id: string) => Promise<unknown>;
          }).requireTestId(applyOverrides["lead-full-name"]);
        }
        await leads.fillLeadForm(payload);
      });

      // ── 4d. The write. One attempt, ever. ───────────────────────────────
      // Recorded as `submitted` *before* the click, so a crash during the click
      // still leaves a durable marker for the next run to reconcile against.
      job = this.store.transition(job.id, "submitted", {
        runId,
        reason: "about to submit the create-lead form",
        markSubmitted: true,
        artifactDir: jobArtifactDir,
      });

      const write = await metrics.time("write", async () =>
        withRetry(() => leads.submitLead(payload.full_name), {
          step: "write",
          safeToRepeat: false, // never, under any circumstances
          logger: jobLogger,
        }),
      );

      job = this.store.transition(job.id, "confirmed", {
        runId,
        reason: "confirmation read from the CRM",
        resultRef: write.leadId,
        artifactDir: jobArtifactDir,
      });

      // Proof of the irreversible action.
      await captureEvidence(session.page, {
        runId,
        jobId: job.id,
        step: "write",
        label: "success-confirmation",
        logger: jobLogger,
        extra: { resultRef: write.leadId },
      });

      jobLogger.info(
        { step: "write", resultRef: write.leadId },
        "Lead created and confirmed",
      );
      metrics.jobSucceeded("confirmed");

      return await this.finishWithSession(
        runId, job, metrics, jobLogger, jobArtifactDir, false, session,
      );
    } catch (error) {
      const harnessError = classifyUnknownError("run", error);

      // AMBIGUOUS_WRITE is the one failure that must not become `failed`: the
      // side effect may have happened, so it goes to a human queue.
      const nextState = harnessError.category === "AMBIGUOUS_WRITE" ? "dead_letter" : "failed";

      // A session that never opened still leaves its page attached to the error.
      const failedPage =
        session?.page ?? ((error as { page?: import("@playwright/test").Page }).page ?? null);

      await captureEvidence(failedPage, {
        runId,
        jobId: job.id,
        step: harnessError.step,
        label: `failure-${harnessError.category.toLowerCase()}`,
        logger: jobLogger,
        extra: {
          category: harnessError.category,
          message: harnessError.message,
          details: harnessError.details,
        },
      });

      job = this.safeTransition(job, nextState, {
        runId,
        reason: harnessError.message,
        failureCategory: harnessError.category,
        failureMessage: harnessError.message,
        artifactDir: jobArtifactDir,
      });

      jobLogger.error(
        {
          step: harnessError.step,
          category: harnessError.category,
          state: job.state,
          error: harnessError.message,
        },
        harnessError.category === "AMBIGUOUS_WRITE"
          ? "Write outcome unknown — escalated for human review, not retried"
          : "Job failed",
      );

      metrics.jobFailed(harnessError.category, job.state);

      const result = await this.finishWithSession(
        runId, job, metrics, jobLogger, jobArtifactDir, false, session,
      );
      throw Object.assign(harnessError, { runId, job: result.job, metrics: result.metrics });
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  /**
   * A job found in `submitted` at the start of a run: the previous attempt
   * clicked submit and never recorded what happened. Look, do not rewrite.
   */
  private async reconcileSubmitted(context: {
    runId: string;
    job: JobRecord;
    payload: LeadPayload;
    leads: LeadsPage;
    logger: Logger;
    metrics: RunMetrics;
    session: SessionHandle;
    artifactDir: string;
  }): Promise<RunResult> {
    const { runId, payload, leads, logger, metrics, session, artifactDir } = context;
    let job = context.job;

    logger.warn(
      { step: "reconcile" },
      "Job was left in `submitted`; checking the CRM for the record instead of rewriting",
    );

    const found = await metrics.time("reconcile", async () =>
      withRetry(() => leads.reconcile(payload.full_name), {
        step: "reconcile",
        safeToRepeat: true,
        logger,
      }),
    );

    if (found) {
      job = this.store.transition(job.id, "confirmed", {
        runId,
        reason: "reconciled: the record exists in the CRM",
        resultRef: found.id,
        artifactDir,
      });
      await captureEvidence(session.page, {
        runId,
        jobId: job.id,
        step: "reconcile",
        label: "reconciled-confirmation",
        logger,
        extra: { resultRef: found.id },
      });
      logger.info({ step: "reconcile", resultRef: found.id }, "Reconciled to confirmed");
      metrics.jobSkippedDuplicate("confirmed");
      return this.finishWithSession(runId, job, metrics, logger, artifactDir, true, session);
    }

    // No record found — but "not found" is not proof it was never written: the
    // search itself could be lying to us. A human decides.
    job = this.store.transition(job.id, "dead_letter", {
      runId,
      reason: "reconciliation found no matching record; a human must confirm before any rewrite",
      failureCategory: "AMBIGUOUS_WRITE",
      failureMessage: "Submitted previously, no matching record found on reconciliation",
      artifactDir,
    });
    await captureEvidence(session.page, {
      runId,
      jobId: job.id,
      step: "reconcile",
      label: "reconcile-not-found",
      logger,
    });
    logger.error({ step: "reconcile" }, "Could not reconcile — escalated to dead_letter");
    metrics.jobFailed("AMBIGUOUS_WRITE", "dead_letter");
    return this.finishWithSession(runId, job, metrics, logger, artifactDir, false, session);
  }

  /** Transition, tolerating an illegal move so error handling never masks the error. */
  private safeTransition(
    job: JobRecord,
    to: Parameters<JobStore["transition"]>[1],
    options: Parameters<JobStore["transition"]>[2],
  ): JobRecord {
    try {
      return this.store.transition(job.id, to, options);
    } catch {
      return this.store.get(job.id) ?? job;
    }
  }

  private async finishWithSession(
    runId: string,
    job: JobRecord,
    metrics: RunMetrics,
    logger: Logger,
    artifactDir: string,
    skippedDuplicate: boolean,
    session: SessionHandle | undefined,
  ): Promise<RunResult> {
    if (session) {
      // Only stop the trace if we started it — otherwise the Playwright test
      // runner's own trace would be cut short and its attachment lost.
      if (session.traceOwned) {
        await saveTrace(session.context, runId, job.id, logger);
      }
      await session.close();
    }
    return this.finish(runId, job, metrics, logger, artifactDir, skippedDuplicate);
  }

  private finish(
    runId: string,
    job: JobRecord,
    metrics: RunMetrics,
    logger: Logger,
    artifactDir: string,
    skippedDuplicate: boolean,
  ): RunResult {
    const snapshot = metrics.persist(logger);
    logger.info({ step: "run.end", state: job.state }, "Run finished");
    return { runId, job, metrics: snapshot, skippedDuplicate, artifactDir };
  }
}
