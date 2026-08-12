import fs from "node:fs";
import path from "node:path";

import type { FailureCategory } from "../jobs/errors.js";
import type { JobState } from "../jobs/state-machine.js";
import { ensureArtifactDir } from "./capture.js";
import type { Logger } from "./logger.js";

/**
 * Per-run metrics.
 *
 * Deliberately counts outcomes by *category*, not just pass/fail. "Three
 * failures" tells an operator nothing; "three selector breaks" says the CRM's
 * UI changed and no amount of retrying will help, while "three timeouts" says
 * the environment is sick. Step durations are recorded for the same reason —
 * a login that has crept from 2s to 12s is a warning before it is an outage.
 */

export interface StepTiming {
  step: string;
  durationMs: number;
  ok: boolean;
}

export interface RunMetricsSnapshot {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  jobsTotal: number;
  jobsSucceeded: number;
  jobsFailed: number;
  jobsAwaitingReview: number;
  jobsSkippedDuplicate: number;
  successRate: number;
  failuresByCategory: Record<string, number>;
  finalStates: Record<string, number>;
  steps: StepTiming[];
  sessionReused: boolean | null;
}

export class RunMetrics {
  private readonly startedAt = Date.now();
  private readonly steps: StepTiming[] = [];
  private readonly failuresByCategory: Record<string, number> = {};
  private readonly finalStates: Record<string, number> = {};

  private jobsTotal = 0;
  private jobsSucceeded = 0;
  private jobsFailed = 0;
  private jobsAwaitingReview = 0;
  private jobsSkippedDuplicate = 0;
  private sessionReused: boolean | null = null;

  constructor(readonly runId: string) {}

  /** Time a step and record whether it succeeded, regardless of the outcome. */
  async time<T>(step: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.steps.push({ step, durationMs: Date.now() - start, ok: true });
      return result;
    } catch (error) {
      this.steps.push({ step, durationMs: Date.now() - start, ok: false });
      throw error;
    }
  }

  recordSessionReuse(reused: boolean): void {
    this.sessionReused = reused;
  }

  jobStarted(): void {
    this.jobsTotal += 1;
  }

  jobSucceeded(state: JobState = "confirmed"): void {
    this.jobsSucceeded += 1;
    this.countState(state);
  }

  jobFailed(category: FailureCategory | null, state: JobState): void {
    this.jobsFailed += 1;
    const key = category ?? "UNKNOWN";
    this.failuresByCategory[key] = (this.failuresByCategory[key] ?? 0) + 1;
    this.countState(state);
  }

  jobAwaitingReview(): void {
    this.jobsAwaitingReview += 1;
    this.countState("awaiting_review");
  }

  /** A duplicate that was blocked before any write. Not a failure — a save. */
  jobSkippedDuplicate(state: JobState): void {
    this.jobsSkippedDuplicate += 1;
    this.countState(state);
  }

  private countState(state: JobState): void {
    this.finalStates[state] = (this.finalStates[state] ?? 0) + 1;
  }

  snapshot(): RunMetricsSnapshot {
    const finishedAt = Date.now();
    const decided = this.jobsSucceeded + this.jobsFailed;
    return {
      runId: this.runId,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - this.startedAt,
      jobsTotal: this.jobsTotal,
      jobsSucceeded: this.jobsSucceeded,
      jobsFailed: this.jobsFailed,
      jobsAwaitingReview: this.jobsAwaitingReview,
      jobsSkippedDuplicate: this.jobsSkippedDuplicate,
      successRate: decided === 0 ? 1 : this.jobsSucceeded / decided,
      failuresByCategory: { ...this.failuresByCategory },
      finalStates: { ...this.finalStates },
      steps: [...this.steps],
      sessionReused: this.sessionReused,
    };
  }

  /** Write metrics.json next to the run's artifacts and log the summary line. */
  persist(logger: Logger): RunMetricsSnapshot {
    const snapshot = this.snapshot();
    const dir = ensureArtifactDir(this.runId);
    const file = path.join(dir, "metrics.json");

    try {
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");
    } catch (error) {
      logger.warn({ step: "metrics", error: String(error) }, "Could not write metrics.json");
    }

    logger.info({ step: "metrics", metrics: snapshot }, "Run metrics");
    return snapshot;
  }

  /** True when nothing failed — this is what drives the process exit code. */
  isClean(): boolean {
    return this.jobsFailed === 0;
  }
}
