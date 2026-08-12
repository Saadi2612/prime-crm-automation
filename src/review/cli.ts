import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { loadCredentials } from "../config/index.js";
import { createLogger } from "../evidence/logger.js";
import { maskForDisplay } from "../evidence/redact.js";
import { idempotencyKey, shortKey } from "../jobs/idempotency.js";
import { JobRunner } from "../jobs/runner.js";
import { JobStore, type JobRecord } from "../jobs/store.js";

/**
 * Human review queue.
 *
 * A CLI rather than a page in the CRM, on purpose: job state lives in this
 * package's SQLite database, and a review screen inside the CRM would mean the
 * CRM reading the harness's state — exactly the coupling the browser-only
 * boundary exists to prevent.
 *
 * Approving does not perform the write here. It puts the job back on the queue
 * with **the same idempotency key**, and the runner writes it. That way the
 * approved path and the automatic path go through identical duplicate checks.
 */

function formatValue(field: string, value: unknown): string {
  if (value == null || value === "") return "(empty)";
  const text = String(value);
  // Contact details are shown masked. The reviewer is checking whether the
  // extraction is plausible, which a masked value still supports.
  if (/email|phone/i.test(field)) return maskForDisplay(text);
  return text;
}

function printJob(job: JobRecord): void {
  const payload = job.payload as Record<string, unknown>;
  const confidence = job.confidence;

  stdout.write(`\n${"─".repeat(72)}\n`);
  stdout.write(`Job          ${job.id}\n`);
  stdout.write(`Tenant       ${job.tenant}\n`);
  stdout.write(`Key          ${shortKey(job.idempotencyKey)}\n`);
  stdout.write(`State        ${job.state}\n`);
  stdout.write(`Created      ${job.createdAt}\n`);
  if (job.failureCategory) {
    stdout.write(`Failure      ${job.failureCategory}: ${job.failureMessage ?? ""}\n`);
  }
  if (job.artifactDir) {
    stdout.write(`Evidence     ${job.artifactDir}\n`);
    stdout.write(`             (screenshots and page HTML for this job)\n`);
  }

  stdout.write(`\nExtracted values\n`);
  for (const [field, value] of Object.entries(payload)) {
    const score = confidence[field];
    const flag = score != null && score < 0.8 ? "  ⚠ low" : "";
    const scoreText = score != null ? score.toFixed(2) : "1.00";
    stdout.write(`  ${field.padEnd(14)} ${formatValue(field, value).padEnd(28)} ${scoreText}${flag}\n`);
  }
  stdout.write(`${"─".repeat(72)}\n`);
}

async function editPayload(
  rl: readline.Interface,
  job: JobRecord,
): Promise<Record<string, unknown>> {
  const payload = { ...(job.payload as Record<string, unknown>) };

  stdout.write("\nEdit fields. Press enter to keep the current value.\n");
  for (const field of Object.keys(payload)) {
    const answer = await rl.question(`  ${field} [${String(payload[field] ?? "")}]: `);
    if (answer.trim() !== "") {
      const numeric = /budget/i.test(field) ? Number(answer.trim()) : NaN;
      payload[field] = Number.isNaN(numeric) ? answer.trim() : numeric;
    }
  }

  return payload;
}

export async function runReviewQueue(options: { jobId?: string } = {}): Promise<number> {
  const store = new JobStore();
  const logger = createLogger({ runId: "review-cli" });

  try {
    const pending = options.jobId
      ? [store.get(options.jobId)].filter((job): job is JobRecord => job !== null)
      : [...store.list("awaiting_review"), ...store.list("dead_letter")];

    if (pending.length === 0) {
      stdout.write("Nothing is waiting for review.\n");
      return 0;
    }

    const rl = readline.createInterface({ input: stdin, output: stdout });

    try {
      for (const job of pending) {
        printJob(job);

        if (job.state === "dead_letter") {
          stdout.write(
            "\n⚠  This job was SUBMITTED but its outcome could not be confirmed.\n" +
              "   Check the CRM before approving — approving will attempt the write again.\n",
          );
        }

        const action = (
          await rl.question("\n[a]pprove  [e]dit and approve  [r]eject  [s]kip  [q]uit: ")
        )
          .trim()
          .toLowerCase();

        if (action === "q") break;
        if (action === "s" || action === "") continue;

        if (action === "r") {
          const note = await rl.question("Reason for rejection: ");
          store.transition(job.id, "failed", {
            reason: "rejected in review",
            reviewNote: note.trim() || "rejected by reviewer",
            failureCategory: "VALIDATION",
            failureMessage: "Rejected by a human reviewer",
          });
          stdout.write(`Job ${job.id} rejected.\n`);
          continue;
        }

        if (action === "a" || action === "e") {
          let payload = job.payload as Record<string, unknown>;

          if (action === "e") {
            payload = await editPayload(rl, job);
            store.updatePayload(job.id, payload);

            // An edited payload is a different payload, so the key changes. Say
            // so out loud — the reviewer is choosing to allow a distinct write.
            const credentials = loadCredentials();
            const newKey = idempotencyKey(credentials.tenant, payload);
            if (newKey !== job.idempotencyKey) {
              stdout.write(
                `\nNote: the edit changes the idempotency key ` +
                  `(${shortKey(job.idempotencyKey)} → ${shortKey(newKey)}).\n` +
                  `This will be treated as a new record.\n`,
              );
            }
          }

          store.transition(job.id, "queued", {
            reason: action === "e" ? "approved with edits" : "approved in review",
            reviewNote: action === "e" ? "approved with edits" : "approved",
          });

          stdout.write("Approved. Running the write step…\n");

          const runner = new JobRunner(store);
          try {
            const result = await runner.run({
              payload,
              // The reviewer has vouched for these values, so the confidence
              // gate must not bounce the job straight back into the queue.
              confidence: {},
              resumeJobId: job.id,
              logger,
            });
            stdout.write(
              `Job ${result.job.id} → ${result.job.state}` +
                `${result.job.resultRef ? ` (record ${result.job.resultRef})` : ""}\n`,
            );
          } catch (error) {
            stdout.write(
              `Job did not complete: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          } finally {
            runner.close();
          }
        }
      }
    } finally {
      rl.close();
    }

    return 0;
  } finally {
    store.close();
  }
}

/** Non-interactive approval, used by the tests and by scripted operators. */
export async function approveJob(
  jobId: string,
  options: { payload?: Record<string, unknown> } = {},
): Promise<{ state: string; resultRef: string | null }> {
  const store = new JobStore();
  const logger = createLogger({ runId: "review-approve", jobId });

  try {
    const job = store.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const payload = options.payload ?? (job.payload as Record<string, unknown>);
    if (options.payload) store.updatePayload(jobId, payload);

    store.transition(jobId, "queued", { reason: "approved (non-interactive)", reviewNote: "approved" });

    const runner = new JobRunner(store);
    try {
      const result = await runner.run({ payload, confidence: {}, resumeJobId: jobId, logger });
      return { state: result.job.state, resultRef: result.job.resultRef };
    } finally {
      runner.close();
    }
  } finally {
    store.close();
  }
}
