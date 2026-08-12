/**
 * Job state machine.
 *
 *   queued ──▶ running ──┬──▶ submitted ──┬──▶ confirmed        (happy path)
 *      ▲                 │                └──▶ dead_letter      (submitted, confirmation unreadable)
 *      │                 ├──▶ awaiting_review ──▶ queued        (human approved; resumes at the write)
 *      │                 │                   └──▶ failed        (human rejected)
 *      └── retry ────────┴──▶ failed ──▶ dead_letter            (retries exhausted)
 *
 * The critical property: `submitted` is a real, persisted state, not a moment
 * inside a function. If the process dies between clicking submit and reading
 * the confirmation, the job is already recorded as `submitted` on disk, so the
 * restart finds it there and reconciles instead of writing again.
 */

export const JOB_STATES = [
  "queued",
  "running",
  "awaiting_review",
  "submitted",
  "confirmed",
  "failed",
  "dead_letter",
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** States from which no further automated work happens. */
export const TERMINAL_STATES: readonly JobState[] = ["confirmed", "failed", "dead_letter"];

/** States a human has to act on before the job can move. */
export const HUMAN_STATES: readonly JobState[] = ["awaiting_review", "dead_letter"];

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["running", "failed"],
  running: ["awaiting_review", "submitted", "confirmed", "failed", "queued"],
  // A submitted job has already caused a side effect. It can only be resolved
  // by observing the outcome — never by going back to `running` and retrying.
  submitted: ["confirmed", "dead_letter"],
  // Human decisions: approve puts it back in the queue (same idempotency key),
  // reject fails it outright.
  awaiting_review: ["queued", "failed", "dead_letter"],
  confirmed: [],
  failed: ["dead_letter", "queued"],
  dead_letter: ["confirmed", "failed"],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(from: JobState, to: JobState) {
    super(`Illegal job transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function needsHuman(state: JobState): boolean {
  return HUMAN_STATES.includes(state);
}
