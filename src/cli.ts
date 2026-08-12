import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { createLogger } from "./evidence/logger.js";
import { shortKey } from "./jobs/idempotency.js";
import { JobRunner } from "./jobs/runner.js";
import { JobStore } from "./jobs/store.js";
import type { JobState } from "./jobs/state-machine.js";
import { runReviewQueue } from "./review/cli.js";
import { jobInputSchema } from "./validate/schema.js";

/**
 * Entry point.
 *
 *   run <input.json>   validate, dedupe, log in, create the lead
 *   review [jobId]     work the human queue
 *   list [state]       show jobs
 *
 * Exits non-zero on failure so this can gate a CI pipeline.
 */

const USAGE = `
prime-crm-automation

  npm run run:job -- <input.json>     Run one job from a JSON file
  npm run review                      Work the human review queue
  npm run jobs [state]                List jobs, optionally filtered by state

Input file format:
  {
    "payload":    { "full_name": "Ada Lovelace", "email": "ada@example.com" },
    "confidence": { "full_name": 0.99, "email": 0.62 }
  }
`;

async function commandRun(inputPath: string | undefined): Promise<number> {
  if (!inputPath) {
    process.stderr.write("A path to an input JSON file is required.\n" + USAGE);
    return 2;
  }

  if (!fs.existsSync(inputPath)) {
    process.stderr.write(`Input file not found: ${inputPath}\n`);
    return 2;
  }

  const parsed = jobInputSchema.safeParse(JSON.parse(fs.readFileSync(inputPath, "utf8")));
  if (!parsed.success) {
    process.stderr.write(`Malformed input file: ${parsed.error.message}\n`);
    return 2;
  }

  const runId = randomUUID();
  const logger = createLogger({ runId });
  const runner = new JobRunner();

  try {
    const result = await runner.run({
      payload: parsed.data.payload,
      confidence: parsed.data.confidence ?? {},
      runId,
      logger,
    });

    // A job parked for a human is not a success: CI should notice.
    if (result.job.state === "awaiting_review" || result.job.state === "dead_letter") {
      process.stderr.write(
        `Job ${result.job.id} needs human review (${result.job.state}). ` +
          `Run "npm run review".\n`,
      );
      return 1;
    }

    return result.job.state === "confirmed" ? 0 : 1;
  } catch (error) {
    logger.error({ step: "cli", error: error instanceof Error ? error.message : String(error) },
      "Run failed");
    return 1;
  } finally {
    runner.close();
  }
}

function commandList(state?: string): number {
  const store = new JobStore();
  try {
    const jobs = store.list(state as JobState | undefined);
    if (jobs.length === 0) {
      process.stdout.write("No jobs.\n");
      return 0;
    }

    process.stdout.write(
      `${"JOB".padEnd(38)}${"STATE".padEnd(18)}${"KEY".padEnd(14)}RECORD\n`,
    );
    for (const job of jobs) {
      process.stdout.write(
        `${job.id.padEnd(38)}${job.state.padEnd(18)}${shortKey(job.idempotencyKey).padEnd(14)}` +
          `${job.resultRef ?? "-"}\n`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

async function main(): Promise<number> {
  const [command, argument] = process.argv.slice(2);

  switch (command) {
    case "run":
      return commandRun(argument);
    case "review":
      return runReviewQueue({ jobId: argument });
    case "list":
      return commandList(argument);
    default:
      process.stdout.write(USAGE);
      return command ? 2 : 0;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
