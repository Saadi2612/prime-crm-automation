import { expect, test } from "@playwright/test";
import fs from "node:fs";

import { loadCredentials } from "../src/config/index.js";
import { createLogger } from "../src/evidence/logger.js";
import { JobRunner } from "../src/jobs/runner.js";
import { sessionPath } from "../src/session/storage.js";
import {
  clearStoredSession,
  freshStore,
  invalidateStoredSession,
  leadPayload,
} from "./helpers.js";

/**
 * Session lifecycle: fresh login with TOTP, reuse on the next run, and re-login
 * when the saved session no longer works.
 *
 * These run in order and share the on-disk session file on purpose — that file
 * is the thing under test.
 */
test.describe.configure({ mode: "serial" });

test.describe("session management", () => {
  test("logs in from scratch through the TOTP step", async () => {
    clearStoredSession();

    const store = freshStore("fresh-login");
    const runner = new JobRunner(store);

    try {
      const result = await runner.run({
        payload: leadPayload(),
        logger: createLogger({ runId: "test-fresh-login" }),
      });

      expect(result.job.state).toBe("confirmed");
      expect(result.metrics.sessionReused).toBe(false);
      expect(fs.existsSync(sessionPath(loadCredentials()))).toBe(true);
    } finally {
      runner.close();
      store.close();
    }
  });

  test("reuses the stored session on the next run", async () => {
    // Depends on the previous test having saved a session.
    expect(fs.existsSync(sessionPath(loadCredentials()))).toBe(true);

    const store = freshStore("session-reuse");
    const runner = new JobRunner(store);

    try {
      const result = await runner.run({
        payload: leadPayload(),
        logger: createLogger({ runId: "test-session-reuse" }),
      });

      expect(result.job.state).toBe("confirmed");
      expect(result.metrics.sessionReused).toBe(true);

      // Reuse must skip the login entirely, not just look like it did.
      const steps = result.metrics.steps.map((s) => s.step);
      expect(steps).toContain("session");
    } finally {
      runner.close();
      store.close();
    }
  });

  test("falls back to a full login when the stored session fails the probe", async () => {
    invalidateStoredSession();

    const store = freshStore("session-expired");
    const runner = new JobRunner(store);

    try {
      const result = await runner.run({
        payload: leadPayload(),
        logger: createLogger({ runId: "test-session-expired" }),
      });

      // The harness must not trust the file just because it exists.
      expect(result.metrics.sessionReused).toBe(false);
      expect(result.job.state).toBe("confirmed");
    } finally {
      runner.close();
      store.close();
    }
  });

  test("holds one session lock per credential set", async () => {
    const { acquireSessionLock, LockTimeoutError } = await import("../src/session/lock.js");
    const { credentialKey } = await import("../src/config/index.js");

    const key = credentialKey(loadCredentials());
    const first = await acquireSessionLock(key);

    try {
      await expect(
        acquireSessionLock(key, { timeoutMs: 1_000, pollIntervalMs: 100 }),
      ).rejects.toBeInstanceOf(LockTimeoutError);
    } finally {
      first.release();
    }

    // Released locks are immediately reusable.
    const second = await acquireSessionLock(key, { timeoutMs: 2_000 });
    second.release();
  });
});
