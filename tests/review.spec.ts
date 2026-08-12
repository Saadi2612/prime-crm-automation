import { expect, test } from "@playwright/test";

import { createLogger } from "../src/evidence/logger.js";
import { idempotencyKey } from "../src/jobs/idempotency.js";
import { JobRunner } from "../src/jobs/runner.js";
import { loadCredentials } from "../src/config/index.js";
import { freshStore, leadPayload } from "./helpers.js";

/**
 * The confidence gate and the human queue.
 *
 * The property being protected: uncertain input never reaches the CRM
 * unreviewed, and approving it writes exactly once, under the original key.
 */
test.describe.configure({ mode: "serial" });

test.describe("review queue", () => {
  test("low-confidence input is routed to review instead of being written", async () => {
    const store = freshStore("low-confidence");
    const runner = new JobRunner(store);
    const payload = leadPayload();

    try {
      const result = await runner.run({
        payload,
        // Below the 0.8 threshold: plausible, but not trustworthy enough to act on.
        confidence: { full_name: 0.42, email: 0.95 },
        logger: createLogger({ runId: "test-low-confidence" }),
      });

      expect(result.job.state).toBe("awaiting_review");
      expect(result.job.resultRef).toBeNull();

      // Nothing was written, so no submission was ever recorded.
      expect(result.job.submittedAt).toBeNull();

      const history = store.history(result.job.id).map((t) => t.toState);
      expect(history).toEqual(["queued", "running", "awaiting_review"]);
      expect(history).not.toContain("submitted");
    } finally {
      runner.close();
      store.close();
    }
  });

  test("approving from the queue completes the write under the same key", async () => {
    const store = freshStore("approve");
    const payload = leadPayload();
    const expectedKey = idempotencyKey(loadCredentials().tenant, payload);

    const runner = new JobRunner(store);
    let queued;
    try {
      queued = await runner.run({
        payload,
        confidence: { full_name: 0.3 },
        logger: createLogger({ runId: "test-approve-1" }),
      });
      expect(queued.job.state).toBe("awaiting_review");
      expect(queued.job.idempotencyKey).toBe(expectedKey);
    } finally {
      runner.close();
    }

    // What the reviewer's "approve" does: back to queued, then run the write.
    store.transition(queued.job.id, "queued", { reason: "approved in test" });

    const resumeRunner = new JobRunner(store);
    try {
      const result = await resumeRunner.run({
        payload,
        confidence: {},
        resumeJobId: queued.job.id,
        logger: createLogger({ runId: "test-approve-2" }),
      });

      expect(result.job.id).toBe(queued.job.id);
      expect(result.job.state).toBe("confirmed");
      expect(result.job.resultRef).toBeTruthy();
      // The key must survive the round trip, or approval would create a second record.
      expect(result.job.idempotencyKey).toBe(expectedKey);
    } finally {
      resumeRunner.close();
      store.close();
    }
  });

  test("rejecting from the queue fails the job and writes nothing", async () => {
    const store = freshStore("reject");
    const runner = new JobRunner(store);

    try {
      const queued = await runner.run({
        payload: leadPayload(),
        confidence: { full_name: 0.1 },
        logger: createLogger({ runId: "test-reject" }),
      });

      store.transition(queued.job.id, "failed", {
        reason: "rejected in review",
        reviewNote: "test rejection",
        failureCategory: "VALIDATION",
      });

      const after = store.get(queued.job.id);
      expect(after?.state).toBe("failed");
      expect(after?.resultRef).toBeNull();
      expect(after?.submittedAt).toBeNull();
    } finally {
      runner.close();
      store.close();
    }
  });

  test("a malformed payload fails outright rather than going to review", async () => {
    // Uncertainty is a question for a human; malformedness is not.
    const store = freshStore("malformed");
    const runner = new JobRunner(store);

    try {
      await expect(
        runner.run({
          payload: { full_name: "", email: "not-an-email" },
          logger: createLogger({ runId: "test-malformed" }),
        }),
      ).rejects.toMatchObject({ category: "VALIDATION" });
    } finally {
      runner.close();
      store.close();
    }
  });
});
