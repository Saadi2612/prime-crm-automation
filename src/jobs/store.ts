import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config/index.js";
import type { FailureCategory } from "./errors.js";
import { assertTransition, type JobState } from "./state-machine.js";

/**
 * Job persistence.
 *
 * SQLite rather than memory because the harness must survive being killed. The
 * whole point of persisting `submitted` is that a crash between the click and
 * the confirmation is recoverable, and that is only true if the state hit the
 * disk before the click did.
 *
 * Writes use WAL and synchronous=FULL: the state transition must be durable
 * before the browser action it describes, not batched behind it.
 */

export interface JobRecord {
  id: string;
  tenant: string;
  idempotencyKey: string;
  state: JobState;
  payload: Record<string, unknown>;
  confidence: Record<string, number>;
  minConfidence: number;
  attempts: number;
  runId: string | null;
  resultRef: string | null;
  failureCategory: FailureCategory | null;
  failureMessage: string | null;
  artifactDir: string | null;
  reviewNote: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  tenant: string;
  idempotency_key: string;
  state: string;
  payload: string;
  confidence: string;
  min_confidence: number;
  attempts: number;
  run_id: string | null;
  result_ref: string | null;
  failure_category: string | null;
  failure_message: string | null;
  artifact_dir: string | null;
  review_note: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransitionRecord {
  id: number;
  jobId: string;
  fromState: string | null;
  toState: string;
  reason: string | null;
  runId: string | null;
  createdAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  tenant            TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  state             TEXT NOT NULL,
  payload           TEXT NOT NULL,
  confidence        TEXT NOT NULL DEFAULT '{}',
  min_confidence    REAL NOT NULL DEFAULT 1.0,
  attempts          INTEGER NOT NULL DEFAULT 0,
  run_id            TEXT,
  result_ref        TEXT,
  failure_category  TEXT,
  failure_message   TEXT,
  artifact_dir      TEXT,
  review_note       TEXT,
  submitted_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- One live job per (tenant, key). This is the database-level guarantee behind
-- "exactly one write": a second enqueue of the same payload cannot create a
-- second row, whatever the calling code does.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_key_unique
  ON jobs (tenant, idempotency_key);

CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs (state);

CREATE TABLE IF NOT EXISTS job_transitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  reason      TEXT,
  run_id      TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS job_transitions_job_idx ON job_transitions (job_id);
`;

function nowIso(): string {
  return new Date().toISOString();
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    tenant: row.tenant,
    idempotencyKey: row.idempotency_key,
    state: row.state as JobState,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    confidence: JSON.parse(row.confidence) as Record<string, number>,
    minConfidence: row.min_confidence,
    attempts: row.attempts,
    runId: row.run_id,
    resultRef: row.result_ref,
    failureCategory: row.failure_category as FailureCategory | null,
    failureMessage: row.failure_message,
    artifactDir: row.artifact_dir,
    reviewNote: row.review_note,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface EnqueueInput {
  tenant: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  confidence?: Record<string, number>;
  minConfidence?: number;
}

export class JobStore {
  private readonly db: Database.Database;

  constructor(dbPath?: string) {
    const file = dbPath ?? path.join(config.stateDir, "jobs.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });

    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    // The durability of a state transition is the whole safety argument here,
    // so correctness beats throughput.
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Create a job, or return the existing one for this (tenant, key).
   *
   * This is the first of the two idempotency checks. The second — asking the
   * CRM itself whether a matching record already exists — happens in the runner,
   * because a local database cannot know about writes made by anything else.
   */
  enqueue(input: EnqueueInput): { job: JobRecord; created: boolean } {
    const existing = this.findByKey(input.tenant, input.idempotencyKey);
    if (existing) return { job: existing, created: false };

    const timestamp = nowIso();
    const job: JobRow = {
      id: randomUUID(),
      tenant: input.tenant,
      idempotency_key: input.idempotencyKey,
      state: "queued",
      payload: JSON.stringify(input.payload),
      confidence: JSON.stringify(input.confidence ?? {}),
      min_confidence: input.minConfidence ?? 1,
      attempts: 0,
      run_id: null,
      result_ref: null,
      failure_category: null,
      failure_message: null,
      artifact_dir: null,
      review_note: null,
      submitted_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    this.db
      .prepare(
        `INSERT INTO jobs (id, tenant, idempotency_key, state, payload, confidence, min_confidence,
                           attempts, run_id, result_ref, failure_category, failure_message,
                           artifact_dir, review_note, submitted_at, created_at, updated_at)
         VALUES (@id, @tenant, @idempotency_key, @state, @payload, @confidence, @min_confidence,
                 @attempts, @run_id, @result_ref, @failure_category, @failure_message,
                 @artifact_dir, @review_note, @submitted_at, @created_at, @updated_at)`,
      )
      .run(job);

    this.recordTransition(job.id, null, "queued", "enqueued", null);
    return { job: toRecord(job), created: true };
  }

  findByKey(tenant: string, idempotencyKey: string): JobRecord | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE tenant = ? AND idempotency_key = ?")
      .get(tenant, idempotencyKey) as JobRow | undefined;
    return row ? toRecord(row) : null;
  }

  get(id: string): JobRecord | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(state?: JobState): JobRecord[] {
    const rows = state
      ? (this.db
          .prepare("SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC")
          .all(state) as JobRow[])
      : (this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as JobRow[]);
    return rows.map(toRecord);
  }

  /**
   * Move a job to a new state, refusing transitions the machine forbids and
   * writing an audit row. Guarded by a transaction so the job row and its
   * history can never disagree.
   */
  transition(
    id: string,
    to: JobState,
    options: {
      reason?: string;
      runId?: string | null;
      resultRef?: string | null;
      failureCategory?: FailureCategory | null;
      failureMessage?: string | null;
      artifactDir?: string | null;
      reviewNote?: string | null;
      payload?: Record<string, unknown>;
      incrementAttempts?: boolean;
      markSubmitted?: boolean;
    } = {},
  ): JobRecord {
    const apply = this.db.transaction((): JobRecord => {
      const current = this.get(id);
      if (!current) throw new Error(`Job ${id} not found`);

      assertTransition(current.state, to);

      const updated = {
        id,
        state: to,
        run_id: options.runId !== undefined ? options.runId : current.runId,
        result_ref: options.resultRef !== undefined ? options.resultRef : current.resultRef,
        failure_category:
          options.failureCategory !== undefined ? options.failureCategory : current.failureCategory,
        failure_message:
          options.failureMessage !== undefined ? options.failureMessage : current.failureMessage,
        artifact_dir: options.artifactDir !== undefined ? options.artifactDir : current.artifactDir,
        review_note: options.reviewNote !== undefined ? options.reviewNote : current.reviewNote,
        payload: options.payload ? JSON.stringify(options.payload) : JSON.stringify(current.payload),
        attempts: current.attempts + (options.incrementAttempts ? 1 : 0),
        submitted_at: options.markSubmitted ? nowIso() : current.submittedAt,
        updated_at: nowIso(),
      };

      this.db
        .prepare(
          `UPDATE jobs SET state = @state, run_id = @run_id, result_ref = @result_ref,
                           failure_category = @failure_category, failure_message = @failure_message,
                           artifact_dir = @artifact_dir, review_note = @review_note,
                           payload = @payload, attempts = @attempts, submitted_at = @submitted_at,
                           updated_at = @updated_at
           WHERE id = @id`,
        )
        .run(updated);

      this.recordTransition(id, current.state, to, options.reason ?? null, options.runId ?? null);

      const after = this.get(id);
      if (!after) throw new Error(`Job ${id} vanished mid-transition`);
      return after;
    });

    return apply();
  }

  /** Overwrite the payload after a human edited it in the review queue. */
  updatePayload(id: string, payload: Record<string, unknown>): void {
    this.db
      .prepare("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(payload), nowIso(), id);
  }

  history(jobId: string): TransitionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM job_transitions WHERE job_id = ? ORDER BY id ASC")
      .all(jobId) as Array<{
      id: number;
      job_id: string;
      from_state: string | null;
      to_state: string;
      reason: string | null;
      run_id: string | null;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      fromState: row.from_state,
      toState: row.to_state,
      reason: row.reason,
      runId: row.run_id,
      createdAt: row.created_at,
    }));
  }

  private recordTransition(
    jobId: string,
    from: JobState | null,
    to: JobState,
    reason: string | null,
    runId: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO job_transitions (job_id, from_state, to_state, reason, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(jobId, from, to, reason, runId, nowIso());
  }
}
