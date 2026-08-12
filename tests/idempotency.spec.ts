import { expect, test } from "@playwright/test";

import { createLogger } from "../src/evidence/logger.js";
import { idempotencyKey } from "../src/jobs/idempotency.js";
import { JobRunner } from "../src/jobs/runner.js";
import { loadCredentials } from "../src/config/index.js";
import { freshStore, leadPayload } from "./helpers.js";

/**
 * Exactly one write per idempotency key — the acceptance criterion this whole
 * package exists to satisfy.
 */
test.describe.configure({ mode: "serial" });

test.describe("idempotency", () => {
  test("running the same input twice performs exactly one write", async () => {
    const store = freshStore("duplicate");
    const payload = leadPayload();

    const first = new JobRunner(store);
    let firstResult;
    try {
      firstResult = await first.run({
        payload,
        logger: createLogger({ runId: "test-duplicate-1" }),
      });
    } finally {
      first.close();
    }

    expect(firstResult.job.state).toBe("confirmed");
    expect(firstResult.skippedDuplicate).toBe(false);
    const recordId = firstResult.job.resultRef;
    expect(recordId).toBeTruthy();

    // Same payload, same store: the local key check should stop it dead.
    const second = new JobRunner(store);
    let secondResult;
    try {
      secondResult = await second.run({
        payload,
        logger: createLogger({ runId: "test-duplicate-2" }),
      });
    } finally {
      second.close();
    }

    expect(secondResult.skippedDuplicate).toBe(true);
    expect(secondResult.job.id).toBe(firstResult.job.id);
    expect(secondResult.job.state).toBe("confirmed");
    expect(secondResult.job.resultRef).toBe(recordId);

    // And no second job row was created for the key.
    const jobs = store.list();
    const matching = jobs.filter((job) => job.idempotencyKey === firstResult.job.idempotencyKey);
    expect(matching).toHaveLength(1);

    store.close();
  });

  test("a fresh database still refuses to duplicate, because the CRM is checked too", async () => {
    // This is the case a local database cannot cover on its own: the record
    // exists in the CRM, but this install has never seen it.
    const store = freshStore("remote-dupe-a");
    const payload = leadPayload();

    const first = new JobRunner(store);
    try {
      const result = await first.run({
        payload,
        logger: createLogger({ runId: "test-remote-dupe-1" }),
      });
      expect(result.job.state).toBe("confirmed");
    } finally {
      first.close();
      store.close();
    }

    // A brand-new store: no memory of the write above.
    const cleanStore = freshStore("remote-dupe-b");
    const second = new JobRunner(cleanStore);
    try {
      const result = await second.run({
        payload,
        logger: createLogger({ runId: "test-remote-dupe-2" }),
      });

      expect(result.skippedDuplicate).toBe(true);
      expect(result.job.state).toBe("confirmed");
      // Resolved by looking the record up in the CRM, not from local state.
      expect(result.job.resultRef).toBeTruthy();
    } finally {
      second.close();
      cleanStore.close();
    }
  });

  test("the key is stable across key order and incidental whitespace", () => {
    const a = idempotencyKey("acme", { full_name: "Ada Lovelace", email: "ada@example.com" });
    const b = idempotencyKey("acme", { email: " ADA@example.com ", full_name: "  Ada   Lovelace " });
    expect(a).toBe(b);
  });

  test("the key is scoped to the tenant", () => {
    const payload = { full_name: "Ada Lovelace" };
    expect(idempotencyKey("acme", payload)).not.toBe(idempotencyKey("globex", payload));
  });

  test("a restart after a crash mid-write reconciles instead of writing again", async () => {
    // The crash window: the job was durably marked `submitted`, the click went
    // out, and the process died before the confirmation could be read. On
    // restart the harness must look, not rewrite.
    const payload = leadPayload();
    const tenant = loadCredentials().tenant;
    const key = idempotencyKey(tenant, payload);

    // A first run creates the record for real.
    const store = freshStore("crash-recovery");
    const first = new JobRunner(store);
    let recordId: string | null;
    try {
      const result = await first.run({
        payload,
        logger: createLogger({ runId: "test-crash-1" }),
      });
      expect(result.job.state).toBe("confirmed");
      recordId = result.job.resultRef;
      expect(recordId).toBeTruthy();
    } finally {
      first.close();
      store.close();
    }

    // A separate store standing in for the killed process: its job row is stuck
    // in `submitted`, which is exactly what the durable pre-click write leaves.
    const crashedStore = freshStore("crash-recovery-restart");
    const { job } = crashedStore.enqueue({ tenant, idempotencyKey: key, payload });
    crashedStore.transition(job.id, "running", { reason: "test: pre-crash" });
    crashedStore.transition(job.id, "submitted", {
      reason: "test: crashed immediately after submitting",
      markSubmitted: true,
    });
    expect(crashedStore.get(job.id)?.state).toBe("submitted");

    const restarted = new JobRunner(crashedStore);
    try {
      const result = await restarted.run({
        payload,
        logger: createLogger({ runId: "test-crash-2" }),
      });

      // Reconciled to the record that already exists — no second write.
      expect(result.job.state).toBe("confirmed");
      expect(result.job.resultRef).toBe(recordId);
      expect(result.skippedDuplicate).toBe(true);

      const states = crashedStore.history(job.id).map((t) => t.toState);
      expect(states).toEqual(["queued", "running", "submitted", "confirmed"]);
      // Crucially, the job never re-entered the state that performs the write.
      expect(states.filter((s) => s === "submitted")).toHaveLength(1);
    } finally {
      restarted.close();
      crashedStore.close();
    }
  });

  test("a submitted job with no matching record escalates to dead_letter, never a retry", async () => {
    // The genuinely ambiguous case: marked submitted, but nothing can be found.
    // "Not found" is not proof it was never written, so a human decides.
    const payload = leadPayload();
    const tenant = loadCredentials().tenant;

    const store = freshStore("unreconcilable");
    const { job } = store.enqueue({
      tenant,
      idempotencyKey: idempotencyKey(tenant, payload),
      payload,
    });
    store.transition(job.id, "running", { reason: "test: pre-crash" });
    store.transition(job.id, "submitted", { reason: "test: crashed", markSubmitted: true });

    const runner = new JobRunner(store);
    try {
      const result = await runner.run({
        payload,
        logger: createLogger({ runId: "test-unreconcilable" }),
      });

      expect(result.job.state).toBe("dead_letter");
      expect(result.job.failureCategory).toBe("AMBIGUOUS_WRITE");
      expect(result.job.resultRef).toBeNull();
    } finally {
      runner.close();
      store.close();
    }
  });
});
